'use strict';
// A single frame of the primary screen, encoded as JPEG. This is the only thing
// the agent reads from the machine: no keystrokes, no clipboard, no per-window
// inspection — just one picture of the main display.
const {desktopCapturer, screen} = require('electron');
const {THUMB, JPEG_QUALITY} = require('./config');

async function capture() {
  const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize: THUMB});
  if (!sources.length) throw new Error('Нет источников экрана');
  const primary = screen.getPrimaryDisplay();
  const source = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const image = source.thumbnail;
  // An empty image means the OS has not granted Screen Recording yet.
  if (image.isEmpty()) throw new Error('permission');
  const size = image.getSize();
  return {bytes: image.toJPEG(JPEG_QUALITY), width: size.width, height: size.height};
}

module.exports = {capture};
