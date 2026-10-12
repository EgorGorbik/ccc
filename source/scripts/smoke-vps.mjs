// Exercises the built production server with isolated disposable data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=path.resolve(process.argv[2]||'.next/standalone');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'falcon-http-'));
const secret=randomBytes(32).toString('hex');fs.writeFileSync(path.join(temporary,'owner'),secret,{mode:0o600});
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const origin='https://falconai.time';const address='http://127.0.0.1:'+port;let child,output='';
async function start(){
 child=spawn(process.execPath,['server/entrypoint.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'production',PORT:String(port),HOSTNAME:'127.0.0.1',FALCON_ORIGIN:origin,FALCON_DATA_DIR:path.join(temporary,'data'),FALCON_BACKUP_DIR:path.join(temporary,'backups'),FALCON_OWNER_CODE_FILE:path.join(temporary,'owner')},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
 for(let i=0;i<150;i++){
  if(child.exitCode!==null)throw new Error('Server exited: '+output);
  try{if((await fetch(address+'/healthz')).ok)return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 throw new Error('Startup timeout: '+output);
}
async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
async function api(endpoint,{body,cookie='',ip='203.0.113.2',extra={}}={}){
 const response=await fetch(address+'/api/'+endpoint,{method:body?'POST':'GET',headers:{Host:'falconai.time','X-Forwarded-Proto':'https','X-Real-IP':ip,Cookie:cookie,...(body?{'Content-Type':'application/json',Origin:origin}:{}),...extra},body:body?JSON.stringify(body):undefined});
 const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
try{
 await start();
 assert.equal((await fetch(address+'/')).status,200);
 const bootstrap=await api('bootstrap');assert.equal(bootstrap.data.selfHosted,true);assert.equal(bootstrap.data.setup,false);assert.deepEqual(bootstrap.data.people,[]);
 assert.equal((await api('setup',{body:{code:secret}})).status,403);
 assert.equal((await api('data',{extra:{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'forged@example.test'}})).status,401);
 for(let i=0;i<5;i++)assert.equal((await api('login',{ip:'203.0.113.1',body:{id:'zafar',code:'incorrect'}})).status,401);
 assert.equal((await api('login',{ip:'203.0.113.1',body:{id:'zafar',code:secret}})).status,429);
 const login=await api('login',{body:{id:'zafar',code:secret}});assert.equal(login.status,200);const cookie=login.cookie;
 assert.match(login.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
 assert.equal((await api('projects',{cookie,body:{name:'Blocked'},extra:{Origin:'https://attacker.test'}})).status,403);
 const project=await api('projects',{cookie,body:{name:'VPS smoke test'}});assert.equal(project.status,200);
 const code=await api('access-code',{cookie,body:{id:'daniil'}});assert.equal(code.status,200);
 const employee=await api('login',{body:{id:'daniil',code:code.data.code}});assert.equal(employee.status,200);
 assert.equal((await api('data',{cookie:employee.cookie})).data.people.length,1);
 assert.equal((await api('projects',{cookie:employee.cookie,body:{name:'Not allowed'}})).status,403);
 const backup=await api('backup',{cookie,body:{}});assert.equal(backup.status,200);
 const exported=await api('backup/download?id='+backup.data.id,{cookie});assert.equal(exported.data.version,1);assert(exported.data.tables.projects.some(p=>p.id===project.data.id));
 assert.equal((await api('readiness',{cookie})).data.ready,true);
 await stop();await start();
 assert.equal((await api('me',{cookie})).status,200);
 assert((await api('data',{cookie})).data.projects.some(p=>p.id===project.data.id));
 assert.equal((await api('backup/download?id='+backup.data.id,{cookie})).data.version,1);
 const manifest=await(await fetch(address+'/extension/manifest.json')).json();assert.equal(manifest.version,'1.2.0');assert(manifest.host_permissions.includes(origin+'/*'));assert(!JSON.stringify(manifest).includes('chatgpt.site'));
 assert.equal((await fetch(address+'/falcon-time-extension.zip')).status,200);
 console.log('Production VPS HTTP smoke passed: private data, header forgery, owner setup protection, per-IP rate limit, Secure cookie, proxy origin, role isolation, persistent SQLite and backup after restart, extension origin.');
}finally{await stop();fs.rmSync(temporary,{recursive:true,force:true});}
