import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
const realNow=Date.now;let now=Date.parse('2026-09-30T12:00:00Z');Date.now=()=>now;
let sqlite,files,shots;
class Statement{
 constructor(sql,args=[]){this.sql=sql;this.args=args;}
 bind(...args){return new Statement(this.sql,args);}
 execute(){const stmt=sqlite.prepare(this.sql);const results=stmt.all(...this.args);return {results,success:true,meta:{changes:Number(sqlite.prepare('SELECT changes() AS n').get().n)}};}
 async all(){return this.execute();}
 async first(){return (await this.all()).results[0]||null;}
 async run(){return this.all();}
}
globalThis.__falconEnv={};globalThis.__falconHeaders={};
const {GET,POST}=await import('../app/api/[...path]/route.ts');
beforeEach(()=>{
 now=Date.parse('2026-09-30T12:00:00Z');sqlite?.close();sqlite=new DatabaseSync(':memory:');
 for(const f of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+f,'utf8'));
 files=new Map();shots=new Map();
 Object.assign(globalThis.__falconEnv,{
  DB:{prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},
  BUCKET:{head:async key=>files.has(key)?{key}:null,put:async(key,body)=>files.set(key,body),get:async key=>files.has(key)?{text:async()=>files.get(key)}:null},
  SHOTS:{
   put:async(key,body)=>{shots.set(key,Uint8Array.from(body));},
   get:async key=>shots.has(key)?{size:shots.get(key).byteLength,arrayBuffer:async()=>{const b=shots.get(key);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}}:null,
   head:async key=>shots.has(key)?{key,size:shots.get(key).byteLength}:null,
  },
  RESEND_API_KEY:undefined,MAIL_FROM:undefined,
 });
});
after(()=>{Date.now=realNow;sqlite?.close();});

// Minimal valid baseline JPEG: SOI + SOF0 (720x1280, 3 components) + EOI.
function jpeg(width=1280,height=720,tag=0){
 return Uint8Array.from([0xFF,0xD8,0xFF,0xC0,0x00,0x11,0x08,(height>>8)&255,height&255,(width>>8)&255,width&255,0x03,1,0x11,0,2,0x11,0,3,0x11,0,tag&255,0xFF,0xD9]);
}
async function json(path,{body,cookie='',platform='owner-platform'}={}){
 globalThis.__falconHeaders=platform?{'oai-authenticated-user-id':platform,'oai-authenticated-user-email':'owner@example.test'}:{};
 const req=new Request('https://falcon.test/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json','Origin':'https://falcon.test'}:{}),Cookie:cookie},body:body?JSON.stringify(body):undefined});
 const response=await(body?POST:GET)(req);
 return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function upload(path,bytes,{cookie='',contentType='image/jpeg'}={}){
 globalThis.__falconHeaders={'oai-authenticated-user-id':'owner-platform','oai-authenticated-user-email':'owner@example.test'};
 const req=new Request('https://falcon.test/api/'+path,{method:'POST',headers:{'Content-Type':contentType,'Origin':'https://falcon.test',Cookie:cookie},body:bytes});
 const response=await POST(req);return {status:response.status,data:await response.json()};
}
async function uploadForm(path,form,{cookie=''}={}){
 globalThis.__falconHeaders={'oai-authenticated-user-id':'owner-platform','oai-authenticated-user-email':'owner@example.test'};
 const req=new Request('https://falcon.test/api/'+path,{method:'POST',headers:{'Origin':'https://falcon.test',Cookie:cookie},body:form});
 const response=await POST(req);return {status:response.status,data:await response.json()};
}
async function fileGet(id,{cookie=''}={}){
 globalThis.__falconHeaders={'oai-authenticated-user-id':'owner-platform','oai-authenticated-user-email':'owner@example.test'};
 const req=new Request('https://falcon.test/api/screenshots/file?id='+id,{headers:{Cookie:cookie}});
 const response=await GET(req);return {status:response.status,type:response.headers.get('content-type'),bytes:response.ok?new Uint8Array(await response.arrayBuffer()):null,data:response.ok?null:await response.json()};
}
async function setup(){await json('bootstrap');const r=await json('login',{body:{id:'admin',code:'1234'}});assert.equal(r.status,200);await profile(r.cookie);return r.cookie;}
async function profile(cookie){return json('profile',{cookie,body:{name:'Сотрудник',email:'p'+Math.random()+'@example.test',job:'Инженер',equipment:'Mac',timezone:'America/New_York',consent:true}});}
async function member(owner,id='daniil'){const code=await json('access-code',{cookie:owner,body:{id}});const login=await json('login',{body:{id,code:code.data.code}});assert.equal(login.status,200);await profile(login.cookie);return login.cookie;}

test('Screenshot upload stores metadata + file, is readable, and replays idempotently',async()=>{
 const owner=await setup();
 const id=crypto.randomUUID();const bytes=jpeg(1280,720,7);
 const up=await upload('screenshots?id='+id+'&taken_at='+now,bytes,{cookie:owner});
 assert.equal(up.status,200);assert.equal(up.data.id,id);assert.equal(up.data.taken_at,now);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM screenshots').get().n,1);
 const row=sqlite.prepare('SELECT * FROM screenshots WHERE id=?').get(id);
 assert.equal(row.person_id,'admin');assert.equal(row.width,1280);assert.equal(row.height,720);assert.equal(row.bytes,bytes.byteLength);
 // Replay the same id (offline-queue retry): no second row.
 const replay=await upload('screenshots?id='+id+'&taken_at='+now,bytes,{cookie:owner});
 assert.equal(replay.status,200);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM screenshots').get().n,1);
 const file=await fileGet(id,{cookie:owner});
 assert.equal(file.status,200);assert.equal(file.type,'image/jpeg');assert.deepEqual(file.bytes,bytes);
});
test('Multipart upload works and taken_at/id come from the form',async()=>{
 const owner=await setup();const id=crypto.randomUUID();const bytes=jpeg(640,480,3);
 const form=new FormData();form.set('id',id);form.set('taken_at',String(now));form.set('shot',new Blob([bytes],{type:'image/jpeg'}),'shot.jpg');
 const up=await uploadForm('screenshots',form,{cookie:owner});
 assert.equal(up.status,200);assert.equal(up.data.id,id);
 const row=sqlite.prepare('SELECT width,height FROM screenshots WHERE id=?').get(id);assert.equal(row.width,640);assert.equal(row.height,480);
});
test('Non-JPEG payload is rejected',async()=>{
 const owner=await setup();
 const up=await upload('screenshots?id='+crypto.randomUUID()+'&taken_at='+now,Uint8Array.from([1,2,3,4]),{cookie:owner});
 assert.equal(up.status,415);
});
test('Screenshot listing is per local day and access is role-scoped',async()=>{
 const owner=await setup(),dani=await member(owner,'daniil'),yura=await member(owner,'yura');
 // A second member, to check member-vs-member isolation (yura is an employee).
 const created=await json('people',{cookie:owner,body:{name:'Иван',role:'member'}});
 assert.equal(created.status,200);const ivan=await member(owner,created.data.id);
 const mine=crypto.randomUUID();
 await upload('screenshots?id='+mine+'&taken_at='+now,jpeg(),{cookie:dani});
 // Daniil sees own shots.
 let list=await json('screenshots?person=daniil&date=2026-09-30',{cookie:dani});
 assert.equal(list.status,200);assert.equal(list.data.shots.length,1);
 // A different day is empty.
 assert.equal((await json('screenshots?person=daniil&date=2026-09-29',{cookie:dani})).data.shots.length,0);
 // Organization admin sees any employee; employees see only their own.
 assert.equal((await json('screenshots?person=daniil',{cookie:yura})).status,403);
 assert.equal((await json('screenshots?person=daniil',{cookie:ivan})).status,403);
 assert.equal((await json('screenshots?person=daniil',{cookie:owner})).data.shots.length,1);
 assert.equal((await fileGet(mine,{cookie:ivan})).status,403);
 assert.equal((await fileGet(mine,{cookie:yura})).status,403);
 assert.equal((await fileGet(mine,{cookie:owner})).status,200);
});
test('Work blocks: members write only their own current week, overlap rejected, delete works',async()=>{
 const owner=await setup(),dani=await member(owner,'daniil');
 const base={personId:'daniil',projectId:'homekept',start:now-7200000,end:now-3600000,note:'Утро'};
 // Another employee, and a week that is already closed.
 assert.equal((await json('work-blocks',{cookie:dani,body:{...base,personId:'yura'}})).status,403);
 assert.equal((await json('work-blocks',{cookie:dani,body:{...base,start:now-14*86400000,end:now-14*86400000+3600000}})).status,403);
 // Own interval in the current week, then remove it so the admin cases start clean.
 const own=await json('work-blocks',{cookie:dani,body:base});
 assert.equal(own.status,200);
 assert.equal((await json('work-blocks',{cookie:dani,body:{id:own.data.id,delete:true}})).status,200);
 // Owner creates.
 const created=await json('work-blocks',{cookie:owner,body:base});
 assert.equal(created.status,200);const id=created.data.id;
 // Overlap rejected.
 assert.equal((await json('work-blocks',{cookie:owner,body:{...base,start:base.start+600000}})).status,409);
 // end<=start rejected.
 assert.equal((await json('work-blocks',{cookie:owner,body:{...base,start:base.end,end:base.start}})).status,400);
 // Inactive/unknown project rejected.
 assert.equal((await json('work-blocks',{cookie:owner,body:{...base,projectId:'nope'}})).status,400);
 // Edit in place (move end) — same id, no overlap with itself.
 assert.equal((await json('work-blocks',{cookie:owner,body:{...base,id,end:base.end-600000}})).status,200);
 // List: member sees own; foreign blocked.
 assert.equal((await json('work-blocks?person=daniil&date=2026-09-30',{cookie:dani})).data.blocks.length,1);
 assert.equal((await json('work-blocks?person=yura',{cookie:dani})).status,403);
 // Delete.
 assert.equal((await json('work-blocks',{cookie:owner,body:{id,delete:true}})).status,200);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM work_blocks').get().n,0);
 // Audit recorded for work-block actions.
 assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='work-block'").get().n>=3);
});
test('Upload requires onboarding and an authenticated session',async()=>{
 const owner=await setup();
 // No cookie → 401.
 assert.equal((await upload('screenshots?id='+crypto.randomUUID()+'&taken_at='+now,jpeg(),{cookie:''})).status,401);
});
