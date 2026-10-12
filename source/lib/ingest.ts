import {db,query,first,run,controlState} from './server';
import {eventIssue,type IncomingEvent} from './tracking';
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=80;
export async function ingestEvents(personId:string,device:any,input:any[],now=Date.now()){
 const accepted:string[]=[],rejected:{id:string;reason:string}[]=[],ignored:string[]=[];
 const projects=new Set((await query('SELECT id FROM projects')).map(p=>p.id));
 const baseline=await first('SELECT value FROM settings WHERE key=?','archive:'+personId);
 const controls=await query("SELECT kind,at FROM events WHERE person_id=? AND kind IN ('stop','resume','revoke') ORDER BY at,received,id",personId);
 if(baseline){const s=JSON.parse(baseline.value);controls.unshift({kind:s.paused?'stop':'resume',at:s.at});}
 const ordered=[...input].sort((a,b)=>(a.seq||0)-(b.seq||0));
 for(const e of ordered as IncomingEvent[]){
  if(!validId(e.id))throw new Error('Недопустимый ID события');
  const duplicate=await first('SELECT * FROM events WHERE id=?',e.id);
  if(duplicate){if(duplicate.person_id===personId&&duplicate.device_id===device.id)accepted.push(e.id);else rejected.push({id:e.id,reason:'ID уже занят'});continue;}
  const pending=await first('SELECT id,status,reason FROM review_events WHERE id=? AND person_id=?',e.id,personId);
  if(pending){rejected.push({id:e.id,reason:pending.reason});continue;}
  let reason=eventIssue(e,now,device.created);
  if(e.kind!=='activity'||!projects.has(e.projectId))reason='Неизвестный проект или тип события';
  if(!reason){
   const prev=await first('SELECT seq,at FROM events WHERE device_id=? AND seq<? ORDER BY seq DESC LIMIT 1',device.id,e.seq);
   const next=await first('SELECT seq,at FROM events WHERE device_id=? AND seq>? ORDER BY seq LIMIT 1',device.id,e.seq);
   const duplicateSeq=await first('SELECT id FROM events WHERE device_id=? AND seq=?',device.id,e.seq);
   if(duplicateSeq)reason='Повтор номера с другим ID';
   else if((prev&&prev.at>e.at+1000)||(next&&next.at<e.at-1000))reason='Нарушен порядок времени устройства';
  }
  if(reason){
   await run('INSERT OR IGNORE INTO review_events (id,person_id,device_id,project_id,at,seq,reason,created) VALUES (?,?,?,?,?,?,?,?)',e.id,personId,device.id,projects.has(e.projectId)?e.projectId:'none',Number.isSafeInteger(e.at)?e.at:now,Number.isSafeInteger(e.seq)?e.seq:null,reason,now);
   rejected.push({id:e.id,reason});continue;
  }
  const control=controls.filter(c=>c.at<=e.at).at(-1);
  if(control&&control.kind!=='resume'){ignored.push(e.id);continue;}
  // Conditional write closes the race with revocation during a batch.
  const result=await run(`INSERT OR IGNORE INTO events (id,person_id,device_id,project_id,kind,at,received,seq)
    SELECT ?,?,?,?,?,?,MAX(?,COALESCE((SELECT MAX(received)+1 FROM events WHERE person_id=?),?)),?
    WHERE EXISTS (SELECT 1 FROM devices d JOIN people p ON p.id=d.person_id WHERE d.id=? AND d.person_id=? AND d.active=1 AND p.active=1)
    AND NOT EXISTS (SELECT 1 FROM events WHERE device_id=? AND ((seq<? AND at>?) OR (seq>? AND at<?)))`,
    e.id,personId,device.id,e.projectId,'activity',Math.min(e.at,now),now,personId,now,e.seq,
    device.id,personId,device.id,e.seq,e.at+1000,e.seq,e.at-1000);
  if(result.meta.changes){accepted.push(e.id);continue;}
  // Another request may have inserted the same event or a contradictory sequence
  // after the reads above. Never acknowledge an uncommitted event as accepted.
  const saved=await first('SELECT person_id,device_id FROM events WHERE id=?',e.id);
  if(saved?.person_id===personId&&saved.device_id===device.id){accepted.push(e.id);continue;}
  const stillActive=await first('SELECT d.id FROM devices d JOIN people p ON p.id=d.person_id WHERE d.id=? AND d.active=1 AND p.active=1',device.id);
  reason=!stillActive?'Устройство отключено':saved?'ID уже занят':'Номер или порядок времени изменён параллельным запросом';
  if(stillActive&&!saved)await run('INSERT OR IGNORE INTO review_events (id,person_id,device_id,project_id,at,seq,reason,created) VALUES (?,?,?,?,?,?,?,?)',e.id,personId,device.id,e.projectId,e.at,e.seq,reason,now);
  rejected.push({id:e.id,reason});
 }
 const control=await controlState(personId);
 return {accepted,rejected,ignored,paused:!!control&&control.kind!=='resume',serverTime:now};
}
