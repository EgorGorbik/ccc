import type {ChatGPTUser} from '../app/chatgpt-auth';
import {db, first, run, query, hash, token, codeHash, verify, initialize, auditStatement} from './server';
import {emailReady, sendLoginEmail} from './email';
import {field, fail, json} from './http';

async function bindAccount(userId: string) {
  await run("INSERT OR IGNORE INTO settings (key,value) VALUES ('account',?)", userId);
}
export const safePerson = (p: any) => {
  const {code_hash, auth_version, hash: loginHash, platform_id, expires, ...rest} = p;
  return {...rest,has_code:p.has_code??!!code_hash};
};
export async function limitAttempts(key: string, limit: number, window: number) {
  const now = Date.now();
  const row = await first(`INSERT INTO attempts (key,count,until) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until<=? THEN 1 ELSE count+1 END,
    until=CASE WHEN until<=? THEN excluded.until ELSE until END RETURNING count,until`,key,now+window,now,now);
  if (row.count > limit) fail('Слишком много попыток. Повторите позже.',429,{'Retry-After':String(Math.max(1,Math.ceil((row.until-now)/1000)))});
}
export async function authenticate(req: Request, platformId: string) {
  const raw = req.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('falcon_profile='))?.slice(15);
  if (!raw || !/^[a-f0-9]{48}$/.test(raw)) return fail('Введите личный код сотрудника',401);
  const loginHash = await hash(raw);
  const person = await first(`SELECT p.* FROM logins l JOIN people p ON p.id=l.person_id
    WHERE l.hash=? AND l.platform_id=? AND l.expires>? AND p.active=1 AND l.auth_version=p.auth_version`,loginHash,platformId,Date.now());
  if (!person) return fail('Введите личный код сотрудника',401);
  return {raw,loginHash,person,me:safePerson(person)};
}
export async function publicAuth(path: string, b: Record<string,any>, platform: ChatGPTUser): Promise<Response|null> {
  if (path === 'bootstrap') {
    await initialize();
    if (!platform.selfHosted) await bindAccount(platform.userId);
    const owner = await first('SELECT code_hash FROM people WHERE id=?','zafar');
    if (platform.selfHosted) return json({selfHosted:true,setup:false,emailEnabled:emailReady(),people:[]});
    return json({setup:!owner.code_hash,platformEmail:platform.email,emailEnabled:emailReady(),people:await query('SELECT id,name,role,active FROM people WHERE active=1')});
  }
  if (path === 'otp/request') {
    const id = field(b.id,80);
    const p = await first('SELECT * FROM people WHERE id=? AND active=1',id);
    if (!p?.email || !p.onboarded) fail('Для первого входа получите код у администратора');
    if (!emailReady()) fail('Отправка почты ещё не подключена. Используйте личный код.',503);
    await limitAttempts(platform.userId+':mail:'+id,3,600000);
    const at = Date.now(), challenge = crypto.randomUUID();
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
    const codeDigest = await codeHash(code);
    const result = await db().batch([
      db().prepare('UPDATE login_codes SET used=1 WHERE person_id=? AND platform_id=?').bind(id,platform.userId),
      db().prepare(`INSERT INTO login_codes (id,person_id,platform_id,hash,expires,created,auth_version)
        SELECT ?,id,?,?,?,?,auth_version FROM people WHERE id=? AND active=1 AND auth_version=? AND email=?`).bind(challenge,platform.userId,codeDigest,at+600000,at,id,p.auth_version,p.email),
    ]);
    if (!result[1].meta.changes) fail('Доступ изменён. Запросите новый код.',409);
    try { await sendLoginEmail(p.email,code); }
    catch (error) { await run('UPDATE login_codes SET used=1 WHERE id=?',challenge); fail(error instanceof Error?error.message:'Ошибка почты',503); }
    return json({ok:true,challenge,expires:at+600000});
  }
  if (!['setup','login'].includes(path)) return null;
  if (platform.selfHosted && path==='setup') fail('Владелец настраивается только на сервере',403);
  await initialize();
  if (!platform.selfHosted) await bindAccount(platform.userId);
  const id = path==='setup'?'zafar':field(b.id,80);
  const key = platform.userId+':'+(platform.selfHosted?await hash(platform.clientAddress||'unknown')+':':'')+id;
  // Do not create unbounded attempt rows from arbitrary public login IDs.
  if (platform.selfHosted && !await first('SELECT id FROM people WHERE id=? AND active=1',id)) fail('Неверные данные входа',401);
  await limitAttempts(key,5,900000);
  const code = field(b.code,200), at = Date.now();
  let p = await first('SELECT * FROM people WHERE id=? AND active=1',id);
  if (!p) return fail('Неверные данные входа',401);
  if (path === 'setup') {
    if (p.code_hash) fail('Кабинет уже настроен',409);
    if (code.length<10) fail('Личный код должен содержать не менее 10 символов');
    const digest = await codeHash(code);
    const result = await db().batch([
      db().prepare(`INSERT OR IGNORE INTO settings (key,value)
        SELECT 'account',? WHERE EXISTS (SELECT 1 FROM people WHERE id='zafar' AND code_hash IS NULL)`).bind(platform.userId),
      db().prepare(`UPDATE people SET code_hash=?,auth_version=auth_version+1 WHERE id='zafar' AND code_hash IS NULL
        AND EXISTS (SELECT 1 FROM settings WHERE key='account' AND value=?)`).bind(digest,platform.userId),
      auditStatement('zafar','setup','account',{binding:'ChatGPT'},true),
    ]);
    if (!result[1].meta.changes) fail('Кабинет уже настроен',409);
    p = {...p,code_hash:digest,auth_version:p.auth_version+1};
  }
  const raw = token(), loginHash = await hash(raw);
  if (path==='login' && b.challenge) {
    const otp = await first(`SELECT * FROM login_codes WHERE id=? AND person_id=? AND platform_id=?
      AND used=0 AND expires>? AND auth_version=?`,field(b.challenge,80),id,platform.userId,at,p.auth_version);
    if (!otp) return fail('Код неверный или истёк',401);
    // Short email codes need a shared challenge budget across IP addresses.
    await limitAttempts('otp:'+otp.id,5,600000);
    if (!(await verify(code,otp.hash))) return fail('Код неверный или истёк',401);
    const result = await db().batch([
      db().prepare(`INSERT INTO logins (hash,person_id,platform_id,expires,auth_version)
        SELECT ?,p.id,?,?,p.auth_version FROM people p JOIN login_codes c ON c.person_id=p.id
        WHERE c.id=? AND c.used=0 AND c.expires>? AND p.active=1 AND p.auth_version=?
        AND c.auth_version=p.auth_version AND c.platform_id=?`).bind(loginHash,platform.userId,at+30*86400000,otp.id,at,p.auth_version,platform.userId),
      db().prepare('UPDATE login_codes SET used=1 WHERE id=? AND changes()>0').bind(otp.id),
    ]);
    if (!result[0].meta.changes) fail('Код уже использован или доступ изменён',401);
  } else {
    if (path==='login' && (!p.code_hash || !(await verify(code,p.code_hash)))) fail('Неверные данные входа',401);
    const result = await run(`INSERT INTO logins (hash,person_id,platform_id,expires,auth_version)
      SELECT ?,id,?,?,auth_version FROM people WHERE id=? AND active=1 AND auth_version=? AND code_hash=?
      AND EXISTS (SELECT 1 FROM settings WHERE key='account' AND value=?)`,loginHash,platform.userId,at+30*86400000,id,p.auth_version,p.code_hash,platform.userId);
    if (!result.meta.changes) fail('Доступ изменён. Войдите с новым кодом.',401);
  }
  await run('DELETE FROM attempts WHERE key=?',key);
  return json({ok:true},200,{'Set-Cookie':`falcon_profile=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`});
}
