'use client';
import {useEffect,useRef,useState} from 'react';
import {Maximize2,Minimize2,Monitor,Webcam} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {connectOffice,type OfficeKind} from '@/lib/office-stream';

type Api=(path:string,body?:unknown)=>Promise<any>;

function isFullscreen(node:Element|null){
 const doc=document as Document&{webkitFullscreenElement?:Element|null};
 return (document.fullscreenElement||doc.webkitFullscreenElement)===node;
}

async function toggleFullscreen(frame:HTMLElement|null,video:HTMLVideoElement|null){
 if(!frame)return;
 const doc=document as Document&{webkitExitFullscreen?:()=>Promise<void>|void};
 const el=frame as HTMLElement&{webkitRequestFullscreen?:()=>Promise<void>|void};
 try{
  if(isFullscreen(frame)){await (document.exitFullscreen||doc.webkitExitFullscreen)?.call(document);return;}
  if(el.requestFullscreen){await el.requestFullscreen();return;}
  if(el.webkitRequestFullscreen){await el.webkitRequestFullscreen();return;}
 }catch{/* Safari iOS умеет только видео */}
 const media=video as (HTMLVideoElement&{webkitEnterFullscreen?:()=>void;webkitDisplayingFullscreen?:boolean;webkitExitFullscreen?:()=>void})|null;
 if(!media)return;
 if(media.webkitDisplayingFullscreen)media.webkitExitFullscreen?.();
 else media.webkitEnterFullscreen?.();
}

function OfficeTile({personId,kind,title,action,idle,api}:{personId:string;kind:OfficeKind;title:string;action:string;idle:string;api:Api}){
 const video=useRef<HTMLVideoElement>(null);
 const frame=useRef<HTMLDivElement>(null);
 const link=useRef<ReturnType<typeof connectOffice>|null>(null);
 const [status,setStatus]=useState('');
 const [error,setError]=useState('');
 const [online,setOnline]=useState(false);
 const [playing,setPlaying]=useState(false);
 const [loading,setLoading]=useState(false);
 const [full,setFull]=useState(false);
 const watching=!!status&&status!=='ended'&&status!=='failed';

 function attach(stream:MediaStream){
  const node=video.current;if(!node)return;
  node.srcObject=stream;
  setPlaying(true);
  void node.play().catch(()=>{});
 }

 function stop(){
  if(isFullscreen(frame.current))void document.exitFullscreen?.().catch(()=>{});
  link.current?.close();
  link.current=null;
  if(video.current)video.current.srcObject=null;
  setStatus('');
  setOnline(false);
  setPlaying(false);
  setFull(false);
 }

 async function start(){
  setError('');
  setLoading(true);
  try{
   if(link.current){link.current.close();link.current=null;}
   const session=await api('office/watch',{personId,kind});
   setStatus(session.status||'requested');
   link.current=connectOffice({role:'viewer',sessionId:session.id,kind,onStream:attach,onStatus:s=>{
    setStatus(s.status);
    setOnline(!!s.online);
    if(s.error)setError(s.error);
    if(s.status==='ended'||s.status==='failed'){
     if(video.current)video.current.srcObject=null;
     setPlaying(false);
     link.current=null;
    }
   }});
  }catch(e:any){setError(e.message||'Не удалось запросить стрим');setStatus('failed');}
  finally{setLoading(false);}
 }

 useEffect(()=>()=>stop(),[personId,kind]);
 useEffect(()=>{
  const sync=()=>setFull(isFullscreen(frame.current));
  const enter=()=>setFull(true);
  const exit=()=>setFull(false);
  const node=video.current;
  document.addEventListener('fullscreenchange',sync);
  document.addEventListener('webkitfullscreenchange',sync as EventListener);
  node?.addEventListener('webkitbeginfullscreen',enter);
  node?.addEventListener('webkitendfullscreen',exit);
  return()=>{
   document.removeEventListener('fullscreenchange',sync);
   document.removeEventListener('webkitfullscreenchange',sync as EventListener);
   node?.removeEventListener('webkitbeginfullscreen',enter);
   node?.removeEventListener('webkitendfullscreen',exit);
  };
 },[]);

 const caption=status==='live'?'Стрим идёт':status==='connecting'?'Подключаемся':status==='requested'?(online?'Подключаемся к программе сотрудника':'Программа Falcon Time на компьютере сотрудника должна быть запущена'):status==='failed'?(error||'Стрим не удался'):idle;

 return <article className="office-card">
  <div className="section-head"><h2>{title}</h2><span className={'section-caption'+(status==='live'?' office-on':'')}>{status==='live'?'В эфире':kind==='camera'?'Камера':'Экран'}</span></div>
  <div ref={frame} className={'office-frame'+(kind==='screen'?' screen':'')+(playing?' live':'')+(full?' full':'')}>
   <video ref={video} autoPlay playsInline muted className={playing?'':'hidden'} onDoubleClick={()=>playing&&toggleFullscreen(frame.current,video.current)}/>
   {!playing&&<p className="office-placeholder">{caption}</p>}
   {playing&&<button type="button" className="office-full" aria-label={full?'Выйти из полноэкранного режима':'Открыть на весь экран'} onClick={()=>toggleFullscreen(frame.current,video.current)}>{full?<Minimize2 size={18}/>:<Maximize2 size={18}/>}</button>}
  </div>
  <div className="card-actions">
   {watching
    ?<Button variant="outline" onClick={stop}>Скрыть</Button>
    :<Button disabled={loading} onClick={start}>{kind==='camera'?<Webcam/>:<Monitor/>}{action}</Button>}
  </div>
  {error&&status!=='live'&&<p className="muted office-error">{error}</p>}
 </article>;
}

export function OfficePanel({personId,api}:{personId:string;api:Api}){
 return <section className="office-panel" aria-label="Домашний офис">
  <div className="office-grid">
   <OfficeTile personId={personId} kind="camera" title="Сотрудник" action="Показать сотрудника" idle="Камера откроется в программе Falcon Time на компьютере сотрудника" api={api}/>
   <OfficeTile personId={personId} kind="screen" title="Экран" action="Показать экран сотрудника" idle="Экран откроется в программе Falcon Time на компьютере сотрудника" api={api}/>
  </div>
 </section>;
}
