// Only opaque context hashes and timestamps are sent. No message text is read.
let last=0,pending=null,lastPath='';const hashes=new Map();
async function hash(value){if(!hashes.has(value))hashes.set(value,crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)).then(buffer=>Array.from(new Uint8Array(buffer)).map(x=>x.toString(16).padStart(2,'0')).join('')));return hashes.get(value);}
async function contextFor(path){const project=path.match(/^\/g\/(g-p-[^/]+)/)?.[1]||'';return {context:await hash(path),projectContext:project?await hash(project):''};}
async function send(at,path){try{await chrome.runtime.sendMessage({type:'activity',at,...await contextFor(path)});}catch{}}
function activity(e){
 if(!e.isTrusted||document.visibilityState!=='visible'||!document.hasFocus())return;
 const now=Date.now(),path=location.pathname;
 if(path!==lastPath||now-last>=10000){clearTimeout(pending);last=now;lastPath=path;send(now,path);}
 else{clearTimeout(pending);pending=setTimeout(()=>{last=now;send(now,path);},1000);}
}
for(const name of ['pointerdown','keydown','wheel','touchstart','touchmove'])document.addEventListener(name,activity,{passive:true,capture:true});
window.addEventListener('focus',activity,{passive:true});
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{if(sender.id===chrome.runtime.id&&msg.type==='context'){contextFor(location.pathname).then(respond);return true;}});
