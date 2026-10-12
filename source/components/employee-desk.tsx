'use client';
import {useEffect,useMemo,useState} from 'react';
import {ChevronLeft,ChevronRight,Lock,Pencil,Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {NativeSelect as Select} from '@/components/ui/native-select';
import {duration,formatDuration,localDate,localMidnight,shotSpans,type Session} from '@/lib/time';
import {ShotFilm} from '@/components/shot-film';

type Any=Record<string,any>;
type Api=(path:string,body?:unknown)=>Promise<Any>;
const tz='America/New_York';
const MONTHS=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

function weekday(date:string){
 const name=new Intl.DateTimeFormat('ru-RU',{weekday:'long',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));
 return name.charAt(0).toUpperCase()+name.slice(1);
}
function clock(ms:number){
 return new Intl.DateTimeFormat('sv-SE',{timeZone:tz,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(ms);
}
function toMs(date:string,hm:string){
 const [h,m]=hm.split(':').map(Number);
 return localMidnight(date,tz)+((h||0)*60+(m||0))*60000;
}
function toHM(ms:number){
 const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms);
 const g=(k:string)=>p.find(x=>x.type===k)?.value||'00';
 return `${g('hour')}:${g('minute')}`;
}
function hms(ms:number){
 const s=Math.max(0,Math.floor(ms/1000));
 return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':');
}
function hmWords(ms:number){
 const m=Math.max(0,Math.round(ms/60000));
 return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')} минут`;
}
function shiftDate(date:string,days:number){
 const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);
}
function weekStart(date:string){
 const d=new Date(date+'T12:00:00Z');
 d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
 return d.toISOString().slice(0,10);
}
function monthDays(year:number,month:number){
 const today=localDate(Date.now(),tz);
 const last=new Date(Date.UTC(year,month,0)).getUTCDate();
 const days:string[]=[];
 for(let d=last;d>=1;d--){
  const date=`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  if(date<=today)days.push(date);
 }
 return days;
}
function onDay(sessions:Session[],date:string){
 const from=localMidnight(date,tz),to=localMidnight(shiftDate(date,1),tz);
 return sessions.filter(s=>s.end>from&&s.start<to).map(s=>({...s,start:Math.max(s.start,from),end:Math.min(s.end,to)})).sort((a,b)=>a.start-b.start);
}
function shotOnly(times:number[],blocks:Any[]=[]){
 return shotSpans(times,[]).map(s=>{
  const mid=(s.start+s.end)/2;
  const hit=blocks.find(b=>mid>=b.start&&mid<b.end);
  const project_id=hit?.project_id&&hit.project_id!=='none'?hit.project_id:'';
  return {id:`auto:${s.start}`,person_id:'',project_id,device_id:'',start:s.start,last:s.end,end:s.end,reason:'shots',open:false,correction_reason:''};
 });
}
function withShots(manual:Session[],times:number[]){
 const auto=shotSpans(times,manual).map(s=>({id:`auto:${s.start}`,person_id:'',project_id:'',device_id:'',start:s.start,last:s.end,end:s.end,reason:'shots',open:false,correction_reason:''}));
 return [...manual,...auto].sort((a,b)=>a.start-b.start);
}
function breaks(slices:Session[]){
 let gap=0;
 for(let i=1;i<slices.length;i++)gap+=Math.max(0,slices[i].start-slices[i-1].end);
 return gap;
}

type Row={id?:string;at:number;status:string;note:string;task:string;comment:string;leave:boolean;shots:Any[];span:number};

function intervalRows(slices:Session[],shots:Any[],projectName:(id:string)=>string):Row[]{
 const rows:Row[]=[];
 slices.forEach((s,i)=>{
  const mine=shots.filter(sh=>sh.taken_at>=s.start&&sh.taken_at<s.end);
  const next=slices[i+1];
  const gap=next?next.start-s.end:0;
  rows.push({
   id:s.id,
   at:s.start,
   status:mine.length?'работа':'работа без скриншотов',
   note:mine.length?'100% времени покрыто скриншотами.':'',
   task:projectName(s.project_id),
   comment:s.correction_reason||'',
   leave:false,
   shots:mine,
   span:Math.max(0,s.end-s.start),
  });
  if(!s.open&&(!next||gap>=60000))rows.push({at:s.end,status:'ушел',note:'',task:'-',comment:'',leave:true,shots:[],span:0});
 });
 return rows;
}
function buildRows(slices:Session[],shots:Any[],projectName:(id:string)=>string):Row[]{
 const rows=intervalRows(slices,shots,projectName);
 const extra=shots.filter(sh=>!slices.some(s=>sh.taken_at>=s.start&&sh.taken_at<s.end)).map(sh=>({
  at:sh.taken_at,status:'снимок экрана',note:'',task:'-',comment:'',leave:false,shots:[sh],span:0,
 }));
 return [...rows,...extra].sort((a,b)=>a.at-b.at);
}

function DayNav({date,onDate}:{date:string;onDate:(d:string)=>void}){
 const today=localDate(Date.now(),tz);
 return <div className="report-toolbar"><div className="date-control">
  <Button variant="ghost" size="icon" aria-label="Предыдущий день" onClick={()=>onDate(shiftDate(date,-1))}><ChevronLeft/></Button>
  <strong>{date} · {weekday(date)}</strong>
  <Button variant="ghost" size="icon" aria-label="Следующий день" disabled={date>=today} onClick={()=>onDate(shiftDate(date,1))}><ChevronRight/></Button>
 </div></div>;
}

export function EmployeeOverview({name,api}:{name:string;api:Api}){
 const today=localDate(Date.now(),tz);
 const [pack,setPack]=useState<{day:Session[];week:Session[];month:Session[];projects:Any[]}|null>(null);
 const [err,setErr]=useState('');
 useEffect(()=>{
  let dead=false;
  (async()=>{
   try{
    const [d,w,m]=await Promise.all([
     api(`data?period=day&date=${today}`),
     api(`data?period=week&date=${today}`),
     api(`data?period=month&date=${today}`),
    ]);
    if(!dead)setPack({
     day:shotOnly(d.shotTimes||[],d.blocks||[]),
     week:shotOnly(w.shotTimes||[],w.blocks||[]),
     month:shotOnly(m.shotTimes||[],m.blocks||[]),
     projects:m.projects||[],
    });
   }catch(e:any){if(!dead)setErr(e.message);}
  })();
  return()=>{dead=true;};
 },[api,today]);
 const day=pack?.day||[],month=pack?.month||[];
 const first=day.length?Math.min(...day.map(s=>s.start)):null;
 const last=day.length?Math.max(...day.map(s=>s.end)):null;
 const open=day.some(s=>s.open);
 const real=(pack?.projects||[]).filter(p=>p.active!==0&&p.id!=='none');
 const fallback=real[0]?.id||'';
 const tagged=month.map(s=>!s.project_id||s.project_id==='none'?{...s,project_id:fallback}:s);
 const total=duration(tagged);
 const allocation=real.map(p=>({...p,ms:duration(tagged.filter(s=>s.project_id===p.id))})).filter(p=>p.ms>0).sort((a,b)=>b.ms-a.ms);
 return <div>
  <div className="heading"><div>
   <div className="eyebrow">ТОЛЬКО ВАШ УЧЁТ</div>
   <h1>{name}</h1>
   <p className="muted">Часы, сессии и проекты — без данных других сотрудников.</p>
  </div></div>
  {err&&<div className="error" role="alert">{err}</div>}
  <div className="own-stats">
   <section><span>Сегодня</span><strong>{pack?formatDuration(duration(day)):'…'}</strong><small>{day.length?`${day.length} интерв.`:'Нет интервалов'}</small></section>
   <section><span>Неделя</span><strong>{pack?formatDuration(duration(pack.week)):'…'}</strong><small>с понедельника</small></section>
   <section><span>Месяц</span><strong>{pack?formatDuration(total):'…'}</strong><small>{MONTHS[Number(today.slice(5,7))-1]}</small></section>
   <section><span>Сегодня в кабинете</span><strong>{first?clock(first).slice(0,5):'—'}</strong><small>{open?'сессия открыта':last?`выход ${clock(last).slice(0,5)}`:'выхода нет'}</small></section>
  </div>
  <section className="project-summary">
   <div className="section-head"><h2>По проектам за месяц</h2></div>
   {allocation.length?<div className="allocation-list">{allocation.map((p,i)=><div className="project-bar" key={p.id}>
    <div className="project-bar-label"><span><i className={'project-dot tone-'+i%4}/>{p.name}</span><strong>{formatDuration(p.ms)}</strong></div>
    <div className="bar-track" aria-hidden="true"><span className={'tone-'+i%4} style={{width:`${total?p.ms/total*100:0}%`}}/></div>
   </div>)}</div>:<p className="muted">{pack?'За этот месяц времени ещё нет.':'Считаем…'}</p>}
  </section>
 </div>;
}

export function EmployeeTimesheet({name,api,onShots}:{name:string;api:Api;onShots:(date:string)=>void}){
 const today=localDate(Date.now(),tz);
 const [year,setYear]=useState(Number(today.slice(0,4)));
 const [month,setMonth]=useState(Number(today.slice(5,7)));
 const [applied,setApplied]=useState({year:Number(today.slice(0,4)),month:Number(today.slice(5,7))});
 const [blocks,setBlocks]=useState<Session[]|null>(null);
 const [times,setTimes]=useState<number[]>([]);
 const [err,setErr]=useState('');
 const [open,setOpen]=useState<string|null>(null);
 const [rev,setRev]=useState(0);
 const years=[Number(today.slice(0,4))-1,Number(today.slice(0,4)),Number(today.slice(0,4))+1];
 useEffect(()=>{
  let dead=false;
  const date=`${applied.year}-${String(applied.month).padStart(2,'0')}-01`;
  (async()=>{
   try{
    const r=await api(`data?period=month&date=${date}`);
    if(!dead){setBlocks(r.blocks||[]);setTimes(r.shotTimes||[]);setErr('');}
   }catch(e:any){if(!dead)setErr(e.message);}
  })();
  return()=>{dead=true;};
 },[api,applied,rev]);
 const days=useMemo(()=>monthDays(applied.year,applied.month),[applied]);
 const thisWeek=weekStart(today);
 if(open)return <DayReport name={name} date={open} api={api} onDate={setOpen} onBack={()=>setOpen(null)} onShots={onShots} onChanged={()=>setRev(n=>n+1)}/>;
 return <div>
  <div className="heading"><div><div className="eyebrow">УЧЁТ ВРЕМЕНИ</div><h1>{name}</h1><p className="muted">Дни месяца собираются по скриншотам. Карандаш — текущую неделю можно поправить, замок — неделя закрыта.</p></div></div>
  <div className="report-toolbar"><div className="ledger-find">
   <span>Период</span>
   <Select aria-label="Месяц" value={String(month)} onChange={e=>setMonth(Number(e.target.value))}>{MONTHS.map((n,i)=><option key={n} value={i+1}>{n}</option>)}</Select>
   <Select aria-label="Год" value={String(year)} onChange={e=>setYear(Number(e.target.value))}>{years.map(y=><option key={y} value={y}>{y}</option>)}</Select>
   <Button type="button" onClick={()=>{setApplied({year,month});setOpen(null);}}>Показать</Button>
  </div></div>
  {err&&<div className="error" role="alert">{err}</div>}
  <div className="ledger-scroll">
   <table className="ledger-table ledger-days">
    <thead><tr><th/><th>Дата</th><th>День недели</th><th>Затрекал</th><th>Перерыв</th><th>Количество изменений</th></tr></thead>
    <tbody>
     {days.map(date=>{
      const manual=onDay(blocks||[],date);
      const dayTimes=times.filter(t=>t>=localMidnight(date,tz)&&t<localMidnight(shiftDate(date,1),tz));
      const slices=shotOnly(dayTimes);
      const tracked=duration(slices);
      const gap=breaks(slices);
      const changes=manual.length;
      const editable=weekStart(date)===thisWeek;
      return <tr key={date} onClick={()=>setOpen(date)}>
       <td>{editable?<Pencil size={15}/>:<Lock size={15}/>}</td>
       <td>{date}</td>
       <td>{weekday(date)}</td>
       <td>{tracked?hms(tracked):'-'}</td>
       <td>{gap?hms(gap):'-'}</td>
       <td>{changes||'-'}</td>
      </tr>;
     })}
    </tbody>
   </table>
  </div>
  {!blocks&&<p className="muted">Загрузка…</p>}
 </div>;
}

function DayReport({name,date,api,onDate,onBack,onShots,onChanged}:{
 name:string;date:string;api:Api;onDate:(d:string)=>void;onBack:()=>void;onShots:(d:string)=>void;onChanged:()=>void;
}){
 const blank={id:'',start:'09:00',end:'18:00',projectId:'',note:'',editing:false};
 const [shots,setShots]=useState<Any[]|null>(null);
 const [blocks,setBlocks]=useState<Any[]>([]);
 const [projects,setProjects]=useState<Any[]>([]);
 const [draft,setDraft]=useState(blank);
 const [busy,setBusy]=useState(false);
 const [err,setErr]=useState('');
 const editable=weekStart(date)===weekStart(localDate(Date.now(),tz));
 const active=projects.filter(p=>p.active&&p.id!=='none');
 const selectedProject=draft.projectId&&draft.projectId!=='none'?draft.projectId:active[0]?.id||'';
 const projectName=(id:string)=>projects.find(p=>p.id===id)?.name||'—';
 async function load(){
  const [shotsRes,dayRes,blockRes]=await Promise.all([
   api(`screenshots?date=${date}`),
   api(`data?period=day&date=${date}`),
   api(`work-blocks?date=${date}`),
  ]);
  setShots(shotsRes.shots||[]);setProjects(dayRes.projects||[]);setBlocks(blockRes.blocks||[]);setErr('');
 }
 useEffect(()=>{
  let dead=false;
  setDraft({id:'',start:'09:00',end:'18:00',projectId:'',note:'',editing:false});
  (async()=>{
   try{
    const [shotsRes,dayRes,blockRes]=await Promise.all([
     api(`screenshots?date=${date}`),
     api(`data?period=day&date=${date}`),
     api(`work-blocks?date=${date}`),
    ]);
    if(dead)return;
    setShots(shotsRes.shots||[]);setProjects(dayRes.projects||[]);setBlocks(blockRes.blocks||[]);setErr('');
   }catch(e:any){if(!dead){setShots([]);setErr(e.message);}}
  })();
  return()=>{dead=true;};
 },[api,date]);
 const manual=onDay(blocks.map(b=>({id:b.id,person_id:b.person_id,project_id:b.project_id,device_id:'',start:b.start,last:b.end,end:b.end,reason:'manual',open:false,correction_reason:b.note||''})),date);
 const slices=withShots(manual,(shots||[]).map(s=>s.taken_at)).map(s=>s.project_id&&s.project_id!=='none'?s:{...s,project_id:selectedProject});
 const rows=intervalRows(slices,shots||[],projectName);
 const logged=duration(slices);
 const byShots=duration(shotOnly((shots||[]).map(s=>s.taken_at)));
 async function save(e:React.FormEvent){
  e.preventDefault();
  const projectId=draft.projectId||active[0]?.id;
  if(!projectId){setErr('Нет активной задачи');return;}
  const start=toMs(date,draft.start),end=toMs(date,draft.end);
  setBusy(true);setErr('');
  try{
   await api('work-blocks',{...(draft.id?{id:draft.id}:{}),projectId,start,end,note:draft.note||''});
   setDraft({...blank,projectId});
   await load();onChanged();
  }catch(e:any){setErr(e.message);}finally{setBusy(false);}
 }
 async function remove(id:string){
  setBusy(true);setErr('');
  try{await api('work-blocks',{id,delete:true});if(draft.id===id)setDraft(blank);await load();onChanged();}
  catch(e:any){setErr(e.message);}finally{setBusy(false);}
 }
 return <div>
  <div className="heading"><div><button type="button" className="text-link" onClick={onBack} style={{marginTop:0,marginBottom:10}}>К списку дней</button><div className="eyebrow">ОТЧЁТ ЗА ДЕНЬ</div><h1>{name}</h1><p className="muted">Интервалы собраны по скриншотам. Время, задачу и комментарий можно поправить.</p></div></div>
  <DayNav date={date} onDate={onDate}/>
  {editable?<form className="block-form" onSubmit={save}>
   <label>С<Input type="time" required value={draft.start} onChange={e=>setDraft({...draft,start:e.target.value})}/></label>
   <label>По<Input type="time" required value={draft.end} onChange={e=>setDraft({...draft,end:e.target.value})}/></label>
   <label>Задача<Select aria-label="Задача" value={selectedProject} onChange={e=>setDraft({...draft,projectId:e.target.value})}>{active.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
   <label>Комментарий<Input value={draft.note} maxLength={500} placeholder="Что делали" onChange={e=>setDraft({...draft,note:e.target.value})}/></label>
   <div className="block-form-actions"><Button type="submit" disabled={busy||!active.length}>{busy?'Сохраняем…':draft.id||draft.editing?'Сохранить':'Добавить'}</Button>{(draft.id||draft.editing)&&<Button type="button" variant="ghost" onClick={()=>setDraft({...blank,projectId:draft.projectId})}>Отмена</Button>}</div>
  </form>:<p className="muted">Эта неделя закрыта. Интервалы можно менять только в текущей.</p>}
  {err&&<div className="error" role="alert">{err}</div>}
  <div className="ledger-scroll">
   <table className="ledger-table">
    <thead><tr><th>Время</th><th>Статус</th><th>Задача</th><th>Комментарий</th>{editable&&<th/>}</tr></thead>
    <tbody>
     {rows.length?rows.map((r,i)=><tr key={r.id||i}>
      <td>{clock(r.at)}</td><td>{r.status}</td><td>{r.task}</td><td>{r.comment||'-'}</td>
      {editable&&<td className="ledger-actions">{!r.leave&&r.id&&<>
       <Button type="button" size="icon" variant="ghost" aria-label="Изменить интервал" onClick={()=>{
        const auto=r.id!.startsWith('auto:');
        const b=auto?null:blocks.find(x=>x.id===r.id);
        const projectId=b?.project_id&&b.project_id!=='none'?b.project_id:selectedProject;
        setDraft(b?{id:b.id,start:toHM(b.start),end:toHM(b.end),projectId,note:b.note||'',editing:true}:{id:'',start:toHM(r.at),end:toHM(r.at+r.span),projectId,note:'',editing:true});
       }}><Pencil/></Button>
       {!r.id.startsWith('auto:')&&<Button type="button" size="icon" variant="ghost" aria-label="Удалить интервал" disabled={busy} onClick={()=>remove(r.id!)}><Trash2/></Button>}
      </>}</td>}
     </tr>):<tr><td colSpan={editable?5:4}>За этот день учёта нет</td></tr>}
    </tbody>
   </table>
  </div>
  <p className="muted ledger-sum">Затрекал {hms(logged)}, по скриншотам {shots?hms(byShots):'…'}. <button type="button" className="text-link" onClick={()=>onShots(date)}>Открыть скриншоты</button></p>
 </div>;
}

export function EmployeeShots({name,personId,api,date,onDate}:{name:string;personId:string;api:Api;date:string;onDate:(d:string)=>void}){
 const [size,setSize]=useState('small');
 const [shots,setShots]=useState<Any[]|null>(null);
 const [sessions,setSessions]=useState<Session[]>([]);
 const [projects,setProjects]=useState<Any[]>([]);
 const [viewer,setViewer]=useState<Any|null>(null);
 const [err,setErr]=useState('');
 const projectName=(id:string)=>projects.find(p=>p.id===id)?.name||'Без проекта';
 useEffect(()=>{
  let dead=false;
  (async()=>{
   try{
    const [s,d]=await Promise.all([
     api(`screenshots?person=${encodeURIComponent(personId)}&date=${date}`),
     api(`data?period=day&date=${date}`),
    ]);
    if(dead)return;
    setShots(s.shots||[]);setSessions(d.sessions||[]);setProjects(d.projects||[]);setErr('');
   }catch(e:any){if(!dead)setErr(e.message);}
  })();
  return()=>{dead=true;};
 },[api,personId,date]);
 const rows=buildRows(onDay(sessions,date),shots||[],projectName);
 const loose=rows.filter(r=>r.status==='снимок экрана').flatMap(r=>r.shots);
 const blocks=rows.filter(r=>r.status!=='снимок экрана');
 const thumb=(s:Any)=><button key={s.id} type="button" onClick={()=>setViewer(s)}><img src={`/api/screenshots/file?id=${encodeURIComponent(s.id)}`} alt={`Снимок ${clock(s.taken_at)}`}/><small>{clock(s.taken_at)}</small></button>;
 return <div>
  <div className="heading"><div><div className="eyebrow">СНИМКИ ЭКРАНА</div><h1>{name}</h1><p className="muted">Только ваши кадры за выбранный день.</p></div></div>
  <DayNav date={date} onDate={onDate}/>
  <div className="section-head"><h2>За день</h2><label className="ledger-size">Размер <Select aria-label="Размер скриншотов" value={size} onChange={e=>setSize(e.target.value)}><option value="small">маленькие</option><option value="large">большие</option></Select></label></div>
  {err&&<div className="error" role="alert">{err}</div>}
  {!shots?<p className="muted">Загрузка…</p>:(blocks.length||loose.length)?<>
   {blocks.map((r,i)=><div className={'shot-block'+(size==='large'?' large':'')} key={i}>
    <div className="shot-block-meta"><span>{clock(r.at)}</span><span>{r.note?`${r.status} - ${r.note}`:r.status}</span><span>{r.task}</span><span>{r.comment}</span></div>
    {r.leave?null:r.shots.length?<div className="shot-block-grid">{r.shots.map(thumb)}</div>:<p className="shot-missing">Не было скриншота<br/>{hmWords(r.span)}<br/>Работа без скриншотов</p>}
   </div>)}
   {loose.length>0&&<div className={'shot-block-grid'+(size==='large'?' large':'')}>{loose.map(thumb)}</div>}
  </>:<p className="muted">За этот день снимков и интервалов нет.</p>}
  {viewer&&<ShotFilm shots={(shots||[]).slice().sort((a,b)=>a.taken_at-b.taken_at)} current={viewer} onPick={setViewer} onClose={()=>setViewer(null)} caption={clock(viewer.taken_at)}/>}
 </div>;
}
