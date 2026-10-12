import {env} from '@/lib/runtime';
import {db,query,run,hash,token,first} from './server';
import {archiveHistory} from './archive';
import {Problem} from './http';
const tables=['settings','people','projects','devices','corrections','audit','review_events','session_archive','pay_rates','project_budgets'] as const;
async function writeVerified(key:string,body:string){
 if(!env.BUCKET)throw new Error('Хранилище резервных копий не подключено');
 const checksum=await hash(body);await env.BUCKET.put(key,body,{httpMetadata:{contentType:'application/json'},customMetadata:{checksum}});
 const read=await env.BUCKET.get(key);if(!read||await hash(await read.text())!==checksum)throw new Error('Копия не прошла проверку чтения');
 return {key,checksum,bytes:new TextEncoder().encode(body).length};
}
async function writeBackup(){
 if(!env.BUCKET)throw new Error('Хранилище резервных копий не подключено');
 const result=await db().batch([...tables.map(t=>db().prepare(`SELECT * FROM ${t}`)),db().prepare('SELECT MAX(rowid) AS watermark FROM events')]);
 const data=Object.fromEntries(tables.map((t,i)=>[t,result[i].results||[]]));
 data.settings=(data.settings as any[]).filter(r=>!['backup-lease','backup-error'].includes(r.key));
 const watermark=Number((result[tables.length].results?.[0] as any)?.watermark||0);
 const created=Date.now(),id=crypto.randomUUID(),prefix=`backups/${new Date(created).toISOString().slice(0,10)}/${id}`;
 const parts=[];let cursor=0;
 // Events are append-only between maintenance runs. Capture a fixed high watermark,
 // then stream bounded pages to avoid holding the complete event history in memory.
 for(;;){const rows=await query('SELECT rowid AS backup_row,* FROM events WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 1000',cursor,watermark);if(!rows.length)break;cursor=rows.at(-1).backup_row;parts.push(await writeVerified(`${prefix}/events-${parts.length}.json`,JSON.stringify(rows.map(({backup_row,...row})=>row))));}
 const manifest={format:'falcon-time-backup',version:2,created,tables:data,eventParts:parts};const body=JSON.stringify(manifest);const saved=await writeVerified(`${prefix}/manifest.json`,body);
 await run('INSERT INTO backups (id,object_key,created,checksum,bytes,verified) VALUES (?,?,?,?,?,1)',id,saved.key,created,saved.checksum,saved.bytes+parts.reduce((n,p)=>n+p.bytes,0));
 return {id,created,checksum:saved.checksum};
}
export async function backupData(id:string){
 const row=(await query('SELECT * FROM backups WHERE id=?',id))[0];if(!row||!env.BUCKET)throw new Error('Копия не найдена');const file=await env.BUCKET.get(row.object_key);if(!file)throw new Error('Файл копии недоступен');const text=await file.text();if(await hash(text)!==row.checksum)throw new Error('Контрольная сумма не совпадает');
 const manifest=JSON.parse(text);if(manifest.version===1)return {row,body:text};
 const encoder=new TextEncoder();let index=-1,first=true;
 const body=new ReadableStream({async pull(controller){try{if(index===-1){const prefix=JSON.stringify({format:'falcon-time-backup',version:1,created:manifest.created,tables:manifest.tables});controller.enqueue(encoder.encode(prefix.slice(0,-2)+',"events":['));index=0;return;}if(index<manifest.eventParts.length){const part=manifest.eventParts[index++];const object=await env.BUCKET!.get(part.key);if(!object)throw new Error('Часть копии не найдена');const content=await object.text();if(await hash(content)!==part.checksum)throw new Error('Часть копии повреждена');const chunk=content.slice(1,-1);if(chunk){controller.enqueue(encoder.encode((first?'':',')+chunk));first=false;}return;}controller.enqueue(encoder.encode(']}}'));controller.close();}catch(e){controller.error(e);}}});
 return {row,body};
}
export async function createBackup(compact=false){
 const now=Date.now(),lease=`${now+3600000}:${token()}`;
 const claimed=await run("INSERT INTO settings (key,value) VALUES ('backup-lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(substr(settings.value,1,13) AS INTEGER)<?",lease,now);
 if(!claimed.meta.changes)throw new Problem('Резервное копирование уже выполняется. Повторите позже.',409,{'Retry-After':'30'});
 try{const saved=await writeBackup();if(compact){await archiveHistory(now);await run("INSERT INTO settings (key,value) VALUES ('maintenance-at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now));}return saved;}finally{await run("DELETE FROM settings WHERE key='backup-lease' AND value=?",lease);}
}
export async function dailyBackup(){
 const latest=await first('SELECT created FROM backups ORDER BY created DESC LIMIT 1');
 const maintenance=await first("SELECT value FROM settings WHERE key='maintenance-at'");
 const now=Date.now(),needsBackup=!latest||now-latest.created>=86400000;
 const needsMaintenance=!maintenance||now-Number(maintenance.value)>=86400000;
 if(!needsBackup&&!needsMaintenance)return;
 try{
  if(needsBackup)await createBackup(true);
  else if(needsMaintenance){
   // Share the backup lease: compaction must not delete rows while a paged
   // snapshot is being written, even when a recent manual backup exists.
   const lease=`${now+3600000}:${token()}`;
   const claimed=await run("INSERT INTO settings (key,value) VALUES ('backup-lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(substr(settings.value,1,13) AS INTEGER)<?",lease,now);
   if(!claimed.meta.changes)return;
   try{await archiveHistory(now);await run("INSERT INTO settings (key,value) VALUES ('maintenance-at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now));}
   finally{await run("DELETE FROM settings WHERE key='backup-lease' AND value=?",lease);}
  }
  await run("DELETE FROM settings WHERE key='backup-error'");
 }catch(e){
  // A second heartbeat encountering ongoing maintenance is not a backup failure.
  if(e instanceof Problem&&e.status===409)return;
  await run("INSERT INTO settings (key,value) VALUES ('backup-error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(e instanceof Error?e.message:e));
 }
}
