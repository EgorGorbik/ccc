export const MAX_OFFLINE = 7 * 86400000;
export const MAX_CLOCK_SKEW = 120000;
export type IncomingEvent = {id:string;at:number;seq:number;projectId:string;kind:string;clientAt:number;clockOffset:number;clockCheckedAt:number};
export function eventIssue(e:IncomingEvent,now:number,created:number):string|null {
 if(!Number.isSafeInteger(e.seq)||e.seq<1)return 'Нет достоверного номера события';
 if(!Number.isSafeInteger(e.at)||!Number.isSafeInteger(e.clientAt)||!Number.isFinite(e.clockOffset)||!Number.isSafeInteger(e.clockCheckedAt))return 'Недостоверное время';
 if(e.at<created-5000)return 'Событие раньше подключения устройства';
 if(e.at<now-MAX_OFFLINE)return 'Старше семи дней';
 if(e.at>now+5000)return 'Событие из будущего';
 if(Math.abs(e.clockOffset)>MAX_CLOCK_SKEW)return 'Расхождение часов более двух минут';
 if(Math.abs(e.clientAt+e.clockOffset-e.at)>1000)return 'Не совпадает поправка часов';
 if(e.clockCheckedAt>now+5000||e.clockCheckedAt>e.at+5000||e.at-e.clockCheckedAt>MAX_OFFLINE)return 'Не подтверждена синхронизация часов';
 return null;
}
export function deviceHealth(d:any,now:number){
 if(!d.active)return {state:'revoked',label:'Отключено'};
 if(!d.last_seen)return {state:'waiting',label:'Ожидает подключения'};
 if(now-d.last_seen>180000)return {state:'offline',label:'Нет связи с устройством'};
 if(d.status==='clock')return {state:'clock',label:'Проверьте часы компьютера'};
 if(d.status==='auth')return {state:'auth',label:'Требуется вход'};
 if(d.pending_count>0)return {state:'pending',label:'Есть неотправленные события'};
 if(d.review_count>0)return {state:'review',label:'Есть события на проверке'};
 return {state:'connected',label:'На связи'};
}
