'use strict';
// Local persistence: login state and the offline frame queue. Everything lives
// under Electron's per-user userData directory. Frame bytes are stored as plain
// .jpg files so there is nothing opaque about what is kept on disk.
const {app} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {MAX_QUEUE} = require('./config');

const base = () => app.getPath('userData');
const stateFile = () => path.join(base(), 'state.json');
const queueDir = () => path.join(base(), 'queue');
const indexFile = () => path.join(queueDir(), 'index.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function writeState(next) {
  fs.mkdirSync(base(), {recursive: true});
  fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2));
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch { return []; }
}
function writeIndex(list) {
  fs.mkdirSync(queueDir(), {recursive: true});
  fs.writeFileSync(indexFile(), JSON.stringify(list, null, 2));
}
const frameFile = (id) => path.join(queueDir(), id.replace(/[^a-zA-Z0-9._-]/g, '') + '.jpg');

// Store a captured frame for (idempotent) delivery. The id is generated once at
// capture time and reused on every retry, so a replay never duplicates a record.
function enqueue({id, takenAt, bytes}) {
  fs.mkdirSync(queueDir(), {recursive: true});
  let list = readIndex();
  if (!list.some((f) => f.id === id)) {
    fs.writeFileSync(frameFile(id), bytes);
    list.push({id, takenAt});
  }
  list.sort((a, b) => a.takenAt - b.takenAt);
  // Bound the backlog: drop the oldest frames rather than ever sending a burst.
  while (list.length > MAX_QUEUE) {
    const dropped = list.shift();
    try { fs.unlinkSync(frameFile(dropped.id)); } catch {}
  }
  writeIndex(list);
}

function list() { return readIndex().sort((a, b) => a.takenAt - b.takenAt); }
function bytesFor(id) { try { return fs.readFileSync(frameFile(id)); } catch { return null; } }
function remove(id) {
  writeIndex(readIndex().filter((f) => f.id !== id));
  try { fs.unlinkSync(frameFile(id)); } catch {}
}
function size() { return readIndex().length; }

module.exports = {readState, writeState, enqueue, list, bytesFor, remove, size};
