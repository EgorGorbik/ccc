'use client';
import {useEffect,useRef,useState} from 'react';
import {usePathname} from 'next/navigation';
import {Monitor,Webcam} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {holdCapture,releaseCapture,onShareEnd,connectOffice,type OfficeKind} from '@/lib/office-stream';

type Request={id:string;kind:OfficeKind;status:string};

function captureWindowLive(ms=250){
 return new Promise<boolean>(resolve=>{
  if(typeof window==='undefined'){resolve(false);return;}
  const ch=new BroadcastChannel('falcon-screen');
  const timer=setTimeout(()=>{ch.close();resolve(false);},ms);
  ch.onmessage=e=>{
   if(e.data?.type==='pong'||e.data?.type==='live'){clearTimeout(timer);ch.close();resolve(true);}
  };
  ch.postMessage({type:'ping'});
 });
}

async function inbox(){
 const r=await fetch('/api/office/inbox',{credentials:'include',cache:'no-store'});
 if(!r.ok)throw new Error('inbox');
 return r.json() as Promise<{sessions?:Request[]}>;
}

export function OfficeHost(){
 const captureWin=usePathname()==='/capture';
 const links=useRef(new Map<string,ReturnType<typeof connectOffice>>());
 const kinds=useRef(new Map<string,OfficeKind>());
 const started=useRef(new Set<string>());
 const pending=useRef(new Set<string>());
 const blocked=useRef(new Set<OfficeKind>());
 const openRef=useRef<Request[]>([]);
 const pollRef=useRef<()=>void>(()=>{});
 const [needs,setNeeds]=useState<OfficeKind[]>([]);

 useEffect(()=>{
  let stop=false;
  const drop=(id:string,release=false)=>{
   links.current.get(id)?.close();
   links.current.delete(id);
   started.current.delete(id);
   const kind=kinds.current.get(id);
   kinds.current.delete(id);
   if(release&&kind&&kind!=='screen')releaseCapture(kind);
  };
  async function publish(session:Request){
   if(stop||started.current.has(session.id)||pending.current.has(session.id))return;
   if(blocked.current.has(session.kind))return;
   pending.current.add(session.id);
   try{
    const stream=await holdCapture(session.kind);
    blocked.current.delete(session.kind);
    setNeeds(list=>list.filter(k=>k!==session.kind));
    if(stop||started.current.has(session.id))return;
    started.current.add(session.id);
    kinds.current.set(session.id,session.kind);
    stream.getVideoTracks()[0]?.addEventListener('ended',()=>drop(session.id,true));
    const link=connectOffice({role:'publisher',sessionId:session.id,kind:session.kind,stream,releaseTracks:false,onStatus:s=>{
     if(s.status==='ended'||s.status==='failed')drop(session.id);
    }});
    links.current.set(session.id,link);
    await link.ready.catch(()=>drop(session.id));
   }catch{
    blocked.current.add(session.kind);
    setNeeds(list=>list.includes(session.kind)?list:[...list,session.kind]);
   }
   finally{pending.current.delete(session.id);}
  }
  const offShare=onShareEnd(()=>{
   for(const id of [...links.current.keys()])drop(id,false);
  });
  async function poll(){
   if(stop)return;
   if(!captureWin&&await captureWindowLive())return;
   try{
    const data=await inbox();
    const open:Request[]=(data.sessions||[]).map(s=>({id:s.id,kind:s.kind,status:s.status}));
    openRef.current=open;
    const ids=new Set(open.map(s=>s.id));
    for(const id of [...links.current.keys()])if(!ids.has(id))drop(id);
    if(!open.some(s=>s.kind==='camera'))releaseCapture('camera');
    const liveKinds=new Set(open.map(s=>s.kind));
    for(const kind of [...blocked.current])if(!liveKinds.has(kind))blocked.current.delete(kind);
    setNeeds(list=>list.filter(k=>liveKinds.has(k)&&blocked.current.has(k)));
    for(const session of open)if(!started.current.has(session.id))void publish(session);
   }catch{/* кабинет мог разлогиниться */}
  }
  pollRef.current=()=>{void poll();};
  void poll();
  const timer=setInterval(poll,2000);
  return()=>{
   stop=true;
   clearInterval(timer);
   offShare();
   for(const id of [...links.current.keys()]){
    links.current.get(id)?.close(false);
    links.current.delete(id);
    started.current.delete(id);
    kinds.current.delete(id);
   }
  };
 },[captureWin]);

 async function allow(kind:OfficeKind){
  try{
   await holdCapture(kind);
   blocked.current.delete(kind);
   setNeeds(list=>list.filter(k=>k!==kind));
   for(const session of openRef.current)if(session.kind===kind)started.current.delete(session.id);
   pollRef.current();
  }catch{/* диалог закрыт — кнопка остаётся */}
 }

 if(captureWin||!needs.length)return null;
 const label=needs.length===2?'камеру и экран':needs[0]==='camera'?'камеру':'экран';
 return <div className="office-host">
  <div className="office-banner">
   <div><strong>Запрос видео</strong><p>Администратор открыл {label}. Разрешите доступ в этом браузере — кадр уйдёт только в кабинет.</p></div>
   <div className="card-actions">
    {needs.includes('camera')&&<Button onClick={()=>void allow('camera')}><Webcam/>Разрешить камеру</Button>}
    {needs.includes('screen')&&<Button onClick={()=>void allow('screen')}><Monitor/>Разрешить экран</Button>}
   </div>
  </div>
 </div>;
}
