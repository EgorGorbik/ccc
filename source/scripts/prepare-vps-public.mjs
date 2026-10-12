import fs from 'node:fs';
import path from 'node:path';
const target=path.resolve(process.argv[2]||'.next/standalone');
fs.cpSync('public',path.join(target,'public'),{recursive:true});
fs.cpSync('.next/static',path.join(target,'.next/static'),{recursive:true});
const extension=path.join(target,'public/extension');
for(const name of fs.readdirSync(extension)){
  const filename=path.join(extension,name);
  if(fs.statSync(filename).isFile()&&/\.(json|js|html|md|txt)$/.test(name))fs.writeFileSync(filename,fs.readFileSync(filename,'utf8').replaceAll('https://falcon-time.zafar-safaro-0684.chatgpt.site','https://falconai.time'));
}
const manifest=path.join(extension,'manifest.json');const data=JSON.parse(fs.readFileSync(manifest,'utf8'));data.version='1.2.0';fs.writeFileSync(manifest,JSON.stringify(data));
const background=path.join(extension,'background.js');fs.writeFileSync(background,fs.readFileSync(background,'utf8').replace("const VERSION='1.1.0'", "const VERSION='1.2.0'"));
// Package without installing an archiver or Python into the build image.
const {writeZip}=await import('./zip.mjs');
writeZip(path.join(target,'public/falcon-time-extension.zip'),fs.readdirSync(extension).sort().filter(n=>fs.statSync(path.join(extension,n)).isFile()).map(name=>({name,body:fs.readFileSync(path.join(extension,name))})));
console.log('VPS static assets and falconai.time extension prepared.');
