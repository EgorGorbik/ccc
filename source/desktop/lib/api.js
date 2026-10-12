'use strict';
// All cabinet traffic goes through a single persistent Electron session, so the
// falcon_profile cookie is stored locally and reused across restarts. Requests
// are made from the main process (no Origin header), which the cabinet's
// same-origin guard accepts, and frames are sent to this cabinet and nowhere else.
const {net, session} = require('electron');
const {PARTITION} = require('./config');

let ses;
function getSession() { return ses || (ses = session.fromPartition(PARTITION)); }

function request(base, {method = 'GET', path, headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(path, base).toString(); } catch (e) { return reject(e); }
    const req = net.request({method, url, session: getSession(), useSessionCookies: true, redirect: 'follow'});
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : Buffer.from(body));
    req.end();
  });
}

function parse(res) { try { return JSON.parse(res.body.toString('utf8')); } catch { return null; } }

const get = (base, path) => request(base, {method: 'GET', path});
const postJson = (base, path, obj) =>
  request(base, {method: 'POST', path, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(obj)});
const postJpeg = (base, path, buf) =>
  request(base, {method: 'POST', path, headers: {'Content-Type': 'image/jpeg'}, body: buf});

async function clearSession() { try { await getSession().clearStorageData(); } catch {} }

module.exports = {request, parse, get, postJson, postJpeg, clearSession, getSession};
