import {env} from '@/lib/runtime';
import {db,first,query,run,auditStatement} from './server';
import {fail} from './http';
import {localMidnight} from './time';

export const SHOT_LIMIT = 2 * 1024 * 1024; // 2 MB per frame.

// Read real pixel dimensions from the JPEG itself instead of trusting the
// client, and reject anything that is not a baseline/progressive JPEG.
export function jpegSize(bytes: Uint8Array): {width: number; height: number} {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('Это не файл JPEG', 415);
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) { offset++; marker = bytes[offset + 1]; }
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2) break;
    // Frame headers (SOF0..SOF15) carry the dimensions; skip DHT/DAC/JPG tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 7 >= bytes.length) break;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width > 0 && height > 0) return {width, height};
    }
    offset += length;
  }
  return fail('Не удалось прочитать размер кадра', 415);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
}

const shotKey = (personId: string, id: string) => `${personId}/${id}.jpg`;

// Members see only themselves; owners and admins see any active employee.
export async function assertCanView(me: any, admin: boolean, personId: string) {
  if (personId === me.id) return;
  if (!admin) fail('Нет доступа к снимкам другого сотрудника', 403);
  const target = await first('SELECT id FROM people WHERE id=? AND active=1', personId);
  if (!target) fail('Сотрудник не найден', 404);
}

export function dayBounds(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date) fail('Неверная дата');
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return {from: localMidnight(date), to: localMidnight(next)};
}

export async function storeScreenshot(personId: string, id: string, takenAt: number, bytes: Uint8Array, now = Date.now()) {
  if (!env.SHOTS) fail('Хранилище снимков не подключено', 503);
  if (bytes.byteLength === 0 || bytes.byteLength > SHOT_LIMIT) fail('Размер кадра вне допустимого диапазона', 413);
  if (!Number.isSafeInteger(takenAt) || takenAt > now + 5000 || takenAt < now - 7 * 86400000) fail('Проверьте время кадра');
  // A replayed id from the offline queue must never create a second record.
  const existing = await first('SELECT person_id,taken_at FROM screenshots WHERE id=?', id);
  if (existing) {
    if (existing.person_id !== personId) fail('ID уже занят', 409);
    return {id, taken_at: existing.taken_at, duplicate: true};
  }
  const {width, height} = jpegSize(bytes);
  const sha256 = await sha256Hex(bytes);
  // Write the file first; only record metadata once the bytes are safely stored.
  await env.SHOTS.put(shotKey(personId, id), bytes);
  const result = await run(
    `INSERT OR IGNORE INTO screenshots (id,person_id,taken_at,bytes,sha256,width,height)
     SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM people WHERE id=? AND active=1)`,
    id, personId, takenAt, bytes.byteLength, sha256, width, height, personId,
  );
  if (!result.meta.changes) {
    const raced = await first('SELECT taken_at FROM screenshots WHERE id=? AND person_id=?', id, personId);
    if (raced) return {id, taken_at: raced.taken_at, duplicate: true};
    fail('Сотрудник отключён или ID уже занят', 409);
  }
  return {id, taken_at: takenAt, duplicate: false};
}

export async function listScreenshots(personId: string, date: string) {
  const {from, to} = dayBounds(date);
  return query(
    'SELECT id,person_id,taken_at,bytes,width,height FROM screenshots WHERE person_id=? AND taken_at>=? AND taken_at<? ORDER BY taken_at',
    personId, from, to,
  );
}

export async function screenshotOwner(id: string): Promise<string> {
  const meta = await first('SELECT person_id FROM screenshots WHERE id=?', id);
  if (!meta) fail('Снимок не найден', 404);
  return meta.person_id;
}
export async function screenshotFile(personId: string, id: string): Promise<ArrayBuffer> {
  if (!env.SHOTS) fail('Хранилище снимков не подключено', 503);
  // The stored path is derived from the record, never from client input.
  const object = await env.SHOTS.get(shotKey(personId, id));
  if (!object) fail('Файл снимка недоступен', 404);
  return object.arrayBuffer();
}

// ---- Work blocks (manual occupancy, administrator-edited) ----

export async function listWorkBlocks(personId: string, date: string) {
  const {from, to} = dayBounds(date);
  return query(
    'SELECT * FROM work_blocks WHERE person_id=? AND start<? AND end>? ORDER BY start',
    personId, to, from,
  );
}

export async function writeWorkBlock(actor: string, b: Record<string, any>) {
  const id = b.id ? field80(b.id) : 'wb-' + crypto.randomUUID();
  if (b.delete === true) {
    const existing = await first('SELECT id,person_id FROM work_blocks WHERE id=?', id);
    if (!existing) fail('Блок не найден', 404);
    await db().batch([
      db().prepare('DELETE FROM work_blocks WHERE id=?').bind(id),
      auditStatement(actor, 'work-block', id, {personId: existing.person_id, deleted: true}, true),
    ]);
    return {ok: true, id, deleted: true};
  }
  const personId = field80(b.personId), projectId = field80(b.projectId);
  const start = Number(b.start), end = Number(b.end);
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : '';
  if (!await first('SELECT id FROM people WHERE id=? AND active=1', personId)) fail('Сотрудник не найден');
  if (!await first('SELECT id FROM projects WHERE id=? AND active=1', projectId)) fail('Проект не найден или в архиве');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) fail('Проверьте начало и конец');
  const now = Date.now();
  // Conditional write rejects any interval that overlaps another block for the
  // same person, closing the race between two administrators editing at once.
  const result = await db().batch([
    db().prepare(
      `INSERT INTO work_blocks (id,person_id,project_id,start,end,note,actor,updated)
       SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM work_blocks WHERE person_id=? AND id<>? AND start<? AND end>?)
       ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,start=excluded.start,end=excluded.end,note=excluded.note,actor=excluded.actor,updated=excluded.updated
       WHERE NOT EXISTS (SELECT 1 FROM work_blocks WHERE person_id=? AND id<>? AND start<? AND end>?)`,
    ).bind(id, personId, projectId, start, end, note, actor, now, personId, id, end, start, personId, id, end, start),
    auditStatement(actor, 'work-block', id, {personId, projectId, start, end}, true),
  ]);
  if (!result[0].meta.changes) fail('Время пересекается с другим блоком занятости', 409);
  return {ok: true, id};
}

function field80(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) return fail('Проверьте заполнение полей');
  return value.trim();
}
