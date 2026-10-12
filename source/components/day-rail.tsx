'use client';
import {duration,formatDuration,localDate,localMidnight} from '@/lib/time';

type Person={id:string;name:string;active?:number};
type Span={id:string;person_id:string;project_id:string;start:number;end:number};
type Project={id:string;name:string};
const DAY=86400000;
const hm=(ms:number)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'}).format(ms);

export function DayRail({date,people,spans,projects,onOpen}:{
 date:string;people:Person[];spans:Span[];projects:Project[];onOpen:(id:string)=>void;
}){
 const from=localMidnight(date);
 const now=Date.now();
 const live=date===localDate(now);
 const nowPct=live?Math.min(100,Math.max(0,(now-from)/DAY*100)):null;
 const shown=people.filter(p=>p.active!==0);
 const used=new Set(spans.map(s=>s.project_id));
 const tone=(id:string)=>Math.max(0,projects.findIndex(p=>p.id===id))%4;
 return <section className="day-rail" aria-label="Статистика за сегодня">
  <div className="section-head">
   <div><h2>Статистика за сегодня</h2><span className="section-caption">{date} · кадры на шкале Нью-Йорка</span></div>
   <div className="day-rail-legend">
    {projects.filter(p=>used.has(p.id)).map(p=><span key={p.id}><i className={'project-dot tone-'+tone(p.id)}/>{p.name}</span>)}
    {live&&<span><i className="day-rail-now-dot"/>сейчас</span>}
   </div>
  </div>
  <div className="day-rail-board">
   <div className="day-rail-ruler" aria-hidden="true"><span/><div className="day-rail-hours">{['00:00','06:00','12:00','18:00','24:00'].map(h=><span key={h}>{h}</span>)}</div></div>
   <div className="day-rail-list">{shown.map(p=>{
   const own=spans.filter(s=>s.person_id===p.id);
   return <div className="day-rail-row" key={p.id}>
    <div className="day-rail-who"><strong>{p.name}</strong><small>{own.length?formatDuration(duration(own as never)):'нет кадров'}</small></div>
    <div className="day-rail-track">
     <div className="day-rail-bar">
      {own.map(s=>{
       const left=Math.max(0,(s.start-from)/DAY*100);
       const width=Math.min(100-left,Math.max(0.45,(s.end-s.start)/DAY*100));
       const name=projects.find(x=>x.id===s.project_id)?.name||'';
       return <button key={s.id} type="button" className={'day-rail-span tone-'+tone(s.project_id)} style={{left:left+'%',width:width+'%'}} data-project={name||'Проект'} data-when={`${hm(s.start)}–${hm(s.end)}`} aria-label={`${p.name}, ${hm(s.start)}–${hm(s.end)}, ${name}`} onClick={()=>onOpen(p.id)}/>;
      })}
      {nowPct!=null&&<i className="day-rail-now" style={{left:nowPct+'%'}} aria-hidden="true"/>}
     </div>
    </div>
   </div>;
  })}</div>
  </div>
 </section>;
}
