'use client';
import {useEffect,useState} from 'react';
import {CalendarDays,ChevronLeft,ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {formatDuration} from '@/lib/time';

type Any=Record<string,any>;
const money=(cents:number)=>(cents/100).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const ny=(ms:number)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'America/New_York',day:'2-digit',month:'2-digit',year:'numeric'}).format(ms);
const nyInput=(ms:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);

export function PayDesk({api,act,demo,period,date,setPeriod,setDate,moveDate,busy}:{
 api:(path:string)=>Promise<Any>;act:(path:string,body:Any,success?:string)=>Promise<Any>;demo:boolean;
 period:string;date:string;setPeriod:(v:string)=>void;setDate:(v:string)=>void;moveDate:(d:number)=>void;busy:boolean;
}){
 const [view,setView]=useState<Any|null>(null),[open,setOpen]=useState(''),[localError,setLocalError]=useState('');
 useEffect(()=>{if(demo)return;let stop=false;(async()=>{try{const r=await api(`pay?period=${period}&date=${date}`);if(!stop){setView(r);setLocalError('');}}catch(e:any){if(!stop)setLocalError(e.message);}})();return()=>{stop=true;};},[api,demo,period,date]);
 async function save(body:Any){const r=await act('pay',body,body.kind==='rate'?'Ставка сохранена':'Бюджет сохранён');if(!r)return;setOpen('');try{setView(await api(`pay?period=${period}&date=${date}`));}catch(e:any){setLocalError(e.message);}}
 if(demo)return <section className="empty"><h3>Оплата</h3><p>Ставки и лимиты задаются в рабочей программе.</p></section>;
 const rates:Any[]=view?.rates||[],budgets:Any[]=view?.budgets||[],people:Any[]=(view?.people||[]).filter((p:Any)=>p.active),projects:Any[]=(view?.projects||[]).filter((p:Any)=>p.active);
 const periodRows:Any[]=view?.period?.byProject||[],uses:Any[]=view?.budgetUse||[];
 const limit=budgets.reduce((s,b)=>s+b.usd_cents,0),spent=uses.reduce((s,b)=>s+b.spent_cents,0);
 const monthStart=date.slice(0,8)+'01';
 const monthEnd=new Date(Date.UTC(Number(date.slice(0,4)),Number(date.slice(5,7)),0)).toISOString().slice(0,10);
 return <><div className="heading"><div><div className="eyebrow">ПЛАН, ЧАСЫ И СТОИМОСТЬ</div><h1>Оплата</h1><p className="muted">Финансовые данные · доступ руководителя и администратора · USD · часы по скриншотам</p></div></div>
 <div className="report-toolbar"><div className="report-controls"><div className="segmented">{[['day','День'],['week','Неделя'],['month','Месяц'],['year','Год']].map(([v,l])=><button key={v} aria-pressed={period===v} onClick={()=>setPeriod(v)}>{l}</button>)}</div><div className="date-control"><CalendarDays size={16} aria-hidden="true"/><Button variant="ghost" size="icon" aria-label="Предыдущий период" onClick={()=>moveDate(-1)}><ChevronLeft/></Button><Input aria-label="Дата отчёта" type="date" value={date} onChange={e=>e.target.value&&setDate(e.target.value)}/><Button variant="ghost" size="icon" aria-label="Следующий период" onClick={()=>moveDate(1)}><ChevronRight/></Button></div></div></div>
 {localError&&<div className="error" role="alert">{localError}</div>}
 {!view&&!localError&&<p className="muted">Считаем…</p>}
 {view&&<><div className="own-stats"><section><span>Учтённое время</span><strong>{formatDuration(view.period.ms)}</strong><small>Скриншоты выбранного отчёта</small></section><section><span>Себестоимость</span><strong>{money(view.period.cents)}</strong><small>{view.period.unpriced?`Без ставки: ${formatDuration(view.period.unpriced)}`:'Все часы со ставкой'}</small></section><section><span>Лимиты проектов</span><strong>{money(limit)}</strong><small>{budgets.length?`${budgets.length} задано`:'Бюджеты не заданы'}</small></section><section><span>Остаток лимитов</span><strong className={spent>limit&&limit?'pay-over':''}>{money(limit-spent)}</strong><small>Лимит минус часы внутри периода бюджета</small></section></div>
 <div className="section-head"><div><h2>Проекты · план и факт</h2><span className="section-caption">Бюджет имеет собственный период</span></div></div>
 <div className="project-grid">{projects.map(p=>{const row=periodRows.find(r=>r.id===p.id)||{ms:0,cents:0,unpriced:0};const budget=budgets.find(b=>b.project_id===p.id);const use=uses.find(b=>b.project_id===p.id);const editing=open==='budget:'+p.id;return <article className="project-card pay-card" key={p.id}><h2>{p.name}</h2><dl className="pay-lines"><dt>Часы выбранного отчёта</dt><dd>{formatDuration(row.ms)}</dd><dt>Себестоимость</dt><dd>{money(row.cents)}</dd>{row.unpriced?<><dt>Без ставки</dt><dd>{formatDuration(row.unpriced)}</dd></>:null}</dl>{budget?<dl className="pay-lines"><dt>Лимит</dt><dd>{money(budget.usd_cents)}</dd><dt>Период бюджета</dt><dd>{ny(budget.start)} — {ny(budget.end-1000)}</dd><dt>Израсходовано</dt><dd className={use&&use.spent_cents>budget.usd_cents?'pay-over':''}>{money(use?.spent_cents||0)}</dd><dt>Остаток</dt><dd>{money(budget.usd_cents-(use?.spent_cents||0))}</dd></dl>:<p className="muted">Бюджет не задан.</p>}{editing?<form className="pay-form" onSubmit={e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));save({kind:'budget',projectId:p.id,usd:v.usd,start:v.start,end:v.end});}}><label>Лимит, $<Input name="usd" inputMode="decimal" defaultValue={budget? (budget.usd_cents/100).toFixed(2):''} required/></label><label>С<Input name="start" type="date" defaultValue={budget?nyInput(budget.start):monthStart} required/></label><label>По<Input name="end" type="date" defaultValue={budget?nyInput(budget.end-1000):monthEnd} required/></label><Button type="submit" disabled={busy}>Сохранить</Button></form>:<Button variant="outline" onClick={()=>setOpen('budget:'+p.id)}>{budget?'Изменить бюджет':'Задать бюджет'}</Button>}</article>;})}</div>
 <div className="section-head"><div><h2>Почасовая ставка</h2><span className="section-caption">USD в час · история сохраняется · ставка не меняется задним числом</span></div></div>
 <div className="team-grid">{people.map(p=>{const own=rates.filter(r=>r.person_id===p.id).sort((a,b)=>b.effective_from-a.effective_from);const current=own.find(r=>r.effective_from<=Date.now())||null;const editing=open==='rate:'+p.id;return <article className="team-card" key={p.id}><h2>{p.name}</h2>{current?<p className="pay-rate">{money(current.usd_cents)} <small>/ ч · с {ny(current.effective_from)}</small></p>:<p className="muted">Ставка не задана. Часы без ставки не входят в себестоимость.</p>}{own.length>0&&<ul className="pay-history">{own.map(r=><li key={r.id}>{money(r.usd_cents)} / ч · с {ny(r.effective_from)}</li>)}</ul>}{editing?<form className="pay-form" onSubmit={e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));save({kind:'rate',personId:p.id,usd:v.usd,from:v.from});}}><label>USD в час<Input name="usd" inputMode="decimal" required placeholder="30"/></label><label>С даты<Input name="from" type="date" required defaultValue={date}/></label><Button type="submit" disabled={busy}>Сохранить</Button></form>:<Button variant="outline" onClick={()=>setOpen('rate:'+p.id)}>Задать ставку</Button>}</article>;})}</div>
 {!rates.length&&<p className="muted">Ставки не заданы. Суммы не считаются для часов без ставки.</p>}</>}
 </>;
}
