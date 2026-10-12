import { getChatGPTUser } from '../../chatgpt-auth';
import { db,query,first,run,token,codeHash,verify,audit,allSessions,controlState,auditStatement,eventStatement,defaultPassword } from '@/lib/server';
import { clipSessions,periodBounds,localDate,localMidnight } from '@/lib/time';
import { ingestEvents } from '@/lib/ingest';
import { deviceHealth } from '@/lib/tracking';
import { dailyBackup,createBackup,backupData } from '@/lib/backup';
export const dynamic='force-dynamic';
import {fail,json,field,readBody,checkMethod,apiBoundary,readBinary,assertSameOrigin} from '@/lib/http';
import {authenticate,publicAuth,safePerson} from '@/lib/auth';
import {readiness} from '@/lib/readiness';
import {storeScreenshot,listScreenshots,screenshotOwner,screenshotFile,assertCanView,listWorkBlocks,writeWorkBlock,SHOT_LIMIT} from '@/lib/screenshots';
import {payView,saveRate,saveBudget,usdCents,validDate} from '@/lib/pay';
import {officeHandle} from '@/lib/office';
function thisWeek(now=Date.now()){
 const today=localDate(now);
 const d=new Date(today+'T12:00:00Z');
 d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
 const start=d.toISOString().slice(0,10);
 d.setUTCDate(d.getUTCDate()+7);
 return {from:localMidnight(start),to:localMidnight(d.toISOString().slice(0,10))};
}
async function handle(req:Request){
 const platform=await getChatGPTUser();if(!platform)return json({error:'Войдите через ChatGPT',signin:true},401);
 const url=new URL(req.url),path=url.pathname.replace(/^\/api\//,'');const method=req.method;
 checkMethod(path,method);
 const account=await first('SELECT value FROM settings WHERE key=?','account');if(account&&account.value!==platform.userId)fail('Этот кабинет подключён к другому аккаунту ChatGPT',403);
 if(path==='screenshots'&&method==='POST'){
  // Binary upload: handled before readBody (which would reject non-JSON). person_id
  // always comes from the authenticated session cookie, never from the request body.
  const {me}=await authenticate(req,platform.userId);if(!me.onboarded)fail('Сначала заполните личную анкету');
  const contentType=req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  let bytes:Uint8Array,takenAt:number,id:string;
  if(contentType==='multipart/form-data'){
   assertSameOrigin(req);if(Number(req.headers.get('content-length')||0)>SHOT_LIMIT)fail('Слишком большой запрос',413);
   const form=await req.formData();const file=form.get('shot');
   if(!(file instanceof Blob))fail('Нет файла снимка');
   bytes=new Uint8Array(await (file as Blob).arrayBuffer());if(bytes.byteLength>SHOT_LIMIT)fail('Слишком большой запрос',413);
   takenAt=Number(form.get('taken_at'));id=field(typeof form.get('id')==='string'?form.get('id') as string:url.searchParams.get('id'),80);
  }else{
   bytes=await readBinary(req,SHOT_LIMIT);takenAt=Number(url.searchParams.get('taken_at'));id=field(url.searchParams.get('id'),80);
  }
  const result=await storeScreenshot(me.id,id,takenAt,bytes);return json({id:result.id,taken_at:result.taken_at});
 }
 const b=await readBody(req);const publicResult=await publicAuth(path,b,platform);if(publicResult)return publicResult;
 const {loginHash,me}=await authenticate(req,platform.userId);const admin=me.role==='owner'||me.role==='admin';const needAdmin=()=>{if(!admin)fail('Требуются права администратора',403);};
 if(path.startsWith('office/')){const office=await officeHandle(path,method,url,b,me);if(office)return office;}
 if(path==='readiness'){needAdmin();const status=await readiness();return json(status,status.ready?200:503);}
 if(path==='me'&&method==='GET')return json({me,accountConnected:!!account,serverTime:Date.now()});
 if(path==='logout'&&method==='POST'){
  await db().batch([eventStatement(me.id,'web','none','stop',Date.now()),db().prepare('DELETE FROM logins WHERE hash=?').bind(loginHash)]);
  return json({ok:true},200,{'Set-Cookie':'falcon_profile=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'});
 }
 if(path==='extension-state'&&method==='GET'){const deviceId=url.searchParams.get('device');if(deviceId&&!await first('SELECT id FROM devices WHERE id=? AND person_id=? AND active=1',deviceId,me.id))fail('Устройство отключено. Подключите его заново.',403);const control=await controlState(me.id);return json({me,projects:await query('SELECT * FROM projects WHERE active=1'),paused:!!control&&control.kind!=='resume',serverTime:Date.now()});}
 if(path==='profile'&&method==='POST'){
  const name=field(b.name),email=field(b.email,200).toLowerCase(),job=field(b.job),timezone=field(b.timezone,80),equipment=field(b.equipment,200);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Проверьте почту');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{fail('Проверьте часовой пояс');}
  if(b.consent!==true)fail('Подтвердите подключение учёта');
  await db().batch([
   db().prepare('UPDATE login_codes SET used=1 WHERE person_id=? AND EXISTS (SELECT 1 FROM people WHERE id=? AND email<>?)').bind(me.id,me.id,email),
   db().prepare('UPDATE people SET name=?,email=?,job=?,timezone=?,equipment=?,onboarded=1 WHERE id=?').bind(name,email,job,timezone,equipment,me.id),
   ...(!me.onboarded?[eventStatement(me.id,'web','none','resume',Date.now())]:[]),
   auditStatement(me.id,'profile',me.id,{name})
  ]);return json({ok:true});
 }
 if(path==='password'&&method==='POST'){
  const current=field(b.current,200),next=field(b.next,200);
  if(next.length<4)fail('Пароль должен содержать не менее 4 символов');
  if(next===current)fail('Новый пароль совпадает с текущим');
  const row=await first('SELECT code_hash FROM people WHERE id=?',me.id);
  if(!row?.code_hash||!(await verify(current,row.code_hash)))fail('Неверный текущий пароль',401);
  const digest=await codeHash(next);
  const result=await db().batch([
   db().prepare('UPDATE people SET code_hash=?,auth_version=auth_version+1 WHERE id=? AND code_hash=?').bind(digest,me.id,row.code_hash),
   auditStatement(me.id,'password',me.id,{},true),
   db().prepare('UPDATE logins SET auth_version=(SELECT auth_version FROM people WHERE id=?) WHERE hash=? AND changes()>0').bind(me.id,loginHash),
   db().prepare('DELETE FROM logins WHERE person_id=? AND hash<>? AND changes()>0').bind(me.id,loginHash),
  ]);
  if(!result[0].meta.changes)fail('Пароль уже изменён. Войдите снова.',409);
  return json({ok:true});
 }
 if(path==='data'&&method==='GET'){const people=admin?await query('SELECT * FROM people ORDER BY created,id'):[me];const ids=people.map(p=>p.id);const projects=await query('SELECT * FROM projects ORDER BY name');const devices=admin?await query('SELECT * FROM devices ORDER BY created'):await query('SELECT * FROM devices WHERE person_id=? ORDER BY created',me.id);const period=url.searchParams.get('period')||'day';if(!['day','week','month','year'].includes(period))fail('Неверный период');const date=url.searchParams.get('date')||localDate(Date.now());if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('Неверная дата');if(Number.isNaN(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)fail('Неверная дата');const bounds=periodBounds(period,date);const all=await allSessions(ids);const review=admin?await query("SELECT * FROM review_events WHERE status='pending' ORDER BY created DESC LIMIT 200"):await query("SELECT * FROM review_events WHERE person_id=? AND status='pending' ORDER BY created DESC LIMIT 200",me.id);const tracking=Object.fromEntries(await Promise.all(ids.map(async id=>{const c=await controlState(id);return [id,{paused:!!c&&c.kind!=='resume',at:c?.at}]})));const blocks=ids.length?await query(`SELECT id,person_id,project_id,start,end,note FROM work_blocks WHERE person_id IN (${ids.map(()=>'?').join(',')}) AND start<? AND end>? ORDER BY start`,...ids,bounds.to,bounds.from):[];const shotTimes=admin?(ids.length?await query(`SELECT person_id,taken_at FROM screenshots WHERE person_id IN (${ids.map(()=>'?').join(',')}) AND taken_at>=? AND taken_at<? ORDER BY taken_at`,...ids,bounds.from,bounds.to):[]):(await query('SELECT taken_at FROM screenshots WHERE person_id=? AND taken_at>=? AND taken_at<? ORDER BY taken_at',me.id,bounds.from,bounds.to)).map(s=>s.taken_at);return json({shotTimes,blocks,review,tracking,backups:admin?await query('SELECT id,created,checksum,bytes,verified FROM backups ORDER BY created DESC LIMIT 10'):[],backupError:admin?(await first("SELECT value FROM settings WHERE key='backup-error'"))?.value:null,me,people:people.map(safePerson),projects,devices:devices.map(d=>({...d,...deviceHealth(d,Date.now())})),sessions:clipSessions(all,bounds.from,bounds.to).map(({event_ids,...s})=>s),current:all.filter(s=>s.open).map(({event_ids,...s})=>s),bounds,serverTime:Date.now(),audit:admin?await query('SELECT a.*,p.name as actor_name FROM audit a LEFT JOIN people p ON a.actor=p.id ORDER BY at DESC LIMIT 30'):[]});}
 if(path==='projects'&&method==='POST'){
  needAdmin();const name=field(b.name,100),id=b.id?field(b.id,80):crypto.randomUUID();
  if(b.active!==undefined&&typeof b.active!=='boolean')fail('Неверное состояние проекта');
  if(id==='none')fail('Нельзя менять системный проект');
  if(b.id&&!await first('SELECT id FROM projects WHERE id=?',id))fail('Проект не найден',404);
  await db().batch([b.id?db().prepare('UPDATE projects SET name=?,active=? WHERE id=?').bind(name,b.active===false?0:1,id):db().prepare('INSERT INTO projects (id,name,active) VALUES (?,?,?)').bind(id,name,b.active===false?0:1),auditStatement(me.id,'project',id,{name,active:b.active!==false})]);
  return json({ok:true,id});
 }
 if(path==='people'&&method==='POST'){
  needAdmin();const login=typeof b.login==='string'&&b.login.trim()?field(b.login,40).toLowerCase():'';
  if(login&&!/^[a-z][a-z0-9_-]{0,39}$/.test(login))fail('Логин: строчные латинские буквы, цифры и дефис');
  const id=b.id?field(b.id,80):(login||crypto.randomUUID()),name=field(b.name);
  if(!['admin','member'].includes(b.role))fail('Неверная роль');
  if(b.active!==undefined&&typeof b.active!=='boolean')fail('Неверное состояние сотрудника');
  const existing=await first('SELECT * FROM people WHERE id=?',id);
  if(b.id&&!existing)fail('Сотрудник не найден',404);
  if(!b.id&&existing)fail('Такой логин уже занят',409);
  if(existing?.role==='owner')fail('Профиль владельца изменяется только владельцем в личной анкете',403);
  if(existing?.id===me.id&&(b.active===false||b.role!==me.role))fail('Нельзя отключить себя или изменить собственную роль');
  const active=b.active===false?0:1,digest=existing?null:await codeHash(defaultPassword);
  await db().batch([
   existing?db().prepare('UPDATE people SET name=?,role=?,active=?,auth_version=auth_version+? WHERE id=?').bind(name,b.role,active,active?0:1,id):db().prepare('INSERT INTO people (id,name,role,active,created,code_hash) VALUES (?,?,?,?,?,?)').bind(id,name,b.role,active,Date.now(),digest),
   ...(active?[]:[db().prepare('DELETE FROM logins WHERE person_id=?').bind(id),db().prepare('UPDATE login_codes SET used=1 WHERE person_id=?').bind(id),db().prepare('UPDATE devices SET active=0 WHERE person_id=?').bind(id),eventStatement(id,'admin','none','revoke',Date.now())]),
   auditStatement(me.id,'person',id,{name,role:b.role,active:!!active})
  ]);return json({ok:true,id});
 }
 if(path==='access-code'&&method==='POST'){
  needAdmin();const id=field(b.id,80);const target=await first('SELECT * FROM people WHERE id=?',id);
  if(!target)fail('Сотрудник не найден',404);
  if(target.role==='owner'&&me.role!=='owner')fail('Код владельца меняет только владелец',403);
  const code=token().slice(0,20),digest=await codeHash(code);
  await db().batch([
   db().prepare('UPDATE people SET code_hash=?,auth_version=auth_version+1 WHERE id=?').bind(digest,id),
   db().prepare('DELETE FROM logins WHERE person_id=? AND hash<>?').bind(id,loginHash),
   db().prepare('UPDATE logins SET auth_version=(SELECT auth_version FROM people WHERE id=?) WHERE person_id=? AND hash=?').bind(id,id,loginHash),
   db().prepare('UPDATE login_codes SET used=1 WHERE person_id=?').bind(id),
   db().prepare('UPDATE devices SET active=0 WHERE person_id=?').bind(id),
   eventStatement(id,'admin','none','stop',Date.now()),
   auditStatement(me.id,'rotate-code',id,{sessionsRevoked:true,emailCodesRevoked:true})
  ]);return json({code,name:target.name,id});
 }
 if(path==='devices'&&method==='POST'){if(!me.onboarded)fail('Сначала заполните личную анкету');const id=crypto.randomUUID();await run('INSERT INTO devices (id,person_id,name,created) VALUES (?,?,?,?)',id,me.id,field(b.name),Date.now());return json({id,personId:me.id,name:me.name,serverTime:Date.now()});}
 if(path==='device/revoke'&&method==='POST'){
  const d=await first('SELECT * FROM devices WHERE id=?',field(b.id,80));if(!d||(!admin&&d.person_id!==me.id))fail('Нет доступа',403);
  await db().batch([db().prepare('UPDATE devices SET active=0 WHERE id=?').bind(d.id),eventStatement(d.person_id,d.id,'none','device-stop',Date.now()),auditStatement(me.id,'device-revoke',d.id,{})]);return json({ok:true});
 }
 if(path==='tracking'&&method==='POST'){if(b.personId&&b.personId!==me.id)fail('Выбран другой сотрудник',403);if(!me.onboarded)fail('Сначала заполните анкету');if(!['stop','resume'].includes(b.action))fail('Неверное действие');const kind=b.action;let at=Date.now();if(kind==='stop'&&b.at!==undefined){const d=await first('SELECT id FROM devices WHERE id=? AND person_id=? AND active=1',field(b.deviceId,80),me.id);if(!d||!Number.isSafeInteger(b.at)||b.at>at+5000||b.at<at-7*86400000)fail('Проверьте устройство и время остановки');at=Math.min(at,b.at);}await db().batch([eventStatement(me.id,'web','none',kind,at),auditStatement(me.id,'tracking-'+kind,me.id,{})]);return json({ok:true});}
 if(path==='heartbeat'&&method==='POST'){if(!me.onboarded)fail('Заполните анкету');const d=await first('SELECT id FROM devices WHERE id=? AND person_id=? AND active=1',field(b.deviceId,80),me.id);if(!d||b.personId!==me.id)fail('Устройство отключено или выбран другой сотрудник',403);const count=(n:any)=>Number.isSafeInteger(n)&&n>=0?Math.min(n,30000):0;await run('UPDATE devices SET last_seen=?,pending_count=?,review_count=?,status=?,extension_version=?,clock_offset=? WHERE id=?',Date.now(),count(b.pending),count(b.quarantine),['ok','clock','auth','paused'].includes(b.status)?b.status:'ok',typeof b.version==='string'?b.version.slice(0,30):'',Number.isFinite(b.offset)?Math.round(b.offset):0,d.id);await dailyBackup();return json({ok:true,serverTime:Date.now()});}
 if(path==='events'&&method==='POST'){if(!me.onboarded)fail('Заполните анкету');const device=await first('SELECT * FROM devices WHERE id=? AND person_id=? AND active=1',field(b.deviceId,80),me.id);if(!device||b.personId!==me.id)fail('Устройство отключено или выбран другой сотрудник',403);if(!Array.isArray(b.events)||b.events.length>100||b.events.some((e:any)=>!e||typeof e.id!=='string'||!e.id||e.id.length>80))fail('Неверный пакет событий');const result=await ingestEvents(me.id,device,b.events);await run('UPDATE devices SET last_seen=? WHERE id=?',Date.now(),device.id);return json({ok:true,...result});}
 if(path==='review'&&method==='POST'){
  needAdmin();const id=field(b.id,80),resolution=field(b.reason,500);
  const item=await first("SELECT * FROM review_events WHERE id=? AND status='pending'",id);if(!item)fail('Событие уже рассмотрено',409);
  if(!['dismiss','accept'].includes(b.action))fail('Неверное решение');
  let result;
  if(b.action==='accept'){
   const at=b.at;if(!Number.isSafeInteger(at)||at>Date.now()||at<Date.now()-7*86400000)fail('Время должно быть в пределах последних семи дней');
   const access=await first('SELECT d.active AS device_active,d.created,p.active AS person_active FROM devices d JOIN people p ON p.id=d.person_id WHERE d.id=?',item.device_id);
   if(!access?.device_active||!access.person_active)fail('Доступ сотрудника или устройства отозван');
   if(at<access.created-5000)fail('Событие раньше подключения устройства');
   const stop=await controlState(item.person_id,at);if(stop&&stop.kind!=='resume')fail('В это время учёт был остановлен');
   result=await db().batch([
    db().prepare(`INSERT INTO events (id,person_id,device_id,project_id,kind,at,received)
      SELECT r.id,r.person_id,r.device_id,r.project_id,'activity',?,MAX(?,COALESCE((SELECT MAX(received)+1 FROM events WHERE person_id=r.person_id),?))
      FROM review_events r JOIN devices d ON d.id=r.device_id JOIN people p ON p.id=r.person_id
      WHERE r.id=? AND r.status='pending' AND d.active=1 AND p.active=1
      AND COALESCE((SELECT kind FROM events WHERE person_id=r.person_id AND kind IN ('stop','resume','revoke') AND at<=? ORDER BY at DESC,received DESC,id DESC LIMIT 1),'resume')='resume'`).bind(at,Date.now(),Date.now(),id,at),
    db().prepare("UPDATE review_events SET status='accepted',resolved=?,actor=?,resolution=? WHERE id=? AND status='pending' AND changes()>0").bind(Date.now(),me.id,resolution,id),
    auditStatement(me.id,'review-accept',id,{reason:resolution,at},true)
   ]);
  }else result=await db().batch([
   db().prepare("UPDATE review_events SET status='dismissed',resolved=?,actor=?,resolution=? WHERE id=? AND status='pending'").bind(Date.now(),me.id,resolution,id),
   auditStatement(me.id,'review-dismiss',id,{reason:resolution},true)
  ]);
  if(!result[0].meta.changes)fail('Событие уже рассмотрено или доступ изменён. Обновите список.',409);
  return json({ok:true});
 }
 if(path==='backup'&&method==='POST'){needAdmin();const saved=await createBackup();await audit(me.id,'backup',saved.id,{});return json(saved);}
 if(path==='backup/download'&&method==='GET'){needAdmin();const {body}=await backupData(field(url.searchParams.get('id'),80));return new Response(body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Content-Disposition':'attachment; filename="Falcon-Time-backup.json"'}});}
 if(path==='manual'&&method==='POST'){needAdmin();const personId=field(b.personId,80),projectId=field(b.projectId,80),reason=field(b.reason,500),start=Number(b.start),end=Number(b.end);if(!await first('SELECT id FROM people WHERE id=?',personId)||!await first('SELECT id FROM projects WHERE id=?',projectId))fail('Сотрудник или проект не найден');if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end>Date.now()||start<0)fail('Проверьте начало и конец');const sessions=await allSessions([personId]);if(sessions.some(x=>x.start<end&&x.end>start))fail('Время пересекается с существующей сессией');const id='manual-'+crypto.randomUUID();const r=await db().batch([db().prepare('INSERT INTO corrections (session_id,person_id,project_id,start,end,original_start,original_end,reason,actor,updated) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM corrections WHERE person_id=? AND start<? AND end>?)').bind(id,personId,projectId,start,end,start,end,reason,me.id,Date.now(),personId,end,start),auditStatement(me.id,'manual-time',id,{personId,projectId,start,end,reason},true)]);if(!r[0].meta.changes)fail('Другой администратор добавил пересекающийся интервал',409);return json({ok:true,id});}
 if(path==='correction'&&method==='POST'){needAdmin();const id=field(b.sessionId,80),reason=field(b.reason,500);const s=await first('SELECT person_id FROM events WHERE id=? UNION SELECT person_id FROM session_archive WHERE id=? UNION SELECT person_id FROM corrections WHERE session_id=? LIMIT 1',id,id,id);if(!s)fail('Сессия не найдена',404);const start=Number(b.start),end=Number(b.end);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>Date.now())fail('Проверьте начало и конец');const sessions=await allSessions([s.person_id]);const original=sessions.find(x=>x.id===id);if(!original||original.open)fail('Исправлять можно только завершённую сессию');if(sessions.some(x=>x.id!==id&&x.start<end&&x.end>start))fail('Время пересекается с другой сессией');const changedAt=Date.now();const changeId=crypto.randomUUID();const result=await db().batch([
 db().prepare('INSERT INTO corrections (session_id,person_id,project_id,start,end,original_start,original_end,reason,actor,updated) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM corrections WHERE person_id=? AND session_id<>? AND start<? AND end>?) ON CONFLICT(session_id) DO UPDATE SET start=excluded.start,end=excluded.end,reason=excluded.reason,actor=excluded.actor,updated=excluded.updated').bind(id,s.person_id,original!.project_id,start,end,original!.originalStart||original!.start,original!.originalEnd||original!.end,reason,me.id,changedAt,s.person_id,id,end,start),
 db().prepare('INSERT INTO audit (id,actor,action,target,detail,at) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(changeId,me.id,'correction',id,JSON.stringify({before:original,after:{start,end},reason}),changedAt)
 ]);if(!result[0].meta.changes)fail('Другой администратор изменил пересекающуюся сессию. Обновите журнал.',409);return json({ok:true});}
 if(path==='screenshots'&&method==='GET'){const person=field(url.searchParams.get('person')||me.id,80);await assertCanView(me,admin,person);const date=url.searchParams.get('date')||localDate(Date.now());return json({person,shots:await listScreenshots(person,date)});}
 if(path==='screenshots/file'&&method==='GET'){const id=field(url.searchParams.get('id'),80);const owner=await screenshotOwner(id);await assertCanView(me,admin,owner);const bytes=await screenshotFile(owner,id);return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
 if(path==='work-blocks'&&method==='GET'){const person=field(url.searchParams.get('person')||me.id,80);await assertCanView(me,admin,person);const date=url.searchParams.get('date')||localDate(Date.now());return json({person,blocks:await listWorkBlocks(person,date)});}
 if(path==='work-blocks'&&method==='POST'){
  let payload=b;
  if(!admin){
   const week=thisWeek();
   if(b.delete===true){
    const existing=await first('SELECT person_id,start,end FROM work_blocks WHERE id=?',field(String(b.id??''),80));
    if(!existing)fail('Блок не найден',404);
    if(existing.person_id!==me.id)fail('Нет доступа',403);
    if(existing.start<week.from||existing.end>week.to)fail('Править можно только текущую неделю',403);
   }else{
    if(b.personId&&b.personId!==me.id)fail('Нет доступа',403);
    const start=Number(b.start),end=Number(b.end);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start)fail('Проверьте начало и конец');
    if(start<week.from||end>week.to)fail('Править можно только текущую неделю',403);
    payload={...b,personId:me.id};
   }
  }
  return json(await writeWorkBlock(me.id,payload));
 }
 if(path==='pay'&&method==='GET'){
  needAdmin();const period=url.searchParams.get('period')||'day';if(!['day','week','month','year'].includes(period))fail('Неверный период');
  const date=url.searchParams.get('date')||localDate(Date.now());if(!validDate(date))fail('Неверная дата');
  return json(await payView(period,date));
 }
 if(path==='pay'&&method==='POST'){
  needAdmin();
  try{
   if(b.kind==='rate'){
    const cents=usdCents(b.usd,10000);if(cents==null)fail('Ставка: число больше нуля, до двух знаков, не больше 10 000');
    return json(await saveRate(me.id,field(b.personId,80),cents,field(b.from,10)));
   }
   if(b.kind==='budget'){
    const cents=usdCents(b.usd,10000000);if(cents==null)fail('Лимит: число больше нуля, до двух знаков');
    return json(await saveBudget(me.id,field(b.projectId,80),cents,field(b.start,10),field(b.end,10)));
   }
  }catch(e){fail(e instanceof Error?e.message:'Не удалось сохранить');}
  fail('Неверный запрос');
 }
 return json({error:'Не найдено'},404);
}
export const GET=apiBoundary(handle);export const POST=GET;export const PUT=GET;export const PATCH=GET;export const DELETE=GET;
