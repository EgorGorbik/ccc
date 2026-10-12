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
const {app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, systemPreferences, shell} = require('electron');
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
  if (!body.me.onboarded) throw new Error('Сначала заполните личную анкету в кабинете Falcon Time, затем войдите здесь.');
  store.writeState({cabinet, personId: body.me.id, personName: body.me.name});
  Object.assign(stateView, {cabinet, loggedIn: true, personId: body.me.id, personName: body.me.name});
  return body.me;
}

async function logout() {
  stopCapturing();
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
      ...(stateView.queue ? [{label: `В очереди: ${stateView.queue}${stateView.offline ? ' · нет связи' : ''}`, enabled: false}] : []),
      ...(permLine ? [permLine, {label: 'Открыть настройки записи экрана', click: openScreenSettings}] : []),
      {type: 'separator'},
      stateView.paused
        ? {label: 'Возобновить', click: () => { stateView.paused = false; tick(); }}
        : {label: 'Пауза', click: () => { stateView.paused = true; buildTray(); }},
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
    width: 420, height: 560, resizable: false, title: 'Falcon Time',
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false},
  });
  loginWin.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWin.on('closed', () => { loginWin = null; });
}

ipcMain.handle('defaults', () => {
  const s = store.readState();
  return {cabinet: s.cabinet || config.DEFAULT_CABINET, personId: s.personId || ''};
});
ipcMain.handle('login', async (_e, {cabinet, id, code}) => {
  try {
    await loginFlow((cabinet || config.DEFAULT_CABINET).trim().replace(/\/$/, ''), String(id || '').trim(), String(code || ''));
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
