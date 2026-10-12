import { env, selfHosted } from '@/lib/runtime';
import { recentEvents, archivedSessions, archiveState } from './archive';
import { deriveSessions,type Event,type Session } from './time';
export function db(){if(!env.DB)throw new Error('База временно недоступна');return env.DB;}
export const query=async(sql:string,...args:unknown[])=>((await db().prepare(sql).bind(...args).all()).results||[]) as any[];
export const first=async(sql:string,...args:unknown[])=>await db().prepare(sql).bind(...args).first() as any;
export const run=async(sql:string,...args:unknown[])=>db().prepare(sql).bind(...args).run();
export const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(24))).map(x=>x.toString(16).padStart(2,'0')).join('');
export async function hash(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function codeHash(code:string,salt?:string){const actual=salt||token().slice(0,32);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(code),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(actual),iterations:100000,hash:'SHA-256'},key,256);return actual+':'+Array.from(new Uint8Array(bits)).map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function verify(code:string,stored:string){const h=await codeHash(code,stored.split(':')[0]);let diff=h.length^stored.length;for(let i=0;i<h.length;i++)diff|=h.charCodeAt(i)^(stored.charCodeAt(i)||0);return diff===0;}
export const defaultPassword='1234';
export async function initialize(){const now=Date.now();await db().batch([
 db().prepare('INSERT OR IGNORE INTO people (id,name,role,created) VALUES (?,?,?,?)').bind('zafar','Зафар Сафаров','owner',now),db().prepare('INSERT OR IGNORE INTO people (id,name,role,created) VALUES (?,?,?,?)').bind('yura','Юра','admin',now),db().prepare('INSERT OR IGNORE INTO people (id,name,role,created) VALUES (?,?,?,?)').bind('daniil','Даниил','member',now),
 ...[['none','Без проекта'],['falcon-messenger','Falcon Messenger'],['homekept','HomeKept'],['falcon-cockpit','Falcon Cockpit']].map(([id,name])=>db().prepare('INSERT OR IGNORE INTO projects (id,name) VALUES (?,?)').bind(id,name))]);
 if(!selfHosted)await ensureOrgAdmin(now);}
// Sites cabinet: one organization admin (login admin). Everyone else is an employee.
// The password reset runs once so a later change in the profile card is kept.
async function ensureOrgAdmin(now:number){
 const done=await first("SELECT value FROM settings WHERE key='org-admin-v1'");
 if(done){if(!(await first("SELECT id FROM people WHERE id='admin'"))){const digest=await codeHash(defaultPassword);await run("INSERT INTO people (id,name,role,code_hash,onboarded,active,created) VALUES ('admin','Администратор','admin',?,1,1,?)",digest,now);}return;}
 const digest=await codeHash(defaultPassword);
 await db().batch([
  db().prepare("INSERT INTO people (id,name,role,code_hash,onboarded,active,created) VALUES ('admin','Администратор','admin',?,1,1,?) ON CONFLICT(id) DO UPDATE SET role='admin',name='Администратор',code_hash=excluded.code_hash,onboarded=1,active=1,auth_version=people.auth_version+1").bind(digest,now),
  db().prepare("UPDATE people SET role='member',code_hash=?,auth_version=auth_version+1 WHERE id IN ('zafar','yura','daniil')").bind(digest),
  db().prepare("UPDATE people SET code_hash=? WHERE code_hash IS NULL AND id<>'admin'").bind(digest),
  db().prepare("INSERT INTO settings (key,value) VALUES ('org-admin-v1','1') ON CONFLICT(key) DO UPDATE SET value='1'"),
 ]);}
export async function audit(actor:string,action:string,target:string,detail:unknown){await run('INSERT INTO audit (id,actor,action,target,detail,at) VALUES (?,?,?,?,?,?)',crypto.randomUUID(),actor,action,target,JSON.stringify(detail),Date.now());}
export async function allSessions(personIds:string[],now=Date.now()):Promise<Session[]>{
 const result:Session[]=[];
 for(const id of personIds){const snapshot=await archiveState(id);const automatic=[...await archivedSessions(id,snapshot),...deriveSessions(await recentEvents(id,snapshot),now)];const cs=await query('SELECT * FROM corrections WHERE person_id=?',id);result.push(...applyCorrections(automatic,cs));}
 return result.sort((a,b)=>a.start-b.start);
}
// A correction replaces its original interval, not later activity that can merge
// with it when an offline device delivers older events.
export function applyCorrections(sessions:Session[],cs:any[]):Session[]{
 const subtract=(session:Session,start:number,end:number):Session[]=>{
  if(session.end<=start||session.start>=end)return [session];
  const pieces:Session[]=[];
  if(session.start<start)pieces.push({...session,end:start,open:false,conflict:true,id:session.id+'~left'});
  if(session.end>end)pieces.push({...session,start:end,conflict:true,id:session.id+'~right'});
  return pieces;
 };
 const fixed:Session[]=cs.map(c=>{
  const old=sessions.find(s=>s.id===c.session_id||s.event_ids?.includes(c.session_id));
  return {id:c.session_id,person_id:c.person_id,project_id:c.project_id,device_id:old?.device_id||'manual',start:c.start,end:c.end,last:Math.min(old?.last||c.end,c.end),reason:'corrected',open:false,corrected:true,correction_reason:c.reason,conflict:!!old&&(old.start!==c.original_start||old.end!==c.original_end)};
 });
 const automatic:Session[]=[];
 for(const session of sessions){
  let pieces=[{...session}];
  for(const correction of cs.filter(c=>c.person_id===session.person_id&&(session.id===c.session_id||session.event_ids?.includes(c.session_id)))){
   // Older 1.0 corrections had zero provenance bounds. Preserve their established
   // replacement behavior until an operator rechecks that legacy correction.
   const from=correction.original_end>correction.original_start?correction.original_start:session.start;
   const to=correction.original_end>correction.original_start?correction.original_end:session.end;
   pieces=pieces.flatMap(piece=>subtract(piece,from,to));
  }
  for(const correction of fixed.filter(c=>c.person_id===session.person_id)){
   if(pieces.some(p=>p.start<correction.end&&p.end>correction.start))correction.conflict=true;
   pieces=pieces.flatMap(piece=>subtract(piece,correction.start,correction.end));
  }
  automatic.push(...pieces);
 }
 return [...fixed,...automatic].sort((a,b)=>a.start-b.start);
}
export async function controlState(personId:string,at=Date.now()){
 const control=await first("SELECT kind,at FROM events WHERE person_id=? AND kind IN ('stop','resume','revoke') AND at<=? ORDER BY at DESC,received DESC,id DESC LIMIT 1",personId,at);if(control)return control;
 const checkpoint=await first('SELECT value FROM settings WHERE key=?','archive:'+personId);const state=checkpoint?JSON.parse(checkpoint.value):null;
 return state&&state.at<=at?{kind:state.paused?'stop':'resume',at:state.at}:null;
}

export function auditStatement(actor:string,action:string,target:string,detail:unknown,ifChanged=false){
 return db().prepare(`INSERT INTO audit (id,actor,action,target,detail,at) SELECT ?,?,?,?,?,?${ifChanged?' WHERE changes()>0':''}`).bind(crypto.randomUUID(),actor,action,target,JSON.stringify(detail),Date.now());
}
export function eventStatement(person:string,device:string,project:string,kind:string,at:number){
 return db().prepare('INSERT INTO events (id,person_id,device_id,project_id,kind,at,received) SELECT ?,?,?,?,?,?,MAX(?,COALESCE(MAX(received)+1,?)) FROM events WHERE person_id=?').bind(crypto.randomUUID(),person,device,project,kind,at,Date.now(),Date.now(),person);
}
