// Offline migration only. Existing databases are NEVER replaced.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from './storage.mjs';
const [source,destination]=process.argv.slice(2);
if(!source||!destination)throw new Error('Usage: node server/import-backup.mjs snapshot.json NEW.sqlite');
if(fs.existsSync(destination))throw new Error('Destination already exists; refusing to overwrite');
const snapshot=JSON.parse(fs.readFileSync(source,'utf8'));
const allowed=new Set(['settings','people','projects','devices','events','corrections','audit','review_events','session_archive']);
if(snapshot.format!=='falcon-time-backup'||snapshot.version!==1||!snapshot.tables)throw new Error('Expected a full version 1 backup export');
if(Object.keys(snapshot.tables).some(t=>!allowed.has(t)))throw new Error('Unexpected table');
for(const required of ['settings','people','projects','devices','events','corrections','audit'])if(!Array.isArray(snapshot.tables[required]))throw new Error('Missing table: '+required);
fs.mkdirSync(path.dirname(path.resolve(destination)),{recursive:true,mode:0o700});
const temporary=destination+'.import-'+randomUUID();
const db=openDatabase(temporary);
try {
  db.sqlite.exec('BEGIN IMMEDIATE');
  for(const [table,rows] of Object.entries(snapshot.tables)){
    const columns=new Set(db.sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(c=>c.name));
    for(const row of rows){
      const keys=Object.keys(row);if(keys.some(k=>!columns.has(k)))throw new Error('Unknown backup column');
      db.sqlite.prepare(`INSERT INTO "${table}" (${keys.map(k=>'"'+k+'"').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
    }
  }
  if(!db.sqlite.prepare("SELECT id FROM people WHERE id='zafar' AND role='owner' AND code_hash IS NOT NULL").get())throw new Error('Backup has no initialized owner');
  db.sqlite.exec("DELETE FROM settings WHERE key IN ('backup-lease','backup-error','maintenance-at'); UPDATE people SET auth_version=auth_version+1; UPDATE devices SET active=0; DELETE FROM logins; DELETE FROM login_codes; DELETE FROM attempts;");
  db.sqlite.prepare("INSERT INTO settings (key,value) VALUES ('account','falcon-selfhosted') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  db.sqlite.prepare('INSERT INTO audit (id,actor,action,target,detail,at) VALUES (?,?,?,?,?,?)').run(randomUUID(),'server','vps-import','database',JSON.stringify({sourceDate:snapshot.created,devicesDisabled:true}),Date.now());
  if(db.sqlite.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Database integrity check failed');
  db.sqlite.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
  fs.chmodSync(temporary,0o600);
  // Hard-link is exclusive; unlike rename it cannot replace a competing target.
  fs.linkSync(temporary,destination);
  console.log('Import verified. Owner and employee codes preserved; sessions revoked; reconnect devices.');
} catch(error){try{db.close();}catch{}throw error;}
finally{for(const suffix of ['','-wal','-shm'])if(fs.existsSync(temporary+suffix))fs.unlinkSync(temporary+suffix);}
