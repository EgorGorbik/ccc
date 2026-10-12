import {spawnSync} from 'node:child_process';
const result=spawnSync('python',['-c',`from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
folder=Path('public/extension')
with ZipFile('public/falcon-time-extension.zip','w',ZIP_DEFLATED) as z:
 for f in sorted(folder.iterdir()):
  if f.is_file(): z.write(f,f.name)
print('Extension ZIP rebuilt from current source')`],{stdio:'inherit'});process.exit(result.status??1);
