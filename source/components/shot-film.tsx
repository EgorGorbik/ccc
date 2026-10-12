'use client';
import {useEffect} from 'react';
import {ChevronLeft,ChevronRight,X} from 'lucide-react';

export function ShotFilm({shots,current,onPick,onClose,caption}:{
 shots:Record<string,any>[];
 current:Record<string,any>;
 onPick:(shot:Record<string,any>)=>void;
 onClose:()=>void;
 caption:string;
}){
 const index=shots.findIndex(shot=>shot.id===current.id);
 const prev=index>0?shots[index-1]:null;
 const next=index>=0&&index<shots.length-1?shots[index+1]:null;
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{
   if(e.key==='Escape')onClose();
   if(e.key==='ArrowLeft'&&prev)onPick(prev);
   if(e.key==='ArrowRight'&&next)onPick(next);
  };
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[prev,next,onPick,onClose]);
 return <div className="shot-viewer" role="dialog" aria-modal="true" onClick={onClose}>
  <button type="button" className="shot-close" aria-label="Закрыть" onClick={e=>{e.stopPropagation();onClose();}}><X/></button>
  <button type="button" className="shot-nav prev" aria-label="Предыдущий снимок" disabled={!prev} onClick={e=>{e.stopPropagation();if(prev)onPick(prev);}}><ChevronLeft/></button>
  <figure onClick={e=>e.stopPropagation()}>
   <img src={`/api/screenshots/file?id=${encodeURIComponent(current.id)}`} alt={caption}/>
   <figcaption>{caption}{shots.length>1?` · ${Math.max(index,0)+1} / ${shots.length}`:''}</figcaption>
  </figure>
  <button type="button" className="shot-nav next" aria-label="Следующий снимок" disabled={!next} onClick={e=>{e.stopPropagation();if(next)onPick(next);}}><ChevronRight/></button>
 </div>;
}
