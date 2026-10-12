chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
 if(sender.id!==chrome.runtime.id||msg.type!=='bridge')return;
 const path=String(msg.path||''),endpoint=path.split('?')[0];
 if(!new Set(['me','extension-state','devices','events','tracking','heartbeat']).has(endpoint)||!/^[-a-z]+(?:\?device=[\w%-]+)?$/.test(path)){respond({error:'Недопустимый запрос'});return;}
 (async()=>{try{const res=await fetch('/api/'+path,{method:msg.body?'POST':'GET',credentials:'same-origin',headers:msg.body?{'Content-Type':'application/json'}:{},body:msg.body?JSON.stringify(msg.body):undefined,cache:'no-store',signal:AbortSignal.timeout(20000)});const data=await res.json();respond({ok:res.ok,status:res.status,data});}catch{respond({ok:false,error:'Нет связи. Откройте кабинет и проверьте вход.'});}})();return true;
});
