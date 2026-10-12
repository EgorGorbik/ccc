const ORIGIN='https://falconai.time';
const VERSION='1.2.0';let chain=Promise.resolve();
function serial(fn){const result=chain.then(fn,fn);chain=result.catch(()=>{});return result;}
async function bridge(path,body){
 const tabs=await chrome.tabs.query({url:ORIGIN+'/*'});if(!tabs.length)throw new Error('Откройте кабинет Falcon Time в отдельной вкладке');
 let lastError;for(const tab of tabs){try{const r=await chrome.tabs.sendMessage(tab.id,{type:'bridge',path,body});if(r?.ok)return r.data;const e=new Error(r?.data?.error||r?.error||'Обновите вкладку кабинета');e.status=r?.status;if(e.status===401||e.status===403)throw e;lastError=e;}catch(e){lastError=e;if(e.status===401||e.status===403)throw e;}}
 throw lastError||new Error('Войдите в свой профиль в кабинете');
}
async function state(){return chrome.storage.local.get({binding:null,queue:[],quarantine:[],maps:{},projectMaps:{},paused:false,authBlocked:false,clockBlocked:false,offset:0,clockCheckedAt:0,nextSeq:1,error:'',projects:[],lastSync:0,pendingStop:null});}
async function heartbeat(s,status='ok'){return bridge('heartbeat',{deviceId:s.binding.id,personId:s.binding.personId,pending:s.queue.length,quarantine:s.quarantine.length,status,version:VERSION,offset:s.offset});}
async function sync(){
 let s=await state();if(!s.binding)return;
 try{
  const info=await bridge('extension-state?device='+encodeURIComponent(s.binding.id));
  if(info.me.id!==s.binding.personId){const e=new Error('Выбран другой сотрудник. Войдите в профиль '+s.binding.name);e.status=403;throw e;}
  const offset=info.serverTime-Date.now();
  if(Math.abs(offset)>120000){await chrome.storage.local.set({clockBlocked:true,error:'Учёт приостановлен: исправьте часы компьютера (расхождение более двух минут).'});await heartbeat({...s,offset},'clock');return;}
  await chrome.storage.local.set({clockBlocked:false,offset,clockCheckedAt:info.serverTime,authBlocked:false,projects:info.projects,error:''});
  if(s.pendingStop){await bridge('tracking',{action:'stop',personId:s.binding.personId,deviceId:s.binding.id,at:s.pendingStop});await chrome.storage.local.set({pendingStop:null});info.paused=true;}
  await chrome.storage.local.set({paused:info.paused});s=await state();
  const invalid=s.queue.filter(e=>!Number.isSafeInteger(e.seq)||Date.now()+offset-e.at>7*86400000);
  if(invalid.length){const ids=new Set(invalid.map(e=>e.id));s.queue=s.queue.filter(e=>!ids.has(e.id));s.quarantine=[...s.quarantine,...invalid.map(e=>({...e,reason:!e.seq?'Событие старой версии расширения':'Старше семи дней'}))];await chrome.storage.local.set({queue:s.queue,quarantine:s.quarantine});}
  // Drain a bounded number of batches; a retry keeps original IDs and sequence numbers.
  for(let n=0;n<5;n++){
   const batch=s.queue.filter(x=>x.personId===s.binding.personId&&x.deviceId===s.binding.id).slice(0,100);if(!batch.length)break;
   const r=await bridge('events',{deviceId:s.binding.id,personId:s.binding.personId,events:batch.map(e=>({id:e.id,at:e.at,seq:e.seq,projectId:e.projectId,kind:'activity',clientAt:e.clientAt,clockOffset:e.clockOffset,clockCheckedAt:e.clockCheckedAt}))});
   const rejected=new Map((r.rejected||[]).map(e=>[e.id,e.reason]));const done=new Set([...(r.accepted||[]),...(r.ignored||[]),...rejected.keys()]);
   s.quarantine.push(...batch.filter(e=>rejected.has(e.id)).map(e=>({...e,reason:rejected.get(e.id),serverReviewed:true})));
   s.queue=s.queue.filter(e=>!done.has(e.id));await chrome.storage.local.set({queue:s.queue,quarantine:s.quarantine,paused:r.paused});if(!done.size)break;
  }
  await heartbeat(s,info.paused?'paused':'ok');await chrome.storage.local.set({lastSync:Date.now(),error:''});
 }catch(e){await chrome.storage.local.set({error:e.message||'Нет связи с кабинетом',...([401,403].includes(e.status)?{authBlocked:true}:{})});}
}
chrome.alarms.create('sync',{periodInMinutes:1});chrome.alarms.onAlarm.addListener(a=>{if(a.name==='sync')serial(sync);});
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
 serial(async()=>{
  if(sender.id&&sender.id!==chrome.runtime.id)return {ok:false};
  if(msg.type==='activity'){
   if(!sender.tab?.url?.startsWith('https://chatgpt.com/')||!Number.isSafeInteger(msg.at))return {ok:false};
   let s=await state();if(!s.binding||s.paused||s.authBlocked||s.clockBlocked||s.pendingStop)return {ok:true};
   if(!s.clockCheckedAt||Date.now()+s.offset-s.clockCheckedAt>7*86400000){await chrome.storage.local.set({clockBlocked:true,error:'Нужна синхронизация с кабинетом'});return {ok:false};}
   const event={id:crypto.randomUUID(),at:msg.at+s.offset,clientAt:msg.at,clockOffset:s.offset,clockCheckedAt:s.clockCheckedAt,seq:s.nextSeq,context:msg.context,projectContext:msg.projectContext||'',projectId:s.maps[msg.context]||s.projectMaps[msg.projectContext]||'none',personId:s.binding.personId,deviceId:s.binding.id};
   if(s.queue.length>=30000){await chrome.storage.local.set({error:'Очередь заполнена. Синхронизируйте кабинет; новое время пока не учитывается.'});return {ok:false};}
   await chrome.storage.local.set({queue:[...s.queue,event],nextSeq:s.nextSeq+1,lastActivity:msg.at});if(Date.now()-s.lastSync>15000)await sync();return {ok:true};
  }
  // Control commands originate only from this extension's popup, never a web tab.
  if(sender.tab)return {ok:false};
  if(msg.type==='open'){const tabs=await chrome.tabs.query({url:ORIGIN+'/*'});if(tabs.length)await chrome.tabs.update(tabs[0].id,{active:true});else await chrome.tabs.create({url:ORIGIN});return {ok:true};}
  if(msg.type==='connect'){
   const s=await state();const info=await bridge('extension-state');if(!info.me.onboarded)throw new Error('Заполните личную анкету в кабинете');const offset=info.serverTime-Date.now();if(Math.abs(offset)>120000)throw new Error('Исправьте часы компьютера перед подключением');
   if(s.binding?.personId===info.me.id){try{await bridge('extension-state?device='+encodeURIComponent(s.binding.id));await sync();return {ok:true};}catch(e){if(e.status!==403)throw e;}}
   const binding=await bridge('devices',{name:msg.name||'Компьютер · Chrome/Edge'});
   await chrome.storage.local.set({binding,paused:info.paused,projects:info.projects,maps:{},projectMaps:{},queue:[],quarantine:[...s.quarantine,...s.queue.map(e=>({...e,reason:'Предыдущее подключение'}))],nextSeq:1,authBlocked:false,clockBlocked:false,offset,clockCheckedAt:info.serverTime,error:'',lastSync:0,pendingStop:null});await sync();return {ok:true};
  }
  if(msg.type==='project'){
   const s=await state();if(!s.projects.some(p=>p.id===msg.projectId)||typeof msg.context!=='string'||!msg.context)throw new Error('Откройте чат и выберите проект');s.maps[msg.context]=msg.projectId;if(msg.projectContext)s.projectMaps[msg.projectContext]=msg.projectId;await chrome.storage.local.set({maps:s.maps,projectMaps:s.projectMaps});return {ok:true};
  }
  if(msg.type==='tracking'){
   const s=await state();if(!s.binding)throw new Error('Сначала подключите устройство');
   if(msg.action==='stop'){await chrome.storage.local.set({paused:true,pendingStop:Date.now()+s.offset});await sync();return {ok:true};}
   const info=await bridge('extension-state?device='+encodeURIComponent(s.binding.id));if(info.me.id!==s.binding.personId)throw new Error('Войдите в исходный профиль');await bridge('tracking',{action:'resume',personId:s.binding.personId});await chrome.storage.local.set({pendingStop:null});await sync();return {ok:true};
  }
  if(msg.type==='sync'){await sync();return {ok:true};}
  if(msg.type==='state'){await sync();return state();}return {ok:false};
 }).then(respond).catch(e=>respond({error:e.message}));return true;
});
