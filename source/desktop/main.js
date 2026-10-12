'use strict';
/*
 * Falcon Time — desktop agent (macOS menu bar).
 *
 * What it does, in full view of the employee:
 *   - signs in with the same login + personal code as the web cabinet (POST /api/login);
 *   - after macOS "Screen Recording" permission is granted, captures the primary
 *     screen once immediately and then every 3 minutes, sending a ~q60 JPEG to the
 *     cabinet and nowhere else;
 *   - shows a menu-bar icon with the schedule, the time of the last frame, and
 *     Pause / Quit controls. Nothing is captured while paused or unpermitted.
 *
 * What it never does: no stealth or hidden windows, no TCC bypass, no keystroke,
 * clipboard or other-application capture.
 */
const {app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, systemPreferences, shell, desktopCapturer, screen, session} = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./lib/config');
const store = require('./lib/store');
const api = require('./lib/api');
const {capture} = require('./lib/capture');

let tray = null;
let loginWin = null;
let captureTimer = null;
let permissionTimer = null;
let flushing = false;
let quitting = false;

const stateView = {
  cabinet: config.DEFAULT_CABINET,
  loggedIn: false,
  personName: '',
  personId: '',
  paused: false,
  permission: 'unknown', // granted | denied | not-determined | unknown
  lastFrame: 0,
  queue: 0,
  offline: false,
  video: [],
};

function screenStatus() {
  if (process.platform !== 'darwin') return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
}

// ---- Auth ------------------------------------------------------------------

async function loginFlow(cabinet, id, code) {
  let res = await api.postJson(cabinet, '/api/login', {id, code});
  if (res.status === 401 && api.parse(res)?.signin) {
    // Hosted/dev cabinets gate on a platform session first; obtain it, then retry.
    await api.get(cabinet, '/signin-with-chatgpt?return_to=/').catch(() => {});
    res = await api.postJson(cabinet, '/api/login', {id, code});
  }
  if (res.status !== 200) throw new Error(api.parse(res)?.error || `Не удалось войти (${res.status})`);
  const me = await api.get(cabinet, '/api/me');
  const body = api.parse(me);
  if (me.status !== 200 || !body?.me) throw new Error(body?.error || 'Сессия не подтверждена');
  if (!body.me.onboarded) throw new Error('Сначала завершите настройку профиля, затем войдите снова.');
  store.writeState({cabinet, personId: body.me.id, personName: body.me.name});
  Object.assign(stateView, {cabinet, loggedIn: true, personId: body.me.id, personName: body.me.name});
  return body.me;
}

async function logout() {
  stopCapturing();
  stopOffice(true);
  await api.clearSession();
  const prev = store.readState();
  store.writeState({cabinet: prev.cabinet || config.DEFAULT_CABINET});
  Object.assign(stateView, {loggedIn: false, personId: '', personName: '', paused: false, lastFrame: 0});
  buildTray();
  openLogin();
}

// ---- Capture loop ----------------------------------------------------------

function start() {
  stopCapturing();
  stateView.loggedIn = true;
  buildTray();
  tick(); // first frame immediately
  captureTimer = setInterval(tick, config.INTERVAL_MS);
  startOffice();
}

function stopCapturing() {
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  if (permissionTimer) { clearInterval(permissionTimer); permissionTimer = null; }
}

async function tick() {
  // No capture while paused or without Screen Recording permission.
  if (stateView.paused) { buildTray(); return; }
  const status = screenStatus();
  stateView.permission = status;
  if (status !== 'granted') {
    buildTray();
    watchPermission();
    // macOS 15+ reports "denied" before the app has ever asked, so a prompt
    // never appears if capture runs only for "not-determined". One getSources
    // call is what registers Electron in Screen & System Audio Recording.
    try { await capture(); } catch {}
    return;
  }
  try {
    const frame = await capture();
    const id = crypto.randomUUID();
    store.enqueue({id, takenAt: Date.now(), bytes: frame.bytes});
    stateView.lastFrame = Date.now();
  } catch (e) {
    if (String(e && e.message) === 'permission') { stateView.permission = 'denied'; watchPermission(); }
  }
  await flush();
  buildTray();
}

// While permission is missing, re-check often so capture resumes promptly once
// the employee grants it — without firing a backlog of frames.
function watchPermission() {
  if (permissionTimer) return;
  permissionTimer = setInterval(() => {
    if (screenStatus() === 'granted') {
      clearInterval(permissionTimer); permissionTimer = null;
      stateView.permission = 'granted';
      if (!stateView.paused) tick();
    }
    buildTray();
  }, config.PERMISSION_POLL_MS);
}

async function flush() {
  if (flushing || !stateView.loggedIn) return;
  flushing = true;
  try {
    for (const item of store.list()) {
      const bytes = store.bytesFor(item.id);
      if (!bytes) { store.remove(item.id); continue; }
      let res;
      try {
        res = await api.postJpeg(stateView.cabinet, `/api/screenshots?id=${encodeURIComponent(item.id)}&taken_at=${item.takenAt}`, bytes);
      } catch {
        stateView.offline = true; break; // network down: keep the queue, retry next tick
      }
      stateView.offline = false;
      if (res.status === 200 || res.status === 409) {
        store.remove(item.id); // delivered, or already stored (idempotent replay)
      } else if (res.status === 401 || res.status === 403) {
        // Session lost or access revoked: stop and ask the employee to sign in again.
        await logout(); break;
      } else if (res.status === 413 || res.status === 415) {
        store.remove(item.id); // unacceptable frame: drop it rather than poison the queue
      } else {
        break; // transient server error: retry later
      }
    }
  } finally {
    flushing = false;
    stateView.queue = store.size();
  }
}

// ---- Live video (admin watch, from this app, never from the browser) ------

let officeWin = null;
let officeReady = false;
let officeTimer = null;
let officeSessions = [];
let officeDismissed = false;
let officeSignature = '';
let officePolling = false;

function installMediaHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'display-capture');
  const handler = async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize: {width: 320, height: 180}});
      const primary = screen.getPrimaryDisplay();
      const source = sources.find((item) => String(item.display_id) === String(primary.id)) || sources[0];
      callback(source ? {video: source} : {});
    } catch { callback({}); }
  };
  try { ses.setDisplayMediaRequestHandler(handler, {useSystemPicker: false}); }
  catch { try { ses.setDisplayMediaRequestHandler(handler); } catch {} }
}

function pushOffice() {
  if (officeReady && officeWin && !officeWin.isDestroyed()) officeWin.webContents.send('office-inbox', officeSessions);
}

async function hangupOffice(sessions) {
  await Promise.all(sessions.map((item) => api.postJson(stateView.cabinet, '/api/office/signal', {
    sessionId: item.id, type: 'hangup', payload: '{}',
  }).catch(() => {})));
}

function closeOfficeWindow() {
  officeReady = false;
  const win = officeWin;
  officeWin = null;
  if (win && !win.isDestroyed()) {
    win.removeAllListeners('close');
    win.close();
  }
}

function stopOffice(hangup) {
  if (officeTimer) { clearInterval(officeTimer); officeTimer = null; }
  const sessions = officeSessions;
  officeSessions = [];
  officeSignature = '';
  stateView.video = [];
  officeDismissed = false;
  if (hangup && sessions.length) hangupOffice(sessions);
  closeOfficeWindow();
}

function openOfficeWindow() {
  if (officeWin && !officeWin.isDestroyed()) return;
  officeReady = false;
  officeWin = new BrowserWindow({
    show: false, skipTaskbar: true, width: 440, height: 320, title: 'Falcon Time — видео',
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false},
  });
  officeWin.loadFile(path.join(__dirname, 'renderer', 'office.html'));
  officeWin.webContents.once('did-finish-load', () => { officeReady = true; pushOffice(); });
  officeWin.on('close', () => {
    officeDismissed = true;
    const sessions = officeSessions;
    officeSessions = [];
    stateView.video = [];
    officeSignature = '';
    if (sessions.length) hangupOffice(sessions);
    buildTray();
  });
  officeWin.on('closed', () => { officeWin = null; officeReady = false; });
}

async function pollOffice() {
  if (officePolling || !stateView.loggedIn) return;
  officePolling = true;
  try {
    if (stateView.paused) {
      if (officeSessions.length) { const sessions = officeSessions; officeSessions = []; await hangupOffice(sessions); }
      officeSignature = '';
      stateView.video = [];
      closeOfficeWindow();
      return;
    }
    let res;
    try { res = await api.get(stateView.cabinet, '/api/office/inbox'); }
    catch { return; }
    if (res.status === 401 || res.status === 403) return;
    const open = (api.parse(res)?.sessions || []).filter((item) => item && item.id && (item.kind === 'camera' || item.kind === 'screen'));
    if (!open.length) {
      officeDismissed = false;
      if (officeSessions.length || officeWin) {
        officeSessions = [];
        stateView.video = [];
        officeSignature = '';
        closeOfficeWindow();
        buildTray();
      }
      return;
    }
    if (officeDismissed) return;
    const signature = open.map((item) => item.kind).sort().join(',');
    officeSessions = open.map((item) => ({id: item.id, kind: item.kind}));
    if (open.some((item) => item.kind === 'camera') && process.platform === 'darwin') {
      try {
        if (systemPreferences.getMediaAccessStatus('camera') !== 'granted') await systemPreferences.askForMediaAccess('camera');
      } catch {}
    }
    openOfficeWindow();
    pushOffice();
    if (signature !== officeSignature) {
      officeSignature = signature;
      stateView.video = [...new Set(open.map((item) => item.kind))];
      buildTray();
    }
  } finally { officePolling = false; }
}

function startOffice() {
  if (officeTimer) return;
  installMediaHandlers();
  pollOffice();
  officeTimer = setInterval(pollOffice, 2000);
}

// ---- Tray (menu bar) -------------------------------------------------------

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

function hhmm(ms) {
  return ms ? new Intl.DateTimeFormat('ru-RU', {hour: '2-digit', minute: '2-digit'}).format(ms) : 'ещё нет';
}

function buildTray() {
  if (!tray) { tray = new Tray(trayImage()); }
  tray.setToolTip('Falcon Time снимает экран каждые 3 минуты');
  let template;
  if (!stateView.loggedIn) {
    template = [
      {label: 'Falcon Time', enabled: false},
      {type: 'separator'},
      {label: 'Войти…', click: openLogin},
      {label: 'Выйти', click: () => { quitting = true; app.quit(); }},
    ];
  } else {
    const permLine = stateView.permission === 'granted'
      ? null
      : {label: 'Нужно разрешение «Запись экрана»', enabled: false};
    template = [
      {label: 'Falcon Time снимает экран каждые 3 минуты', enabled: false},
      {label: `Сотрудник: ${stateView.personName || stateView.personId}`, enabled: false},
      {label: stateView.paused ? 'Статус: на паузе' : (stateView.permission === 'granted' ? 'Статус: активно' : 'Статус: ожидает разрешения'), enabled: false},
      {label: `Последний кадр: ${hhmm(stateView.lastFrame)}`, enabled: false},
      ...(stateView.video.length ? [{label: `Видео: ${stateView.video.map((kind) => kind === 'camera' ? 'камера' : 'экран').join(', ')}`, enabled: false}] : []),
      ...(stateView.queue ? [{label: `В очереди: ${stateView.queue}${stateView.offline ? ' · нет связи' : ''}`, enabled: false}] : []),
      ...(permLine ? [permLine, {label: 'Открыть настройки записи экрана', click: openScreenSettings}] : []),
      {type: 'separator'},
      stateView.paused
        ? {label: 'Возобновить', click: () => { stateView.paused = false; tick(); }}
        : {label: 'Пауза', click: () => { stateView.paused = true; stateView.video = []; pollOffice(); buildTray(); }},
      {label: 'Открыть кабинет', click: () => shell.openExternal(stateView.cabinet)},
      {label: 'Сменить сотрудника', click: () => { logout(); }},
      {type: 'separator'},
      {label: 'Выйти', click: () => { quitting = true; app.quit(); }},
    ];
  }
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function openScreenSettings() {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {});
  }
}

// ---- Login window ----------------------------------------------------------

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) { loginWin.show(); loginWin.focus(); return; }
  loginWin = new BrowserWindow({
    width: 420, height: 460, resizable: false, title: 'Falcon Assistant',
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false},
  });
  loginWin.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWin.on('closed', () => { loginWin = null; });
}

ipcMain.handle('defaults', () => {
  const s = store.readState();
  return {cabinet: s.cabinet || config.DEFAULT_CABINET, personId: s.personId || ''};
});
ipcMain.handle('office-signal', async (_e, body) => {
  if (!stateView.loggedIn || !body || typeof body.sessionId !== 'string' || typeof body.type !== 'string' || typeof body.payload !== 'string') return {ok: false, error: 'Неверный сигнал'};
  try {
    const res = await api.postJson(stateView.cabinet, '/api/office/signal', {sessionId: body.sessionId, type: body.type, payload: body.payload});
    const data = api.parse(res);
    if (res.status !== 200) return {ok: false, error: data?.error || 'Сигнал не принят'};
    return {ok: true, data};
  } catch (e) { return {ok: false, error: e.message || 'Нет связи'}; }
});
ipcMain.handle('office-pull', async (_e, body) => {
  if (!stateView.loggedIn || !body || typeof body.sessionId !== 'string') return {ok: false, error: 'Нет сессии'};
  const after = Number.isSafeInteger(body.after) && body.after >= 0 ? body.after : 0;
  try {
    const res = await api.get(stateView.cabinet, `/api/office/session?id=${encodeURIComponent(body.sessionId)}&after=${after}`);
    const data = api.parse(res);
    if (res.status !== 200) return {ok: false, error: data?.error || 'Нет связи'};
    return {ok: true, data};
  } catch (e) { return {ok: false, error: e.message || 'Нет связи'}; }
});
ipcMain.handle('login', async (_e, {id, code}) => {
  try {
    await loginFlow(config.DEFAULT_CABINET.replace(/\/$/, ''), String(id || '').trim(), String(code || ''));
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    start();
    return {ok: true};
  } catch (e) {
    return {ok: false, error: e.message || 'Ошибка входа'};
  }
});

// ---- App lifecycle ---------------------------------------------------------

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (loginWin) { loginWin.show(); loginWin.focus(); } });
  app.whenReady().then(async () => {
    buildTray();
    const s = store.readState();
    if (s.cabinet) stateView.cabinet = s.cabinet;
    if (s.personId) {
      // Reuse the stored session if it is still valid; otherwise ask to sign in.
      try {
        const me = await api.get(stateView.cabinet, '/api/me');
        const body = api.parse(me);
        if (me.status === 200 && body?.me?.onboarded) {
          Object.assign(stateView, {loggedIn: true, personId: body.me.id, personName: body.me.name});
          start();
          return;
        }
      } catch {}
    }
    openLogin();
  });
  // Keep running in the menu bar when the login window closes.
  app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault?.(); });
  app.on('before-quit', () => { quitting = true; });
}
