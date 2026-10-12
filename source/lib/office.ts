import {db,first,query,run,auditStatement} from '@/lib/server';
import {fail,json,field} from '@/lib/http';

const OPEN="status IN ('requested','connecting','live')";
const OPEN_STATUSES=new Set(['requested','connecting','live']);
const TTL=2*60*60*1000;
const VIEWER_TTL=20*1000;

async function createOfficeTables(){
 await run(`CREATE TABLE IF NOT EXISTS office_sessions (
  id text PRIMARY KEY NOT NULL,
  person_id text NOT NULL,
  owner_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  error text NOT NULL DEFAULT '',
  member_seen integer NOT NULL DEFAULT 0,
  owner_seen integer NOT NULL DEFAULT 0,
  created integer NOT NULL,
  updated integer NOT NULL
 )`);
 await run('CREATE INDEX IF NOT EXISTS office_session_person ON office_sessions (person_id,status,created)');
 await run(`CREATE TABLE IF NOT EXISTS office_signals (
  id text PRIMARY KEY NOT NULL,
  session_id text NOT NULL,
  sender text NOT NULL,
  type text NOT NULL,
  payload text NOT NULL,
  created integer NOT NULL
 )`);
 await run('CREATE INDEX IF NOT EXISTS office_signal_session ON office_signals (session_id,created)');
}

async function ensureOffice(){
 try{await first('SELECT 1 AS ok FROM office_sessions LIMIT 1');}
 catch{
  try{await createOfficeTables();}
  catch{fail('Домашний офис ещё не готов. Обновите страницу через несколько секунд.',503);}
 }
 try{await run('ALTER TABLE office_sessions ADD COLUMN owner_seen integer NOT NULL DEFAULT 0');}catch{/* колонка уже есть */}
}

function publicSession(row:any,now:number){
 if(!row)fail('Сессия не найдена',404);
 return {id:row.id,personId:row.person_id,ownerId:row.owner_id,kind:row.kind,status:row.status,error:row.error||'',online:row.member_seen>now-12000,created:row.created,updated:row.updated};
}

async function expire(now:number){
 await run(`UPDATE office_sessions SET status='ended',updated=? WHERE ${OPEN} AND created<?`,now,now-TTL);
 await run(`UPDATE office_sessions SET status='ended',updated=? WHERE ${OPEN} AND owner_seen>0 AND owner_seen<?`,now,now-VIEWER_TTL);
 await run(`UPDATE office_sessions SET status='ended',updated=? WHERE ${OPEN} AND owner_seen=0 AND created<?`,now,now-VIEWER_TTL);
}

async function sessionFor(me:any,id:string){
 const row=await first('SELECT * FROM office_sessions WHERE id=?',id);
 if(!row)fail('Сессия не найдена',404);
 if(row.person_id!==me.id&&row.owner_id!==me.id)fail('Нет доступа',403);
 return row;
}

export async function officeHandle(path:string,method:string,url:URL,b:Record<string,any>,me:any){
 const now=Date.now();
 await ensureOffice();
 if(path==='office/watch'&&method==='POST'){
  if(me.role!=='owner'&&me.role!=='admin')fail('Домашний офис открывает владелец или администратор',403);
  const personId=field(b.personId,80),kind=b.kind;
  if(kind!=='camera'&&kind!=='screen')fail('Неверный тип стрима');
  const person=await first('SELECT id,active FROM people WHERE id=?',personId);
  if(!person)fail('Сотрудник не найден',404);
  if(!person.active)fail('Сотрудник отключён',403);
  await expire(now);
  const open=await query(`SELECT id FROM office_sessions WHERE person_id=? AND kind=? AND ${OPEN}`,personId,kind);
  if(open.length>=8)fail('Слишком много одновременных просмотров',409);
  const id=crypto.randomUUID();
  await db().batch([
   db().prepare('INSERT INTO office_sessions (id,person_id,owner_id,kind,status,owner_seen,created,updated) VALUES (?,?,?,?,?,?,?,?)').bind(id,personId,me.id,kind,'requested',now,now,now),
   auditStatement(me.id,'office-watch',id,{personId,kind})
  ]);
  const row=await first('SELECT * FROM office_sessions WHERE id=?',id);
  return json({ok:true,...publicSession(row,now)});
 }
 if(path==='office/inbox'&&method==='GET'){
  await expire(now);
  await run(`UPDATE office_sessions SET member_seen=?,updated=? WHERE person_id=? AND ${OPEN}`,now,now,me.id);
  const sessions=await query(`SELECT * FROM office_sessions WHERE person_id=? AND ${OPEN} ORDER BY created`,me.id);
  return json({sessions:sessions.map((row:any)=>publicSession(row,now)),serverTime:now});
 }
 if(path==='office/session'&&method==='GET'){
  const id=field(url.searchParams.get('id'),80);
  const after=Number(url.searchParams.get('after')||0);
  const row=await sessionFor(me,id);
  if(row.person_id===me.id&&OPEN_STATUSES.has(row.status))await run('UPDATE office_sessions SET member_seen=?,updated=? WHERE id=? AND '+OPEN,now,now,id);
  if(row.owner_id===me.id&&OPEN_STATUSES.has(row.status))await run('UPDATE office_sessions SET owner_seen=?,updated=? WHERE id=? AND '+OPEN,now,now,id);
  const signals=await query('SELECT id,sender,type,payload,created FROM office_signals WHERE session_id=? AND created>=? ORDER BY created,id LIMIT 200',id,Number.isSafeInteger(after)&&after>=0?after:0);
  const fresh=await first('SELECT * FROM office_sessions WHERE id=?',id);
  return json({session:publicSession(fresh,now),signals,serverTime:now});
 }
 if(path==='office/signal'&&method==='POST'){
  const id=field(b.sessionId,80),type=b.type;
  if(!['offer','answer','ice','error','hangup'].includes(type))fail('Неверный сигнал');
  if(typeof b.payload!=='string'||b.payload.length>80000)fail('Неверные данные сигнала');
  const row=await sessionFor(me,id);
  const sender=row.person_id===me.id?'member':'owner';
  if(row.status==='ended'||row.status==='failed')fail('Стрим уже завершён',409);
  if(type==='offer'&&sender!=='member')fail('Предложение стрима отправляет сотрудник',403);
  if(type==='answer'&&sender!=='owner')fail('Ответ на стрим отправляет владелец',403);
  if(type==='offer'&&row.status!=='requested')fail('Предложение уже отправлено',409);
  if(type==='answer'&&row.status!=='connecting')fail('Сначала нужно предложение сотрудника',409);
  const status=type==='offer'?'connecting':type==='answer'?'live':type==='error'?'failed':type==='hangup'?'ended':row.status;
  const error=type==='error'?b.payload.slice(0,200):row.error||'';
  const result=await db().batch([
   db().prepare('INSERT INTO office_signals (id,session_id,sender,type,payload,created) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),id,sender,type,b.payload,now),
   db().prepare(`UPDATE office_sessions SET status=?,error=?,updated=? WHERE id=? AND ${OPEN}`).bind(status,error,now,id),
   ...(type==='hangup'?[auditStatement(me.id,'office-hangup',id,{kind:row.kind})]:[])
  ]);
  if(!result[1].meta.changes&&type!=='ice')fail('Стрим уже завершён',409);
  const fresh=await first('SELECT * FROM office_sessions WHERE id=?',id);
  return json({ok:true,session:publicSession(fresh,now)});
 }
 return null;
}
