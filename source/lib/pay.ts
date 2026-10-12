import {query,first,run,audit} from './server';
import {localMidnight,periodBounds,trackedFromShots} from './time';

export type Rate={person_id:string;usd_cents:number;effective_from:number};
export type Span={person_id:string;project_id:string;start:number;end:number};

export function validDate(date:string){
 return /^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date+'T12:00:00Z'))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;
}
function shiftDate(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function usdCents(value:unknown,maxDollars:number){
 const n=typeof value==='number'?value:Number(String(value??'').replace(',','.'));
 if(!Number.isFinite(n)||n<=0||n>maxDollars)return null;
 const cents=Math.round(n*100);
 if(Math.abs(n*100-cents)>1e-6)return null;
 return cents;
}
export function rateCents(rates:Rate[],personId:string,at:number){
 let best:Rate|null=null;
 for(const rate of rates){
  if(rate.person_id!==personId||rate.effective_from>at)continue;
  if(!best||rate.effective_from>best.effective_from)best=rate;
 }
 return best?best.usd_cents:null;
}
export function costCents(ms:number,hourlyCents:number){
 return Math.round(ms/3600000*hourlyCents);
}
export function price(spans:Span[],rates:Rate[]){
 let cents=0,priced=0,unpriced=0;
 const byProject=new Map<string,{cents:number;ms:number;unpriced:number}>();
 for(const span of spans){
  const ms=Math.max(0,span.end-span.start);
  const hourly=rateCents(rates,span.person_id,span.start);
  const row=byProject.get(span.project_id)||{cents:0,ms:0,unpriced:0};
  row.ms+=ms;
  if(hourly==null){unpriced+=ms;row.unpriced+=ms;}
  else {const part=costCents(ms,hourly);cents+=part;priced+=ms;row.cents+=part;}
  byProject.set(span.project_id,row);
 }
 return {cents,priced,unpriced,byProject};
}

async function windowSpans(from:number,to:number):Promise<Span[]>{
 const shots=await query('SELECT person_id,taken_at FROM screenshots WHERE taken_at>=? AND taken_at<?',from,to);
 const blocks=await query('SELECT person_id,project_id,start,end FROM work_blocks WHERE start<? AND end>?',to,from);
 const fallback=await first("SELECT id FROM projects WHERE active=1 AND id<>'none' ORDER BY name LIMIT 1");
 return trackedFromShots(blocks,shots,fallback?.id||'').map(s=>({person_id:s.person_id,project_id:s.project_id,start:Math.max(s.start,from),end:Math.min(s.end,to)})).filter(s=>s.end>s.start);
}

export async function payView(period:string,date:string){
 const bounds=periodBounds(period,date);
 const rates=await query('SELECT id,person_id,usd_cents,effective_from,created FROM pay_rates ORDER BY effective_from,created');
 const budgets=await query('SELECT id,project_id,usd_cents,start,end FROM project_budgets ORDER BY project_id');
 const people=await query('SELECT id,name,role,active FROM people ORDER BY created,id');
 const projects=await query("SELECT id,name,active FROM projects WHERE id<>'none' ORDER BY name");
 const periodSpans=await windowSpans(bounds.from,bounds.to);
 const periodPrice=price(periodSpans,rates);
 const budgetUse=await Promise.all(budgets.map(async (b:any)=>{
  const spans=(await windowSpans(b.start,b.end)).filter(s=>s.project_id===b.project_id);
  const priced=price(spans,rates);
  return {project_id:b.project_id,spent_cents:priced.cents,ms:priced.priced+priced.unpriced,unpriced:priced.unpriced};
 }));
 return {
  from:bounds.from,to:bounds.to,
  rates,budgets,people,projects,
  period:{ms:periodPrice.priced+periodPrice.unpriced,cents:periodPrice.cents,unpriced:periodPrice.unpriced,byProject:[...periodPrice.byProject.entries()].map(([id,row])=>({id,...row}))},
  budgetUse,
 };
}

export async function saveRate(actor:string,personId:string,cents:number,fromDate:string){
 if(!validDate(fromDate))throw new Error('Неверная дата');
 const person=await first('SELECT id FROM people WHERE id=? AND active=1',personId);
 if(!person)throw new Error('Сотрудник не найден');
 const from=localMidnight(fromDate);
 const latest=await first('SELECT effective_from FROM pay_rates WHERE person_id=? ORDER BY effective_from DESC LIMIT 1',personId);
 if(latest&&from<latest.effective_from)throw new Error('Новая ставка не может начинаться раньше уже заданной');
 if(latest&&from===latest.effective_from)throw new Error('На эту дату ставка уже задана');
 const id=crypto.randomUUID();
 await run('INSERT INTO pay_rates (id,person_id,usd_cents,effective_from,actor,created) VALUES (?,?,?,?,?,?)',id,personId,cents,from,actor,Date.now());
 await audit(actor,'pay-rate',personId,{usd_cents:cents,effective_from:from});
 return {id};
}

export async function saveBudget(actor:string,projectId:string,cents:number,startDate:string,endDate:string){
 if(projectId==='none'||!validDate(startDate)||!validDate(endDate))throw new Error('Проверьте проект и даты');
 const project=await first('SELECT id FROM projects WHERE id=? AND active=1',projectId);
 if(!project)throw new Error('Проект не найден');
 const start=localMidnight(startDate),end=localMidnight(shiftDate(endDate,1));
 if(end<=start)throw new Error('Конец бюджета должен быть позже начала');
 const id=crypto.randomUUID();
 await run('INSERT INTO project_budgets (id,project_id,usd_cents,start,end,actor,created) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET usd_cents=excluded.usd_cents,start=excluded.start,end=excluded.end,actor=excluded.actor,created=excluded.created',id,projectId,cents,start,end,actor,Date.now());
 await audit(actor,'pay-budget',projectId,{usd_cents:cents,start,end});
 return {id};
}
