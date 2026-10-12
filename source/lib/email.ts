import {env} from '@/lib/runtime';
export const emailReady=()=>!!env.RESEND_API_KEY&&!!env.MAIL_FROM;
export async function sendLoginEmail(email:string,code:string){
 if(!emailReady())throw new Error('Отправка почты ещё не подключена. Получите личный код у администратора.');
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.MAIL_FROM,to:[email],subject:'Код входа Falcon Time',text:`Ваш одноразовый код Falcon Time: ${code}\nОн действует 10 минут и может быть использован один раз.\nЕсли вы не запрашивали код, просто пропустите это письмо.`}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('Не удалось отправить письмо. Попробуйте позже или обратитесь к администратору.');
}
