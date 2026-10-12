// Dev `electron .` ships as Electron.app without a screen-capture usage string.
// macOS 15+ then refuses to show the TCC prompt and never lists the app.
// This Electron binary is linker-signed with an unbound Info.plist, so the
// key can be added without re-signing.
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const plist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/electron/dist/Electron.app/Contents/Info.plist');
const key = 'NSScreenCaptureUsageDescription';
const text = 'Falcon Time делает снимок основного экрана раз в 3 минуты и отправляет его в кабинет учёта времени. Запись можно поставить на паузу в строке меню.';

if (!existsSync(plist)) process.exit(0);

function current() {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch {
    return '';
  }
}

if (current() === text) process.exit(0);
const op = current() ? 'Set' : 'Add';
const verb = op === 'Add' ? 'string ' : '';
execFileSync('/usr/libexec/PlistBuddy', ['-c', `${op} :${key} ${verb}${text}`, plist]);
