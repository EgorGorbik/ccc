'use strict';
// Publisher for an admin watch request. Runs only inside the Falcon Time desktop
// window the employee can see. Signaling goes through the main process; this
// page only holds the camera/screen and the WebRTC connection.
const iceServers = [{urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}];
const links = new Map();
const starting = new Set();
const blocked = new Set();
const streams = {};
const lines = document.getElementById('lines');
const errBox = document.getElementById('err');
const retry = document.getElementById('retry');
let open = [];

function label(kind) { return kind === 'camera' ? 'Камера' : 'Экран'; }

function render() {
  const byKind = new Map();
  for (const session of open) byKind.set(session.kind, links.get(session.id)?.state || 'ждём разрешение');
  lines.replaceChildren(...[...byKind].map(([kind, state]) => {
    const li = document.createElement('li');
    li.textContent = `${label(kind)}: ${state}`;
    return li;
  }));
}

async function grab(kind) {
  const held = streams[kind];
  if (held && held.getTracks().some((track) => track.readyState === 'live')) return held;
  const stream = kind === 'screen'
    ? await navigator.mediaDevices.getDisplayMedia({video: true, audio: false})
    : await navigator.mediaDevices.getUserMedia({video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}}, audio: false});
  streams[kind] = stream;
  stream.getTracks().forEach((track) => track.addEventListener('ended', () => {
    if (streams[kind] === stream) streams[kind] = undefined;
    for (const [id, link] of links) if (link.kind === kind) link.stop(true);
  }));
  return stream;
}

function connect(session, stream) {
  let closed = false;
  let after = 0;
  let pc = null;
  let timer;
  let iceDead;
  let remoteSet = false;
  const seen = new Set();
  const remoteIce = [];
  const state = {kind: session.kind, state: 'подключаемся', stop};

  async function setSending(on) {
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (sender.track) sender.track.enabled = on;
      const params = sender.getParameters();
      if (!params.encodings.length) params.encodings = [{active: on}];
      else for (const enc of params.encodings) enc.active = on;
      try { await sender.setParameters(params); } catch {}
    }
  }

  async function signal(type, payload) {
    const body = {sessionId: session.id, type, payload: typeof payload === 'string' ? payload : JSON.stringify(payload)};
    const res = await window.falcon.officeSignal(body);
    if (!res.ok) throw new Error(res.error || 'Сигнал не принят');
  }

  async function applyRemote(desc) {
    if (!pc || closed) return;
    await pc.setRemoteDescription(desc);
    remoteSet = true;
    for (const candidate of remoteIce.splice(0)) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
  }

  async function start() {
    pc = new RTCPeerConnection({iceServers});
    pc.onicecandidate = (e) => { if (e.candidate) signal('ice', e.candidate.toJSON()).catch(() => {}); };
    pc.onconnectionstatechange = () => {
      if (!pc || closed) return;
      const connection = pc.connectionState;
      if (connection === 'connected') { clearTimeout(iceDead); state.state = 'в эфире'; render(); setSending(true); }
      else setSending(false);
      if (connection === 'failed') signal('error', 'Нет соединения со стримом').catch(() => {});
      if (connection === 'disconnected') {
        clearTimeout(iceDead);
        iceDead = setTimeout(() => { if (!closed && pc?.connectionState === 'disconnected') signal('hangup', '{}').catch(() => {}); }, 8000);
      }
    };
    for (const track of stream.getTracks()) {
      if (track.readyState !== 'live') continue;
      const copy = track.clone();
      copy.enabled = false;
      pc.addTrack(copy, stream);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setSending(false);
    await signal('offer', pc.localDescription);
    state.state = 'ждём кабинет';
    render();
  }

  async function tick() {
    if (closed) return;
    try {
      const res = await window.falcon.officePull({sessionId: session.id, after});
      if (closed || !res.ok) throw new Error(res.error || 'Нет связи');
      const data = res.data;
      if (data.session?.status === 'ended' || data.session?.status === 'failed') { stop(false); return; }
      for (const item of data.signals || []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        after = Math.max(after, Number(item.created) || 0);
        if (item.sender === 'member') continue;
        if (item.type === 'hangup' || item.type === 'error') { stop(false); return; }
        let body = null;
        try { body = JSON.parse(item.payload); } catch {}
        if (item.type === 'ice' && body) {
          if (remoteSet && pc) { try { await pc.addIceCandidate(body); } catch {} }
          else remoteIce.push(body);
        }
        if (item.type === 'answer' && body && pc && !pc.currentRemoteDescription) await applyRemote(body);
      }
    } catch {}
    if (!closed) timer = setTimeout(tick, 800);
  }

  function stop(hangup = true) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(iceDead);
    if (hangup) signal('hangup', '{}').catch(() => {});
    const source = new Set(stream.getTracks());
    pc?.getSenders().forEach((sender) => { if (sender.track && !source.has(sender.track)) sender.track.stop(); });
    pc?.close();
    links.delete(session.id);
    render();
  }

  links.set(session.id, state);
  render();
  start().then(tick, (e) => {
    errBox.textContent = e instanceof Error ? e.message : 'Не удалось открыть видео';
    retry.hidden = false;
    signal('error', errBox.textContent).catch(() => {});
    stop(false);
  });
  return state;
}

async function sync(sessions) {
  open = sessions || [];
  const ids = new Set(open.map((s) => s.id));
  for (const [id, link] of links) if (!ids.has(id)) link.stop(true);
  for (const kind of [...blocked]) if (!open.some((item) => item.kind === kind)) blocked.delete(kind);
  for (const session of open) {
    if (links.has(session.id) || starting.has(session.id) || blocked.has(session.kind)) continue;
    starting.add(session.id);
    try {
      const stream = await grab(session.kind);
      if (!open.some((item) => item.id === session.id) || links.has(session.id)) continue;
      blocked.delete(session.kind);
      retry.hidden = blocked.size === 0;
      connect(session, stream);
    } catch (e) {
      blocked.add(session.kind);
      errBox.textContent = session.kind === 'camera'
        ? 'Разрешите камеру для Falcon Time и нажмите «Разрешить снова».'
        : 'Разрешите запись экрана для Falcon Time и нажмите «Разрешить снова».';
      retry.hidden = false;
      render();
    } finally { starting.delete(session.id); }
  }
  if (!open.length) {
    for (const stream of Object.values(streams)) stream?.getTracks().forEach((track) => track.stop());
    for (const key of Object.keys(streams)) delete streams[key];
  }
  render();
}

window.falcon.onOfficeInbox((sessions) => { sync(sessions); });
retry.addEventListener('click', () => { blocked.clear(); retry.hidden = true; errBox.textContent = ''; sync(open); });
document.getElementById('stop').addEventListener('click', () => {
  for (const link of [...links.values()]) link.stop(true);
  window.close();
});
