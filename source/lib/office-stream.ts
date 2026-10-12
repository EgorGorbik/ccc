export type OfficeKind='camera'|'screen';
type Session={id:string;kind:OfficeKind;status:string;error?:string;online?:boolean};

const iceServers=[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];

async function officeApi(path:string,body?:unknown){
 const r=await fetch('/api/'+path,{method:body?'POST':'GET',credentials:'include',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 let data:any=null;try{data=await r.json();}catch{}
 if(!r.ok){const e:any=new Error(data?.error||'Нет связи с кабинетом');e.status=r.status;throw e;}
 return data;
}

async function signal(sessionId:string,type:string,payload:unknown){
 return officeApi('office/signal',{sessionId,type,payload:typeof payload==='string'?payload:JSON.stringify(payload)});
}

async function pull(sessionId:string,after:number){
 return officeApi(`office/session?id=${encodeURIComponent(sessionId)}&after=${after}`);
}

function parse(payload:string){
 try{return JSON.parse(payload);}catch{return null;}
}

export async function capture(kind:OfficeKind){
 if(kind==='screen')return navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
 return navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false});
}

const held:Partial<Record<OfficeKind,MediaStream>>={};
const acquiring:Partial<Record<OfficeKind,Promise<MediaStream>>>={};
const captureEnded=new Set<(kind:OfficeKind)=>void>();
export function onCaptureEnded(fn:(kind:OfficeKind)=>void){
 captureEnded.add(fn);
 return ()=>{captureEnded.delete(fn);};
}

function alive(stream?:MediaStream){
 return !!stream?.getTracks().some(track=>track.readyState==='live');
}

export function hasCapture(kind:OfficeKind){
 return alive(held[kind]);
}

function watchStream(kind:OfficeKind,stream:MediaStream){
 held[kind]=stream;
 let notified=false;
 for(const track of stream.getTracks())track.addEventListener('ended',()=>{
  if(held[kind]===stream)held[kind]=undefined;
  if(notified||stream.getTracks().some(item=>item.readyState==='live'))return;
  notified=true;
  if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;
  for(const fn of [...captureEnded])fn(kind);
 });
}

export function adoptCapture(kind:OfficeKind,stream:MediaStream){
 watchStream(kind,stream);
 return stream;
}

export async function holdCapture(kind:OfficeKind){
 if(alive(held[kind]))return held[kind]!;
 if(acquiring[kind])return acquiring[kind]!;
 const pending=capture(kind).then(stream=>{
  watchStream(kind,stream);
  return stream;
 });
 acquiring[kind]=pending;
 try{return await pending;}
 finally{if(acquiring[kind]===pending)acquiring[kind]=undefined;}
}

export function releaseCapture(kind?:OfficeKind){
 const kinds=kind?[kind]:(['camera','screen'] as OfficeKind[]);
 for(const item of kinds){
  held[item]?.getTracks().forEach(track=>track.stop());
  held[item]=undefined;
  acquiring[item]=undefined;
 }
}

const shareEnders=new Set<()=>void>();
export function onShareEnd(fn:()=>void){
 shareEnders.add(fn);
 return ()=>{shareEnders.delete(fn);};
}
export function endShare(){
 for(const fn of [...shareEnders])fn();
 releaseCapture();
 if(typeof window!=='undefined'&&window.location.pathname!=='/capture'){
  void import('./screen-holder').then(m=>m.stopScreenHolder()).catch(()=>{});
 }
}

export function connectOffice(opts:{
 role:'publisher'|'viewer';
 sessionId:string;
 kind:OfficeKind;
 stream?:MediaStream;
 releaseTracks?:boolean;
 onStream?:(stream:MediaStream)=>void;
 onStatus?:(session:Session)=>void;
}){
 let closed=false,after=0,pc:RTCPeerConnection|null=null,timer:ReturnType<typeof setTimeout>|undefined,iceDead:ReturnType<typeof setTimeout>|undefined;
 const seen=new Set<string>();
 const remoteIce:RTCIceCandidateInit[]=[];
 let remoteSet=false;
 const local=opts.stream;

 async function setSending(on:boolean){
  if(!pc||opts.role!=='publisher')return;
  for(const sender of pc.getSenders()){
   if(sender.track)sender.track.enabled=on;
   const params=sender.getParameters();
   if(!params.encodings.length)params.encodings=[{active:on}];
   else for(const enc of params.encodings)enc.active=on;
   try{await sender.setParameters(params);}catch{/* ещё нет согласованной передачи */}
  }
 }

 const sendIce=(candidate:RTCIceCandidate)=>{
  if(closed||!candidate.candidate)return;
  void signal(opts.sessionId,'ice',candidate.toJSON()).catch(()=>{});
 };

 async function applyRemote(desc:RTCSessionDescriptionInit){
  if(!pc||closed)return;
  await pc.setRemoteDescription(desc);
  remoteSet=true;
  for(const c of remoteIce.splice(0)){
   try{await pc.addIceCandidate(c);}catch{/* candidate already applied or stale */}
  }
 }

 async function start(){
  pc=new RTCPeerConnection({iceServers});
  pc.onicecandidate=e=>{if(e.candidate)sendIce(e.candidate);};
  pc.onconnectionstatechange=()=>{
   if(!pc||closed)return;
   const state=pc.connectionState;
   if(state==='connected'){clearTimeout(iceDead);void setSending(true);}
   else void setSending(false);
   if(state==='failed')void signal(opts.sessionId,'error','Нет соединения со стримом').catch(()=>{});
   if(state==='disconnected'){
    clearTimeout(iceDead);
    iceDead=setTimeout(()=>{if(!closed&&pc?.connectionState==='disconnected')void signal(opts.sessionId,'hangup','{}').catch(()=>{});},8000);
   }
  };
  if(opts.role==='viewer'){
   pc.ontrack=e=>{const stream=e.streams[0];if(stream&&opts.onStream)opts.onStream(stream);};
  }else if(local){
   for(const track of local.getTracks()){
    if(track.readyState!=='live')continue;
    const copy=track.clone();
    copy.enabled=false;
    pc.addTrack(copy,local);
   }
  }
  if(opts.role==='publisher'&&local){
   const offer=await pc.createOffer();
   await pc.setLocalDescription(offer);
   await setSending(false);
   await signal(opts.sessionId,'offer',pc.localDescription);
  }
 }

 async function tick(){
  if(closed)return;
  try{
   const data=await pull(opts.sessionId,after);
   if(closed)return;
   if(data.session&&opts.onStatus)opts.onStatus(data.session);
   if(data.session?.status==='ended'||data.session?.status==='failed'){close();return;}
   for(const item of data.signals||[]){
    if(closed)return;
    if(seen.has(item.id))continue;
    seen.add(item.id);
    after=Math.max(after,Number(item.created)||0);
    if(item.sender===(opts.role==='publisher'?'member':'owner'))continue;
    if(item.type==='hangup'||item.type==='error'){close();return;}
    const body=parse(item.payload);
    if(item.type==='ice'&&body){
     if(remoteSet&&pc){try{await pc.addIceCandidate(body);}catch{/* ignore */}}
     else remoteIce.push(body);
    }
    if(item.type==='offer'&&opts.role==='viewer'&&body&&pc&&!pc.currentRemoteDescription){
     await applyRemote(body);
     const answer=await pc.createAnswer();
     await pc.setLocalDescription(answer);
     await signal(opts.sessionId,'answer',pc.localDescription);
    }
    if(item.type==='answer'&&opts.role==='publisher'&&body&&pc&&!pc.currentRemoteDescription){
     await applyRemote(body);
    }
   }
  }catch{/* повторим на следующем такте */}
  if(!closed)timer=setTimeout(tick,800);
 }

 function close(){
  if(closed)return;
  closed=true;
  clearTimeout(timer);
  clearTimeout(iceDead);
  const source=new Set(local?.getTracks()||[]);
  pc?.getSenders().forEach(s=>{if(s.track&&!source.has(s.track))s.track.stop();});
  if(opts.releaseTracks!==false)for(const track of source)track.stop();
  pc?.close();
  pc=null;
 }

 const ready=start().then(tick,async e=>{
  const message=e instanceof Error?e.message:'Не удалось открыть стрим';
  try{await signal(opts.sessionId,'error',message);}catch{/* already closing */}
  close();
 });

 return {
  close:(hangup=true)=>{
   if(!closed&&hangup)void signal(opts.sessionId,'hangup','{}').catch(()=>{});
   close();
  },
  ready
 };
}
