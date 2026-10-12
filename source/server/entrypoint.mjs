import fs from 'node:fs';
import path from 'node:path';
import {pbkdf2Sync,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {nodeEnv} from './storage.mjs';

process.umask(0o077);
const origin=new URL(process.env.FALCON_ORIGIN||'https://falconai.time');
if(origin.protocol!=='https:'||origin.origin!==origin.href.slice(0,-1))throw new Error('FALCON_ORIGIN must be an HTTPS origin without path');
process.env.FALCON_ORIGIN=origin.origin;
const database=nodeEnv.DB;
const existing=database.sqlite.prepare("SELECT code_hash FROM people WHERE id='zafar'").get();
if(!existing?.code_hash){
  const filename=process.env.FALCON_OWNER_CODE_FILE||'/run/secrets/owner_code';
  const code=fs.readFileSync(filename,'utf8').trim();
  if(code.length<20)throw new Error('Owner code file requires at least 20 characters');
  const salt=randomBytes(16).toString('hex');
  const digest=salt+':'+pbkdf2Sync(code,salt,100000,32,'sha256').toString('hex');
  await database.batch([
    database.prepare("INSERT INTO people (id,name,role,code_hash,created) VALUES ('zafar','Зафар Сафаров','owner',?,?) ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash,auth_version=people.auth_version+1").bind(digest,Date.now()),
    database.prepare("INSERT INTO settings (key,value) VALUES ('account','falcon-selfhosted') ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
    database.prepare('INSERT INTO audit (id,actor,action,target,detail,at) VALUES (?,?,?,?,?,?)').bind(randomUUID(),'server','setup','account','{"binding":"self-hosted"}',Date.now()),
  ]);
}
const account=database.sqlite.prepare("SELECT value FROM settings WHERE key='account'").get();
if(account?.value!=='falcon-selfhosted')throw new Error('Import the snapshot using server/import-backup.mjs before starting');
// Check both persistent stores before listening. Never print authentication data.
await nodeEnv.BUCKET.put('health/startup-probe','ok');
database.close();
const server=process.env.FALCON_SERVER_FILE||path.resolve('server.js');
if(!fs.existsSync(server))throw new Error('Missing standalone server; run build:vps and package it');
const child=spawn(process.execPath,[server],{stdio:'inherit',env:process.env});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exit(1);});
child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
