import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
const realNow=Date.now;let now=Date.parse('2026-09-30T16:00:00Z');Date.now=()=>now;
let sqlite;
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
 now=Date.parse('2026-09-30T16:00:00Z');sqlite?.close();sqlite=new DatabaseSync(':memory:');
 for(const f of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+f,'utf8'));
 Object.assign(globalThis.__falconEnv,{
  DB:{prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},
  BUCKET:{head:async()=>null,put:async()=>{},get:async()=>null},
  SHOTS:{put:async()=>{},get:async()=>null,head:async()=>null},
 });
});
after(()=>{Date.now=realNow;sqlite?.close();});
async function json(path,{body,cookie=''}={}){
 globalThis.__falconHeaders={'oai-authenticated-user-id':'owner-platform','oai-authenticated-user-email':'owner@example.test'};
 const req=new Request('https://falcon.test/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json','Origin':'https://falcon.test'}:{}),Cookie:cookie},body:body?JSON.stringify(body):undefined});
 const response=await(body?POST:GET)(req);
 return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function setup(){
 await json('bootstrap');
 const r=await json('login',{body:{id:'admin',code:'1234'}});
 assert.equal(r.status,200);
 await json('profile',{cookie:r.cookie,body:{name:'Администратор',email:'admin@example.test',job:'Инженер',equipment:'Mac',timezone:'America/New_York',consent:true}});
 return r.cookie;
}
async function member(owner){
 const code=await json('access-code',{cookie:owner,body:{id:'daniil'}});
 const login=await json('login',{body:{id:'daniil',code:code.data.code}});
 assert.equal(login.status,200);
 return login.cookie;
}

test('hourly rate prices screenshot time and does not rewrite earlier hours',async()=>{
 const admin=await setup();
 sqlite.prepare('INSERT INTO screenshots (id,person_id,taken_at,bytes,sha256,width,height) VALUES (?,?,?,?,?,?,?)').run('shot1','daniil',now,10,'abc',1280,720);
 sqlite.prepare('INSERT INTO work_blocks (id,person_id,project_id,start,end,note,actor,updated) VALUES (?,?,?,?,?,?,?,?)').run('block1','daniil','homekept',now-3600000,now+3600000,'','admin',now);
 const early=await json('pay',{cookie:admin,body:{kind:'rate',personId:'daniil',usd:'60',from:'2026-09-01'}});
 assert.equal(early.status,200);
 const back=await json('pay',{cookie:admin,body:{kind:'rate',personId:'daniil',usd:'10',from:'2026-08-01'}});
 assert.equal(back.status,400);
 const later=await json('pay',{cookie:admin,body:{kind:'rate',personId:'daniil',usd:'120',from:'2026-10-01'}});
 assert.equal(later.status,200);
 const budget=await json('pay',{cookie:admin,body:{kind:'budget',projectId:'homekept',usd:'100',start:'2026-09-01',end:'2026-09-30'}});
 assert.equal(budget.status,200);
 const none=await json('pay',{cookie:admin,body:{kind:'budget',projectId:'none',usd:'100',start:'2026-09-01',end:'2026-09-30'}});
 assert.equal(none.status,400);
 const view=await json('pay?period=day&date=2026-09-30',{cookie:admin});
 assert.equal(view.status,200);
 assert.equal(view.data.period.ms,180000);
 assert.equal(view.data.period.cents,300);
 const home=view.data.budgetUse.find(b=>b.project_id==='homekept');
 assert.equal(home.spent_cents,300);
 assert.equal(view.data.budgets.find(b=>b.project_id==='homekept').usd_cents,10000);
 const employee=await member(admin);
 assert.equal((await json('pay?period=day&date=2026-09-30',{cookie:employee})).status,403);
 assert.equal((await json('pay',{cookie:employee,body:{kind:'rate',personId:'daniil',usd:'1',from:'2026-10-02'}})).status,403);
});
