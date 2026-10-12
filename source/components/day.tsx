'use client';
import {useState,useEffect,useCallback} from 'react';
import {ChevronLeft,ChevronRight,CalendarDays,ArrowLeft,Plus,Pencil,Trash2,Camera,Clock3} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {NativeSelect as Select} from '@/components/ui/native-select';
import {localDate,localMidnight,shotSpans} from '@/lib/time';
import {ShotFilm} from '@/components/shot-film';
import {OfficePanel} from '@/components/office-panel';

type Any=Record<string,any>;
const tz='America/New_York';
const clock=(ms:number)=>new Intl.DateTimeFormat('ru-RU',{timeZone:tz,hour:'2-digit',minute:'2-digit'}).format(ms);
// Wall-clock HH:MM on the shown local day -> unix ms.
const toMs=(date:string,hm:string)=>{const [h,m]=hm.split(':').map(Number);return localMidnight(date)+((h||0)*60+(m||0))*60000;};
// unix ms -> HH:MM in America/New_York, for prefilling the edit form.
const toHM=(ms:number)=>{const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms);const g=(k:string)=>p.find(x=>x.type===k)?.value||'00';return `${g('hour')}:${g('minute')}`;};

export function DayScreen({personId,personName,role,canEdit,projects,api,onBack,notify,initialDate}:{
 personId:string;personName:string;role:string;canEdit:boolean;projects:Any[];
 api:(path:string,body?:unknown)=>Promise<Any>;onBack:()=>void;notify:(m:string)=>void;initialDate?:string;
}){
 const [date,setDate]=useState(initialDate||localDate(Date.now()));
 const [shots,setShots]=useState<Any[]>([]);
 const [blocks,setBlocks]=useState<Any[]>([]);
 const [active,setActive]=useState<string|null>(null); // filtering block id
 const [viewer,setViewer]=useState<Any|null>(null);
 const [draft,setDraft]=useState<Any|null>(null); // {id?,start,end,projectId,note}
 const [err,setErr]=useState('');
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const projectName=(id:string)=>projects.find(p=>p.id===id)?.name||'Без проекта';
 const activeProjects=projects.filter(p=>p.active&&p.id!=='none');

 const load=useCallback(async()=>{
  setLoading(true);setErr('');
  try{
   const [s,w]=await Promise.all([
    api(`screenshots?person=${encodeURIComponent(personId)}&date=${date}`),
    api(`work-blocks?person=${encodeURIComponent(personId)}&date=${date}`),
   ]);
   setShots(s.shots||[]);setBlocks(w.blocks||[]);setActive(null);
  }catch(e:any){setErr(e.message);}finally{setLoading(false);}
 },[personId,date]);
 useEffect(()=>{load();},[load]);

 function moveDate(step:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+step);setDate(d.toISOString().slice(0,10));}

 const fallback=activeProjects.find(p=>p.id!=='none')?.id||activeProjects[0]?.id||'';
 const auto=shotSpans(shots.map(s=>s.taken_at),blocks).map(s=>({id:`auto:${s.start}`,start:s.start,end:s.end,project_id:fallback,note:'',auto:true}));
 const shown=[...blocks.map(b=>({...b,auto:false})),...auto].sort((a,b)=>a.start-b.start);
 const activeBlock=shown.find(b=>b.id===active);
 const feed=activeBlock?shots.filter(s=>s.taken_at>=activeBlock.start&&s.taken_at<activeBlock.end):shots;

 async function save(e:React.FormEvent<HTMLFormElement>){
  e.preventDefault();if(!draft)return;
  const start=toMs(date,draft.start),end=toMs(date,draft.end);
  setBusy(true);setErr('');
  try{
   await api('work-blocks',{...(draft.id?{id:draft.id}:{}),personId,projectId:draft.projectId,start,end,note:draft.note||''});
   setDraft(null);notify('Занятость сохранена');await load();
  }catch(e:any){setErr(e.message);}finally{setBusy(false);}
 }
 async function remove(id:string){
  setBusy(true);setErr('');
  try{await api('work-blocks',{id,delete:true});notify('Блок удалён');if(active===id)setActive(null);await load();}
  catch(e:any){setErr(e.message);}finally{setBusy(false);}
 }

 return <div className="day-screen">
  <div className="heading">
   <div>
    <button className="text-link" onClick={onBack} style={{marginTop:0,marginBottom:10}}><ArrowLeft size={16}/>К команде</button>
    <div className="eyebrow">ДЕНЬ СОТРУДНИКА</div>
    <h1>{personName}</h1>
    <p className="muted">America/New_York · занятость и снимки экрана за день</p>
   </div>
  </div>
  {canEdit&&<OfficePanel personId={personId} api={api}/>}
  <div className="report-toolbar"><div className="report-controls">
   <div className="date-control"><CalendarDays size={16} aria-hidden="true"/>
    <Button variant="ghost" size="icon" aria-label="Предыдущий день" onClick={()=>moveDate(-1)}><ChevronLeft/></Button>
    <Input aria-label="Дата" type="date" value={date} onChange={e=>e.target.value&&setDate(e.target.value)}/>
    <Button variant="ghost" size="icon" aria-label="Следующий день" onClick={()=>moveDate(1)}><ChevronRight/></Button>
   </div>
   {activeBlock&&<Button variant="outline" onClick={()=>setActive(null)}>Весь день</Button>}
  </div></div>

  {err&&<div className="error" role="alert">{err}</div>}

  <section className="occupancy">
   <div className="section-head"><h2>Занятость</h2>{canEdit&&!draft&&<Button variant="outline" onClick={()=>setDraft({start:'09:00',end:'17:00',projectId:fallback,note:''})}><Plus/>Добавить</Button>}</div>
   {canEdit&&draft&&<form className="block-form" onSubmit={save}>
    <label>Начало<Input type="time" value={draft.start} onChange={e=>setDraft({...draft,start:e.target.value})} required/></label>
    <label>Конец<Input type="time" value={draft.end} onChange={e=>setDraft({...draft,end:e.target.value})} required/></label>
    <label>Проект<Select value={draft.projectId} onChange={e=>setDraft({...draft,projectId:e.target.value})}>{activeProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
    <label>Заметка<Input value={draft.note} onChange={e=>setDraft({...draft,note:e.target.value})} maxLength={500} placeholder="Необязательно"/></label>
    <div className="block-form-actions"><Button type="submit" disabled={busy}>{busy?'Сохраняем…':'Сохранить'}</Button><Button type="button" variant="ghost" onClick={()=>{setDraft(null);setErr('');}}>Отмена</Button></div>
   </form>}
   {shown.length?<div className="block-list">{shown.map(b=><div key={b.id} className={'block-row'+(active===b.id?' selected':'')}>
    <button className="block-main" onClick={()=>setActive(active===b.id?null:b.id)} aria-pressed={active===b.id}>
     <span className="block-time"><Clock3 size={15}/>{clock(b.start)} — {clock(b.end)}</span>
     <span className="block-project">{projectName(b.project_id&&b.project_id!=='none'?b.project_id:fallback)}</span>
     {b.note&&<span className="block-note">{b.note}</span>}
    </button>
    {canEdit&&<div className="block-actions">
     <Button size="icon" variant="ghost" aria-label="Изменить блок" onClick={()=>setDraft({...(b.auto?{}:{id:b.id}),start:toHM(b.start),end:toHM(b.end),projectId:b.project_id&&b.project_id!=='none'?b.project_id:fallback,note:b.note||''})}><Pencil/></Button>
     {!b.auto&&<Button size="icon" variant="ghost" aria-label="Удалить блок" disabled={busy} onClick={()=>remove(b.id)}><Trash2/></Button>}
    </div>}
   </div>)}</div>:<p className="muted">Блоков занятости нет{canEdit?'. Добавьте интервал, чтобы отфильтровать снимки.':'.'}</p>}
  </section>

  <section className="feed">
   <div className="section-head"><h2>Снимки экрана</h2><span className="section-caption">{activeBlock?`${clock(activeBlock.start)} — ${clock(activeBlock.end)} · ${feed.length}`:`За день · ${shots.length}`}</span></div>
   {loading?<p className="muted">Загрузка…</p>:feed.length?<div className="shot-grid">{feed.map(s=><button key={s.id} className="shot-thumb" onClick={()=>setViewer(s)}>
    <img src={`/api/screenshots/file?id=${encodeURIComponent(s.id)}`} alt={`Снимок ${clock(s.taken_at)}`} loading="lazy"/>
    <span>{clock(s.taken_at)}</span>
   </button>)}</div>:<div className="empty"><Camera/><h3>Снимков нет</h3><p>Приложение Falcon Time на компьютере сотрудника должно быть запущено.</p></div>}
  </section>

  {viewer&&<ShotFilm shots={feed} current={viewer} onPick={setViewer} onClose={()=>setViewer(null)} caption={`${new Intl.DateTimeFormat('ru-RU',{timeZone:tz,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(viewer.taken_at)} · ${viewer.width}×${viewer.height}`}/>}
 </div>;
}
