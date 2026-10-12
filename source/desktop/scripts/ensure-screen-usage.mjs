// Dev `electron .` ships as Electron.app without a screen-capture usage string.
// macOS 15+ then refuses to show the TCC prompt and never lists the app.
// This Electron binary is linker-signed with an unbound Info.plist, so the
// key can be added without re-signing.
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const plist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/electron/dist/Electron.app/Contents/Info.plist');
const keys = {
  NSScreenCaptureUsageDescription: 'Falcon Time делает снимок основного экрана раз в 3 минуты и, по запросу администратора, передаёт экран в кабинет. Передачу можно остановить в окне программы.',
  NSCameraUsageDescription: 'Falcon Time включает камеру только когда администратор запрашивает её в кабинете. Окно программы в этот момент открыто, передачу можно остановить.',
};

if (!existsSync(plist)) process.exit(0);

function current(key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch {
    return '';
  }
}

for (const [key, text] of Object.entries(keys)) {
  if (current(key) === text) continue;
  const op = current(key) ? 'Set' : 'Add';
  const verb = op === 'Add' ? 'string ' : '';
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `${op} :${key} ${verb}${text}`, plist]);
}
