import {db,query,first} from './server';
import {deriveSessions,localDate,localMidnight,type Event,type Session} from './time';
export async function archiveState(personId:string){const checkpoint=await first('SELECT value FROM settings WHERE key=?','archive:'+personId);return checkpoint?JSON.parse(checkpoint.value):{at:0,paused:false};}
export async function recentEvents(personId:string,snapshot?:any):Promise<Event[]>{
 const state=snapshot||await archiveState(personId);
 const events:Event[]=state.paused?[{id:'checkpoint:'+personId,person_id:personId,device_id:'archive',project_id:'none',kind:'stop',at:state.at,received:0}]:[];
 let cursor=0;for(let n=0;n<150;n++){const page=await query('SELECT rowid AS row_num,* FROM events WHERE person_id=? AND at>=? AND rowid>? ORDER BY rowid LIMIT 1000',personId,state.at,cursor);events.push(...page as Event[]);if(page.length<1000)return events;cursor=page.at(-1).row_num;}
 throw new Error('Требуется архивирование истории сотрудника. Данные сохранены.');
}
export async function archivedSessions(personId:string,snapshot?:any):Promise<Session[]>{const state=snapshot||await archiveState(personId);return (await query('SELECT * FROM session_archive WHERE person_id=? AND end<=? AND start<? ORDER BY start',personId,state.at,state.at)).map(s=>({...s,open:false,event_ids:JSON.parse(s.event_ids)})) as Session[];}
export async function archiveHistory(now=Date.now()){
 const people=await query('SELECT id FROM people');const retentionStart=localMidnight(`${Number(localDate(now).slice(0,4))-1}-01-01`);
 for(const person of people){
  const events=await recentEvents(person.id);const sessions=deriveSessions(events,now);let cutoff=now-8*86400000;
  const crossing=sessions.find(s=>s.start<cutoff&&s.end>cutoff);if(crossing)cutoff=crossing.start;
  const previous=await first('SELECT value FROM settings WHERE key=?','archive:'+person.id);if(previous&&JSON.parse(previous.value).at>=cutoff)continue;
  const corrections=await query('SELECT session_id FROM corrections WHERE person_id=?',person.id);const correctionIds=new Set(corrections.map(c=>c.session_id));
  const old=sessions.filter(s=>!s.open&&s.end<=cutoff&&s.start<cutoff);
  const controls=events.filter(e=>e.at<cutoff&&['stop','resume','revoke'].includes(e.kind)).sort((a,b)=>a.at-b.at||a.received-b.received||a.id.localeCompare(b.id));
  // The checkpoint never passes the seven-day late-delivery window.
  const inserts=old.map(s=>db().prepare('INSERT OR IGNORE INTO session_archive (id,person_id,project_id,device_id,start,last,end,reason,event_ids) VALUES (?,?,?,?,?,?,?,?,?)').bind(s.id,s.person_id,s.project_id,s.device_id,s.start,s.last,s.end,s.reason,JSON.stringify((s.event_ids||[]).filter(id=>correctionIds.has(id)))));
  for(let i=0;i<inserts.length;i+=100)await db().batch(inserts.slice(i,i+100));
  await db().batch([
   db().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('archive:'+person.id,JSON.stringify({at:cutoff,paused:!!controls.length&&controls.at(-1)!.kind!=='resume'})),
   db().prepare('DELETE FROM events WHERE person_id=? AND at<?').bind(person.id,Math.min(cutoff,now-90*86400000)),
   db().prepare('DELETE FROM session_archive WHERE person_id=? AND end<?').bind(person.id,retentionStart),
   db().prepare('DELETE FROM corrections WHERE person_id=? AND end<?').bind(person.id,retentionStart)
  ]);
 }
 await db().batch([db().prepare('DELETE FROM logins WHERE expires<?').bind(now),db().prepare('DELETE FROM login_codes WHERE expires<?').bind(now-86400000),db().prepare('DELETE FROM attempts WHERE until<?').bind(now),db().prepare('DELETE FROM review_events WHERE created<? AND status<>?').bind(retentionStart,'pending')]);
}
