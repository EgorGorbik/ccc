'use client';
import {useEffect,useRef,useState} from 'react';
import { Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { adoptCapture } from '@/lib/office-stream';

const CHANNEL='falcon-screen';

export default function CapturePage(){
 const [ready,setReady]=useState(false);
 const [needClick,setNeedClick]=useState(false);
 const shareRef=useRef<()=>Promise<void>>(async()=>{});

 useEffect(()=>{
  const ch=new BroadcastChannel(CHANNEL);
  let stream:MediaStream|undefined;
  let closed=false;
  let asked=false;
  const finish=(type:'ended'|'denied'='ended')=>{
   if(closed)return;
   closed=true;
   stream?.getTracks().forEach(track=>track.stop());
   ch.postMessage({type});
   ch.close();
   window.close();
  };
  ch.onmessage=e=>{
   if(e.data?.type==='ping')ch.postMessage({type:stream?'pong':'wait'});
   if(e.data?.type==='stop')finish('ended');
  };
  shareRef.current=async()=>{
   try{
    const early=(window as any).__falconShare as Promise<MediaStream>|undefined;
    (window as any).__falconShare=undefined;
    stream=await (early&&typeof early.then==='function'?early:navigator.mediaDevices.getDisplayMedia({video:true,audio:false}));
    if(closed){stream.getTracks().forEach(track=>track.stop());return;}
    adoptCapture('screen',stream);
    for(const track of stream.getTracks())track.addEventListener('ended',()=>finish('ended'));
    ch.postMessage({type:'live'});
    setNeedClick(false);
    setReady(true);
   }catch{
    if(closed)return;
    if(!asked){asked=true;setNeedClick(true);return;}
    finish('denied');
   }
  };
  void shareRef.current();
  const hide=()=>{
   if(closed)return;
   if(stream?.getTracks().some(track=>track.readyState==='live')){
    void fetch('/api/tracking',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'idle'}),keepalive:true});
   }
   finish('ended');
  };
  window.addEventListener('pagehide',hide);
  return ()=>{
   window.removeEventListener('pagehide',hide);
   ch.close();
  };
 },[]);

 return <div className="capture-hold">
  <Monitor size={28}/>
  <h1>Демонстрация экрана</h1>
  <p>Не закрывайте это окно, пока вы работаете. С него идёт экран и камера. Вкладку кабинета можно обновлять — повторный запрос и обрыв стрима не произойдут.</p>
  {needClick&&!ready&&<Button onClick={()=>void shareRef.current()}>Разрешить демонстрацию экрана</Button>}
 </div>;
}
