import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {openDatabase,fileBucket} from '../server/storage.mjs';
test('VPS: real SQLite batch rolls back all writes and survives reopen with migrations applied once',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'falcon-db-'));let db;
 try{const filename=path.join(dir,'app.sqlite');db=openDatabase(filename);
 await assert.rejects(db.batch([db.prepare("INSERT INTO projects(id,name) VALUES ('test','Test')"),db.prepare("INSERT INTO missing_table VALUES (1)")]));
 assert.equal(await db.prepare("SELECT * FROM projects WHERE id='test'").first(),null);
 await db.prepare("INSERT INTO projects(id,name) VALUES ('kept','Kept')").run();db.close();db=openDatabase(filename);
 assert.equal((await db.prepare("SELECT * FROM projects WHERE id='kept'").first()).name,'Kept');
 const migrationCount=fs.readdirSync(path.resolve('drizzle')).filter(n=>/^\d{4}_.*\.sql$/.test(n)).length;assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM falcon_migrations').first()).n,migrationCount);
 }finally{db?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('VPS: object store persists backup bytes, handles missing files and rejects traversal',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'falcon-files-'));
 try{const bucket=fileBucket(dir);await bucket.put('backups/one/manifest.json','{"ok":true}');assert.equal(await(await fileBucket(dir).get('backups/one/manifest.json')).text(),'{"ok":true}');assert.equal((await bucket.head('backups/one/manifest.json')).size,11);assert.equal(await bucket.get('missing'),null);await assert.rejects(bucket.put('../escape','bad'));await assert.rejects(bucket.get('/etc/passwd'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('VPS: offline import rebinds tenant, preserves codes and data, revokes devices, refuses overwrite',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'falcon-import-'));let restored;
 try{
  const source=path.join(dir,'backup.json'),destination=path.join(dir,'restored.sqlite');
  fs.writeFileSync(source,JSON.stringify({format:'falcon-time-backup',version:1,created:123,tables:{settings:[{key:'account',value:'old-cloudflare'}],people:[{id:'zafar',name:'Owner',role:'owner',code_hash:'salt:hash',created:123}],projects:[],devices:[{id:'device',person_id:'zafar',name:'Test',created:123,active:1}],events:[],corrections:[],audit:[]}}));
  const command=()=>spawnSync(process.execPath,['server/import-backup.mjs',source,destination],{encoding:'utf8'});
  assert.equal(command().status,0);assert.notEqual(command().status,0);restored=openDatabase(destination);
  assert.equal((await restored.prepare("SELECT value FROM settings WHERE key='account'").first()).value,'falcon-selfhosted');
  assert.equal((await restored.prepare("SELECT code_hash FROM people WHERE id='zafar'").first()).code_hash,'salt:hash');
  assert.equal((await restored.prepare("SELECT active FROM devices WHERE id='device'").first()).active,0);
 }finally{restored?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
