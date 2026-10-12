const CHANNEL='falcon-screen';
const WINDOW_NAME='falcon-screen';
const PAGE='falcon-page';
const EXT='falcon-extension';

function channel(){return new BroadcastChannel(CHANNEL);}

export function extensionPresent(){
 return typeof document!=='undefined'&&document.documentElement.dataset.falconExtension==='1';
}

function talk(type:string,ms=800){
 return new Promise<any>((resolve,reject)=>{
  if(typeof window==='undefined'){reject(new Error('no window'));return;}
  const id=(globalThis.crypto?.randomUUID?.()||String(Date.now()+Math.random()));
  const timer=setTimeout(()=>{window.removeEventListener('message',onMsg);reject(new Error('MISSING'));},ms);
  function onMsg(e:MessageEvent){
   if(e.origin!==location.origin||e.data?.source!==EXT||e.data?.id!==id)return;
   clearTimeout(timer);
   window.removeEventListener('message',onMsg);
   resolve(e.data);
  }
  window.addEventListener('message',onMsg);
  window.postMessage({source:PAGE,type,id},location.origin);
 });
}

function waitEvent(ms=60000){
 return new Promise<boolean>(resolve=>{
  const timer=setTimeout(()=>{window.removeEventListener('message',onMsg);resolve(false);},ms);
  function onMsg(e:MessageEvent){
   if(e.origin!==location.origin||e.data?.source!==EXT||e.data?.type!=='capture-event')return;
   if(e.data.event==='live'){clearTimeout(timer);window.removeEventListener('message',onMsg);resolve(true);}
   if(e.data.event==='ended'||e.data.event==='denied'){clearTimeout(timer);window.removeEventListener('message',onMsg);resolve(false);}
  }
  window.addEventListener('message',onMsg);
 });
}

function pingBroadcast(ms=250){
 return new Promise<boolean>(resolve=>{
  if(typeof window==='undefined'){resolve(false);return;}
  const ch=channel();
  const timer=setTimeout(()=>{ch.close();resolve(false);},ms);
  ch.onmessage=e=>{
   if(e.data?.type==='pong'||e.data?.type==='live'){clearTimeout(timer);ch.close();resolve(true);}
  };
  ch.postMessage({type:'ping'});
 });
}

export function pingScreenHolder(ms=250){
 if(typeof window==='undefined')return Promise.resolve(false);
 if(extensionPresent())return talk('capture-status',ms).then(r=>!!r?.live).catch(()=>false);
 return pingBroadcast(ms);
}

export function onScreenHolder(fn:(live:boolean)=>void){
 if(typeof window==='undefined')return ()=>{};
 const ch=channel();
 const onMsg=(e:MessageEvent)=>{
  if(e.origin!==location.origin||e.data?.source!==EXT)return;
  if(e.data.type==='capture-event')fn(e.data.event==='live');
  if(e.data.live===true)fn(true);
 };
 window.addEventListener('message',onMsg);
 ch.onmessage=e=>{
  if(e.data?.type==='live'||e.data?.type==='pong')fn(true);
  if(e.data?.type==='ended'||e.data?.type==='denied')fn(false);
 };
 if(extensionPresent())void talk('capture-status').then(r=>fn(!!r?.live)).catch(()=>{});
 else ch.postMessage({type:'ping'});
 return ()=>{window.removeEventListener('message',onMsg);ch.close();};
}

function stopBroadcast(){
 if(typeof window==='undefined')return;
 const ch=channel();
 ch.postMessage({type:'stop'});
 ch.close();
 try{window.open('',WINDOW_NAME)?.close();}catch{/* окно уже закрыто */}
}

export function stopScreenHolder(){
 if(extensionPresent())void talk('capture-stop',800).catch(()=>{});
 stopBroadcast();
}

async function openSiteCapture(){
 if(await pingBroadcast())return;
 const popup=window.open('/capture',WINDOW_NAME,'popup=yes,width=440,height=300');
 if(!popup)throw new Error('Разрешите всплывающие окна или установите расширение со страницы «Подключение»');
 await new Promise<void>((resolve,reject)=>{
  const ch=channel();
  const timer=setTimeout(()=>{ch.close();reject(new Error('Не удалось начать демонстрацию экрана'));},60000);
  ch.onmessage=e=>{
   if(e.data?.type==='live'){clearTimeout(timer);ch.close();resolve();}
   if(e.data?.type==='denied'||e.data?.type==='ended'){clearTimeout(timer);ch.close();reject(new Error('Чтобы начать работу, разрешите демонстрацию экрана'));}
  };
 });
}

export async function openScreenHolder(){
 if(await pingScreenHolder())return;
 if(extensionPresent()){
  const r=await talk('capture-start',2000).catch(()=>null);
  if(r?.live)return;
  if(r?.pending||r?.ok){
   const live=await waitEvent(60000);
   if(live)return;
   throw new Error('Чтобы начать работу, разрешите демонстрацию экрана');
  }
  throw new Error('Переустановите расширение Falcon Time со страницы «Подключение»');
 }
 await openSiteCapture();
}
