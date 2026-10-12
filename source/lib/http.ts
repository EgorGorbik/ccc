import {selfHosted, appOrigin} from '@/lib/runtime';
export class Problem extends Error {
  status: number;
  responseHeaders: Record<string, string>;
  constructor(message: string, status = 400, responseHeaders: Record<string, string> = {}) {
    super(message);
    this.name = 'Problem';
    this.status = status;
    this.responseHeaders = responseHeaders;
  }
}
export const fail = (message: string, status = 400, headers: Record<string,string> = {}): never => {
  throw new Problem(message, status, headers);
};
export const json = (data: unknown, status = 200, headers: Record<string,string> = {}) =>
  Response.json(data, {status, headers: {'Cache-Control': 'no-store', ...headers}});
export function field(value: unknown, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail('Проверьте заполнение полей');
  return value.trim();
}
const methods: Record<string,string|string[]> = {
  bootstrap:'GET', me:'GET', data:'GET', 'extension-state':'GET', readiness:'GET',
  'backup/download':'GET', setup:'POST', login:'POST', 'otp/request':'POST',
  logout:'POST', profile:'POST', password:'POST', projects:'POST', people:'POST', 'access-code':'POST',
  devices:'POST', 'device/revoke':'POST', tracking:'POST', heartbeat:'POST',
  events:'POST', review:'POST', backup:'POST', manual:'POST', correction:'POST',
  screenshots:['GET','POST'], 'screenshots/file':'GET', 'work-blocks':['GET','POST'], pay:['GET','POST'],
};
export function checkMethod(path: string, method: string) {
  const allowed = methods[path];
  if (!allowed) fail('Не найдено', 404);
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(method)) fail('Метод не поддерживается', 405, {Allow: list.join(', ')});
}
// Same cross-origin guard as readBody, but for a size-limited binary upload
// (the screenshot JPEG) that must not go through the JSON parser.
export async function readBinary(req: Request, limit: number): Promise<Uint8Array> {
  assertSameOrigin(req);
  if (Number(req.headers.get('content-length') || 0) > limit) fail('Слишком большой запрос',413);
  const reader = req.body?.getReader();
  if (!reader) return fail('Пустой запрос',400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); fail('Слишком большой запрос',413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk,offset); offset += chunk.byteLength; }
  return buffer;
}
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  const expectedOrigin = selfHosted ? appOrigin : new URL(req.url).origin;
  if ((selfHosted && !expectedOrigin) || (origin && origin !== expectedOrigin) || req.headers.get('sec-fetch-site') === 'cross-site') fail('Недопустимый источник запроса',403);
}
export async function readBody(req: Request): Promise<Record<string,any>> {
  if (req.method === 'GET') return {};
  assertSameOrigin(req);
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('Неверный формат',415);
  const limit = 100_000;
  if (Number(req.headers.get('content-length') || 0) > limit) fail('Слишком большой запрос',413);
  const reader = req.body?.getReader();
  if (!reader) return fail('Неверный JSON');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); fail('Слишком большой запрос',413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk,offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)); }
  catch { fail('Неверный JSON'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') fail('Неверный формат');
  return body;
}
export function apiBoundary(handler: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    const requestId = crypto.randomUUID();
    let response: Response;
    try { response = await handler(req); }
    catch (error) {
      if (error instanceof Problem) response = json({error:error.message,requestId},error.status,error.responseHeaders);
      else {
        console.error(JSON.stringify({service:'falcon-time',requestId,error:error instanceof Error?error.name:'UnknownError'}));
        response = json({error:'Не удалось выполнить запрос. Повторите позже; введённые данные сохранены на экране.',requestId},503);
      }
    }
    response.headers.set('X-Request-ID',requestId);
    response.headers.set('X-Content-Type-Options','nosniff');
    response.headers.set('Cache-Control','no-store');
    return response;
  };
}
