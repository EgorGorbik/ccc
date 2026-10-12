import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
const realNow=Date.now;let now=Date.parse('2026-09-30T12:00:00Z');Date.now=()=>now;
let sqlite,mails=[],files,afterStatement=null,failSql=null;
class Statement{
 constructor(sql,args=[]){this.sql=sql;this.args=args;}
 bind(...args){return new Statement(this.sql,args);}
 execute(){if(failSql&&failSql.test(this.sql)){failSql=null;throw new Error('Injected storage failure');}const stmt=sqlite.prepare(this.sql);const results=stmt.all(...this.args);return {results,success:true,meta:{changes:Number(sqlite.prepare('SELECT changes() AS n').get().n)}};}
 async all(){const result=this.execute();if(afterStatement)await afterStatement(this,result);return result;}
 async first(){return (await this.all()).results[0]||null;}
 async run(){return this.all();}
}
globalThis.__falconEnv={};globalThis.__falconHeaders={};
const {GET,POST}=await import('../app/api/[...path]/route.ts');
beforeEach(()=>{now=Date.parse('2026-09-30T12:00:00Z');sqlite?.close();sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+f,'utf8'));files=new Map();mails=[];afterStatement=null;failSql=null;Object.assign(globalThis.__falconEnv,{DB:{prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},BUCKET:{head:async key=>files.has(key)?{key}:null,put:async(key,body)=>files.set(key,body),get:async key=>files.has(key)?{text:async()=>files.get(key)}:null},RESEND_API_KEY:undefined,MAIL_FROM:undefined});});
after(()=>{Date.now=realNow;sqlite?.close();});
async function request(path,{body,cookie='',platform='owner-platform'}={}){globalThis.__falconHeaders=platform?{'oai-authenticated-user-id':platform,'oai-authenticated-user-email':'owner@example.test'}:{};const req=new Request('https://falcon.test/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json','Origin':'https://falcon.test'}:{}),Cookie:cookie},body:body?JSON.stringify(body):undefined});const response=await(body?POST:GET)(req);return {status:response.status,data:await response.json(),headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
async function setup(){await request('bootstrap');const r=await request('login',{body:{id:'admin',code:'1234'}});assert.equal(r.status,200);await profile(r.cookie);return r.cookie;}
async function profile(cookie){return request('profile',{cookie,body:{name:'Тестовый сотрудник',email:'person@example.test',job:'Разработчик',equipment:'Chrome',timezone:'America/New_York',consent:true}});}
async function member(owner,id='daniil'){const code=await request('access-code',{cookie:owner,body:{id}});const login=await request('login',{body:{id,code:code.data.code}});assert.equal(login.status,200);await profile(login.cookie);return login.cookie;}
async function device(cookie){const r=await request('devices',{cookie,body:{name:'Test device'}});assert.equal(r.status,200);return r.data;}
function event(d,seq,at=now,extra={}){return {id:crypto.randomUUID(),kind:'activity',projectId:'homekept',seq,at,clientAt:at,clockOffset:0,clockCheckedAt:d.serverTime,...extra};}
async function send(cookie,d,events){return request('events',{cookie,body:{deviceId:d.id,personId:d.personId,events}});}
test('Real API flow: owner, admin, member, events, role isolation and no duplicate hours',async()=>{
 const owner=await setup(),yura=await member(owner,'yura'),employee=await member(owner);const d=await device(employee);const first=event(d,1);assert.equal((await send(employee,d,[first])).data.accepted.length,1);now+=20*60000;const second=event(d,2);await send(employee,d,[second,first]);now+=40*60000;const report=await request('data',{cookie:employee});assert.equal(report.status,200);assert.equal(report.data.people.length,1);assert.equal(report.data.sessions.length,1);assert.equal(report.data.sessions[0].end-report.data.sessions[0].start,50*60000);assert.equal((await request('data',{cookie:yura})).data.people.length,1);assert.equal((await request('people',{cookie:employee,body:{name:'Intruder',role:'admin'}})).status,403);assert.equal((await request('access-code',{cookie:yura,body:{id:'zafar'}})).status,403);assert.equal((await request('me',{cookie:owner,platform:'another-account'})).status,403);
});
test('One bad event does not block valid events; repeated sequence and time reversal are quarantined',async()=>{
 const owner=await setup(),d=await device(owner);const bad=event(d,1,now,{clockOffset:300000});const good=event(d,2);let r=await send(owner,d,[bad,good]);assert.deepEqual(r.data.accepted,[good.id]);assert.equal(r.data.rejected.length,1);now+=10000;r=await send(owner,d,[event(d,2),event(d,3,now-20000)]);assert.equal(r.data.rejected.length,2);assert.equal((await request('data',{cookie:owner})).data.review.length,3);
});
test('Manual stop suppresses queued activity until explicit resume, including across devices',async()=>{
 const owner=await setup(),a=await device(owner),b=await device(owner);await send(owner,a,[event(a,1)]);now+=10*60000;await request('tracking',{cookie:owner,body:{action:'stop'}});now+=5*60000;assert.equal((await send(owner,b,[event(b,1)])).data.ignored.length,1);now+=5*60000;await request('tracking',{cookie:owner,body:{action:'resume'}});await send(owner,b,[event(b,2)]);now+=5*60000;const report=await request('data',{cookie:owner});assert.equal(report.data.sessions.length,2);assert.equal(report.data.sessions.reduce((n,s)=>n+s.end-s.start,0),15*60000);
});
test('Device and person revocation block state and ingestion',async()=>{
 const owner=await setup(),cookie=await member(owner),d=await device(cookie);await request('device/revoke',{cookie:owner,body:{id:d.id}});assert.equal((await request('extension-state?device='+d.id,{cookie})).status,403);assert.equal((await send(cookie,d,[event(d,1)])).status,403);await request('people',{cookie:owner,body:{id:'daniil',name:'Даниил',role:'member',active:false}});assert.equal((await request('me',{cookie})).status,401);
});
test('Admin review requires reason; accepted event is counted once and decision is audited',async()=>{
 const owner=await setup(),d=await device(owner);const bad=event(d,1,now,{clockOffset:500000});await send(owner,d,[bad]);assert.equal((await request('review',{cookie:owner,body:{id:bad.id,action:'accept',at:now,reason:''}})).status,400);assert.equal((await request('review',{cookie:owner,body:{id:bad.id,action:'accept',at:now,reason:'Часы проверены'}})).status,200);assert.equal((await request('review',{cookie:owner,body:{id:bad.id,action:'accept',at:now,reason:'Повтор'}})).status,409);assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='review-accept'").get().n,1);
});
test('Backup is read-verified, contains business data, excludes live login sessions and is admin-only',async()=>{
 const admin=await setup(),employee=await member(admin);const result=await request('backup',{cookie:admin,body:{}});assert.equal(result.status,200);const download=await request('backup/download?id='+result.data.id,{cookie:admin});assert.equal(download.status,200);assert.equal(download.data.format,'falcon-time-backup');assert.equal(download.data.tables.people.length,4);assert.equal(download.data.tables.logins,undefined);assert.equal((await request('backup',{cookie:employee,body:{}})).status,403);assert.equal((await request('backup/download?id='+result.data.id,{cookie:employee})).status,403);const restored=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())restored.exec(fs.readFileSync('drizzle/'+f,'utf8'));for(const [table,rows] of Object.entries(download.data.tables)){for(const row of rows){const cols=Object.keys(row);restored.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]));}}assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM people').get().n,4);restored.close();
});
test('Email code expires, is single-use, and failed attempts are limited',async()=>{
 const owner=await setup();globalThis.__falconEnv.RESEND_API_KEY='test';globalThis.__falconEnv.MAIL_FROM='test@example.test';const originalFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');mails.push(JSON.parse(options.body));return Response.json({id:'mail'});};try{let r=await request('otp/request',{body:{id:'admin'}});assert.equal(r.status,200);let code=mails.at(-1).text.match(/\b\d{6}\b/)[0];const body={id:'admin',code,challenge:r.data.challenge};assert.equal((await request('login',{body})).status,200);assert.equal((await request('login',{body})).status,401);r=await request('otp/request',{body:{id:'admin'}});code=mails.at(-1).text.match(/\b\d{6}\b/)[0];now+=11*60000;assert.equal((await request('login',{body:{id:'admin',code,challenge:r.data.challenge}})).status,401);}finally{globalThis.fetch=originalFetch;}
});
test('Heartbeats show connectivity without creating time; clock failures visible to owner',async()=>{
 const owner=await setup(),d=await device(owner);await request('heartbeat',{cookie:owner,body:{deviceId:d.id,personId:d.personId,pending:2,quarantine:0,status:'clock',offset:300000,version:'1.1.0'}});const report=await request('data',{cookie:owner});assert.equal(report.data.sessions.length,0);assert.equal(report.data.devices[0].state,'clock');assert.equal(report.data.devices[0].pending_count,2);assert.equal(report.data.backups.length,1);
});
test('Archiving preserves totals and paused state while purging raw events older than 90 days',async()=>{
 const owner=await setup();const old=now-100*86400000;sqlite.prepare('INSERT INTO events (id,person_id,device_id,project_id,kind,at,received) VALUES (?,?,?,?,?,?,?)').run('old-event','admin','old-device','homekept','activity',old,old);sqlite.prepare('INSERT INTO events (id,person_id,device_id,project_id,kind,at,received) VALUES (?,?,?,?,?,?,?)').run('old-stop','admin','old-device','none','stop',old+600000,old+600000);sqlite.prepare("DELETE FROM events WHERE device_id='web'").run();const {allSessions,controlState}=await import('../lib/server.ts');const {archiveHistory}=await import('../lib/archive.ts');const before=await allSessions(['admin']);await archiveHistory(now);const after=await allSessions(['admin']);assert.equal(before.reduce((n,s)=>n+s.end-s.start,0),600000);assert.equal(after.reduce((n,s)=>n+s.end-s.start,0),600000);assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE id='old-event'").get().n,0);assert.equal((await controlState('admin')).kind,'stop');assert.equal((await request('extension-state',{cookie:owner})).data.paused,true);
});
test('Manual intervals require admin, reject overlap and remain editable with audit trail',async()=>{
 const owner=await setup(),employee=await member(owner);const body={personId:'daniil',projectId:'homekept',start:now-7200000,end:now-3600000,reason:'Восстановлено по рабочему журналу'};assert.equal((await request('manual',{cookie:employee,body})).status,403);const result=await request('manual',{cookie:owner,body});assert.equal(result.status,200);assert.equal((await request('manual',{cookie:owner,body})).status,400);const edit=await request('correction',{cookie:owner,body:{sessionId:result.data.id,start:body.start,end:body.end-600000,reason:'Уточнён конец'}});assert.equal(edit.status,200);const report=await request('data',{cookie:employee});assert.equal(report.data.sessions.length,1);assert.equal(report.data.sessions[0].end-report.data.sessions[0].start,3000000);
});
test('An interrupted archive cannot duplicate hours before its checkpoint is committed',async()=>{
 await setup();const start=now-10*86400000;sqlite.prepare('INSERT INTO events (id,person_id,device_id,project_id,kind,at,received) VALUES (?,?,?,?,?,?,?)').run('partially-archived','zafar','old','homekept','activity',start,start);sqlite.prepare('INSERT INTO session_archive (id,person_id,device_id,project_id,start,last,end,reason,event_ids) VALUES (?,?,?,?,?,?,?,?,?)').run('partially-archived','zafar','old','homekept',start,start,start+1800000,'idle','[]');const {allSessions}=await import('../lib/server.ts');const sessions=await allSessions(['zafar']);assert.equal(sessions.reduce((n,s)=>n+s.end-s.start,0),1800000);
});

async function withMail(fn){
 const originalFetch=globalThis.fetch;globalThis.__falconEnv.RESEND_API_KEY='test';globalThis.__falconEnv.MAIL_FROM='test@example.test';
 globalThis.fetch=async(_url,options)=>{mails.push(JSON.parse(options.body));return Response.json({id:'mail'});};
 try{return await fn();}finally{globalThis.fetch=originalFetch;}
}
async function mailCode(id){const response=await request('otp/request',{body:{id}});assert.equal(response.status,200);return {id,challenge:response.data.challenge,code:mails.at(-1).text.match(/\b\d{6}\b/)[0]};}

test('Code rotation invalidates outstanding OTP, old sessions and devices atomically',async()=>{
 const owner=await setup(),employee=await member(owner),d=await device(employee);
 await withMail(async()=>{
  const otp=await mailCode('daniil');
  const rotated=await request('access-code',{cookie:owner,body:{id:'daniil'}});assert.equal(rotated.status,200);
  assert.equal((await request('login',{body:otp})).status,401);
  assert.equal((await request('me',{cookie:employee})).status,401);
  assert.equal(sqlite.prepare('SELECT active FROM devices WHERE id=?').get(d.id).active,0);
  assert.equal((await request('login',{body:{id:'daniil',code:rotated.data.code}})).status,200);
  const self=await request('access-code',{cookie:owner,body:{id:'admin'}});assert.equal(self.status,200);
  assert.equal((await request('me',{cookie:owner})).status,200);
 });
});
test('A storage error rolls back code rotation and its revocations',async()=>{
 const owner=await setup(),employee=await member(owner),d=await device(employee);
 const before=sqlite.prepare('SELECT code_hash,auth_version FROM people WHERE id=?').get('daniil');
 failSql=/INSERT INTO audit/;
 assert.equal((await request('access-code',{cookie:owner,body:{id:'daniil'}})).status,503);
 assert.deepEqual(sqlite.prepare('SELECT code_hash,auth_version FROM people WHERE id=?').get('daniil'),before);
 assert.equal((await request('me',{cookie:employee})).status,200);
 assert.equal(sqlite.prepare('SELECT active FROM devices WHERE id=?').get(d.id).active,1);
});
test('Disabling and re-enabling a person cannot revive old email codes',async()=>{
 const owner=await setup();await member(owner);
 await withMail(async()=>{const otp=await mailCode('daniil');
  for(const active of [false,true])assert.equal((await request('people',{cookie:owner,body:{id:'daniil',name:'Даниил',role:'member',active}})).status,200);
  assert.equal((await request('login',{body:otp})).status,401);
 });
});
test('Changing email invalidates codes issued to the old mailbox',async()=>{
 const owner=await setup();await withMail(async()=>{const otp=await mailCode('admin');
  const update=await request('profile',{cookie:owner,body:{name:'Владелец',email:'new@example.test',job:'Директор',equipment:'Chrome',timezone:'America/New_York',consent:true}});assert.equal(update.status,200);
  assert.equal((await request('login',{body:otp})).status,401);
 });
});
test('Concurrent OTP redemption creates exactly one login',async()=>{
 await setup();await withMail(async()=>{const otp=await mailCode('admin');const before=sqlite.prepare('SELECT COUNT(*) AS n FROM logins').get().n;
  const outcomes=await Promise.all([request('login',{body:otp}),request('login',{body:otp})]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,401]);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM logins').get().n,before+1);
 });
});
test('Password change keeps the current session and rolls back when the audit write fails',async()=>{
 const cookie=await setup();
 assert.equal((await request('password',{cookie,body:{current:'0000',next:'5678'}})).status,401);
 const before=sqlite.prepare("SELECT code_hash FROM people WHERE id='admin'").get().code_hash;
 failSql=/INSERT INTO audit/;
 assert.equal((await request('password',{cookie,body:{current:'1234',next:'5678'}})).status,503);
 assert.equal(sqlite.prepare("SELECT code_hash FROM people WHERE id='admin'").get().code_hash,before);
 assert.equal((await request('me',{cookie})).status,200);
 assert.equal((await request('password',{cookie,body:{current:'1234',next:'5678'}})).status,200);
 assert.equal((await request('me',{cookie})).status,200);
 assert.equal((await request('login',{body:{id:'admin',code:'1234'}})).status,401);
 assert.equal((await request('login',{body:{id:'admin',code:'5678'}})).status,200);
});
test('Login rate limits report retry delay, then expire',async()=>{
 await setup();for(let n=0;n<5;n++)assert.equal((await request('login',{body:{id:'zafar',code:'wrong-code'}})).status,401);
 const blocked=await request('login',{body:{id:'zafar',code:'1234'}});assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'900');
 now+=900001;assert.equal((await request('login',{body:{id:'zafar',code:'1234'}})).status,200);
});
test('Late offline events preserve the automatic tail outside a corrected interval',async()=>{
 const owner=await setup(),d=await device(owner),t=now,first=event(d,1,t);await send(owner,d,[first]);now=t+40*60000;
 assert.equal((await request('correction',{cookie:owner,body:{sessionId:first.id,start:t,end:t+10*60000,reason:'Проверено'}})).status,200);
 now=t+60*60000;await send(owner,d,[event(d,4,now)]);now=t+100*60000;
 assert.equal((await request('data',{cookie:owner})).data.sessions.reduce((n,s)=>n+s.end-s.start,0),40*60000);
 const late=await send(owner,d,[event(d,2,t+20*60000),event(d,3,t+40*60000)]);assert.equal(late.data.accepted.length,2);
 const sessions=(await request('data',{cookie:owner})).data.sessions;
 assert.equal(sessions.reduce((n,s)=>n+s.end-s.start,0),70*60000);
 assert.ok(sessions.some(s=>s.start===t+30*60000&&s.end===t+90*60000));
 assert.equal(sessions.filter(s=>s.corrected).length,1);
});
test('Parallel device events cannot bypass sequence chronology validation',async()=>{
 const owner=await setup(),d=await device(owner);now+=20000;let arrivals=0,release;const barrier=new Promise(resolve=>release=resolve);
 afterStatement=async statement=>{if(statement.sql==='SELECT id FROM events WHERE device_id=? AND seq=?'){if(++arrivals===2)release();await barrier;}};
 const a=event(d,1,now),b=event(d,2,now-10000);
 const result=await Promise.all([send(owner,d,[a]),send(owner,d,[b])]);afterStatement=null;
 assert.equal(result.reduce((n,r)=>n+r.data.accepted.length,0),1);
 assert.equal(result.reduce((n,r)=>n+r.data.rejected.length,0),1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM review_events WHERE status='pending'").get().n,1);
});
test('Duplicate parallel delivery acknowledges one persisted event without double time',async()=>{
 const owner=await setup(),d=await device(owner),e=event(d,1);
 const responses=await Promise.all([send(owner,d,[e]),send(owner,d,[e])]);assert.ok(responses.every(r=>r.data.accepted.includes(e.id)));
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE id=?').get(e.id).n,1);
});
test('Concurrent review decisions have one winner and one audit record',async()=>{
 const owner=await setup(),d=await device(owner),e=event(d,1,now,{clockOffset:500000});await send(owner,d,[e]);
 const result=await Promise.all(['accept','dismiss'].map(action=>request('review',{cookie:owner,body:{id:e.id,action,at:now,reason:'Проверено'}})));
 assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=? AND action LIKE 'review-%'").get(e.id).n,1);
});
test('A recent manual backup does not postpone archive maintenance',async()=>{
 const owner=await setup(),old=now-100*86400000;
 sqlite.prepare('INSERT INTO events (id,person_id,device_id,project_id,kind,at,received) VALUES (?,?,?,?,?,?,?)').run('old-for-maintenance','zafar','old','homekept','activity',old,old);
 assert.equal((await request('backup',{cookie:owner,body:{}})).status,200);
 const {dailyBackup}=await import('../lib/backup.ts');await dailyBackup();
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE id='old-for-maintenance'").get().n,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM session_archive WHERE id='old-for-maintenance'").get().n,1);
 assert.equal(Number(sqlite.prepare("SELECT value FROM settings WHERE key='maintenance-at'").get().value),now);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM backups').get().n,1);
});
test('Readiness is admin-only and detects schema and storage failures without writes',async()=>{
 const owner=await setup(),employee=await member(owner);
 assert.equal((await request('readiness',{cookie:employee})).status,403);
 const ready=await request('readiness',{cookie:owner});assert.equal(ready.status,200);assert.equal(ready.data.ready,true);assert.ok(ready.data.warnings.includes('email_not_configured_personal_codes_available'));assert.equal(files.size,0);
 const bucket=globalThis.__falconEnv.BUCKET;globalThis.__falconEnv.BUCKET=undefined;
 const missing=await request('readiness',{cookie:owner});assert.equal(missing.status,503);assert.equal(missing.data.checks.storage,'not_configured');globalThis.__falconEnv.BUCKET=bucket;
 sqlite.exec('DROP TABLE session_archive');const schema=await request('readiness',{cookie:owner});assert.equal(schema.status,503);assert.equal(schema.data.checks.database,'migration_required');
});
test('Methods, JSON and streamed body size are validated with safe error identifiers',async()=>{
 const owner=await setup();const wrong=await request('events',{cookie:owner});assert.equal(wrong.status,405);assert.equal(wrong.headers.get('allow'),'POST');assert.ok(wrong.data.requestId);
 const unknown=await request('unknown',{cookie:owner});assert.equal(unknown.status,404);
 for(const [body,contentType,expected] of [['{','application/json',400],['[]','application/json',400],['{}','application/json-malicious',415],['"'+'x'.repeat(100001)+'"','application/json',413]]){
  const response=await POST(new Request('https://falcon.test/api/projects',{method:'POST',headers:{Cookie:owner,Origin:'https://falcon.test','Content-Type':contentType},body}));assert.equal(response.status,expected);assert.ok(response.headers.get('X-Request-ID'));assert.equal(response.headers.get('Cache-Control'),'no-store');
 }
 const cross=await POST(new Request('https://falcon.test/api/projects',{method:'POST',headers:{Cookie:owner,Origin:'https://hostile.test','Content-Type':'application/json'},body:'{}'}));assert.equal(cross.status,403);
});
test('Access schemas reject nonexistent records and preserve owner authority',async()=>{
 const owner=await setup();assert.equal((await request('projects',{cookie:owner,body:{id:'missing',name:'Нет'}})).status,404);
 assert.equal((await request('people',{cookie:owner,body:{name:'Bad role',role:'owner'}})).status,400);
 assert.equal((await request('people',{cookie:owner,body:{id:'missing',name:'Нет',role:'member'}})).status,404);
 const newPerson=await request('people',{cookie:owner,body:{name:'Отключён',role:'member',active:false}});assert.equal(newPerson.status,200);
 assert.equal(sqlite.prepare('SELECT active FROM people WHERE id=?').get(newPerson.data.id).active,0);
 const me=await request('me',{cookie:owner});assert.equal(me.data.me.code_hash,undefined);assert.equal(me.data.me.auth_version,undefined);assert.equal(me.data.me.has_code,true);
});

test('A login already in flight cannot recreate a revoked session',async()=>{
 const owner=await setup(),old=await request('access-code',{cookie:owner,body:{id:'daniil'}});
 let reached,release;const selected=new Promise(r=>reached=r),continueLogin=new Promise(r=>release=r);
 afterStatement=async statement=>{if(statement.sql==='SELECT * FROM people WHERE id=? AND active=1'&&statement.args[0]==='daniil'){afterStatement=null;reached();await continueLogin;}};
 const login=request('login',{body:{id:'daniil',code:old.data.code}});await selected;
 assert.equal((await request('access-code',{cookie:owner,body:{id:'daniil'}})).status,200);release();
 assert.equal((await login).status,401);assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM logins WHERE person_id='daniil'").get().n,0);
});
test('The exported backup restores through the actual CLI without reviving device access',async()=>{
 const owner=await setup(),employee=await member(owner);await device(employee);
 const saved=await request('backup',{cookie:owner,body:{}});const backup=await request('backup/download?id='+saved.data.id,{cookie:owner});
 const {mkdtempSync,writeFileSync,rmSync}=fs;const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'falcon-restore-'));
 try{
  const source=join(dir,'backup.json'),target=join(dir,'restored.sqlite');writeFileSync(source,JSON.stringify(backup.data));
  const result=spawnSync('python',['scripts/restore-backup.py',source,target],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const restored=new DatabaseSync(target);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM devices WHERE active=1').get().n,0);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM logins').get().n,0);
  assert.equal(restored.prepare("SELECT code_hash FROM people WHERE id='daniil'").get().code_hash,null);
  assert.equal(restored.prepare("SELECT code_hash FROM people WHERE id='zafar'").get().code_hash,null);
  assert.ok(restored.prepare("SELECT code_hash FROM people WHERE id='admin'").get().code_hash);restored.close();
  assert.notEqual(spawnSync('python',['scripts/restore-backup.py',source,target]).status,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('A failed audit write rolls back a manual time correction',async()=>{
 const owner=await setup();failSql=/INSERT INTO audit/;
 const result=await request('manual',{cookie:owner,body:{personId:'zafar',projectId:'homekept',start:now-7200000,end:now-3600000,reason:'Проверка атомарности'}});
 assert.equal(result.status,503);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM corrections').get().n,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='manual-time'").get().n,0);
});
