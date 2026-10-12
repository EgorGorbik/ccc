import {env} from '@/lib/runtime';
import {query,first} from './server';
import {emailReady} from './email';

// Read-only diagnostics. This endpoint requires the administrator profile.
export async function readiness() {
  const expected: Record<string,string[]> = {
    settings:['key','value'],people:['id','code_hash','auth_version'],
    logins:['hash','auth_version'],login_codes:['id','auth_version'],
    projects:['id'],devices:['id','pending_count','review_count'],events:['id','seq'],
    corrections:['session_id','original_start','original_end'],audit:['id'],
    attempts:['key'],review_events:['id','status'],session_archive:['id','event_ids'],
    backups:['id','verified','object_key'],
    pay_rates:['id','person_id','usd_cents','effective_from'],
    project_budgets:['id','project_id','usd_cents','start','end'],
    office_sessions:['id','person_id','kind','status','owner_seen'],
    office_signals:['id','session_id','payload'],
  };
  let database = 'ready', storage = 'ready';
  try {
    for(const [table,required] of Object.entries(expected)) {
      const columns = new Set((await query(`PRAGMA table_info(${table})`)).map(row=>row.name));
      if(required.some(column=>!columns.has(column))) {database='migration_required';break;}
    }
  } catch {database='unavailable';}
  try {
    if(!env.BUCKET) storage='not_configured';
    else await env.BUCKET.head('health/read-only-probe');
  } catch {storage='unavailable';}
  const latest = database==='ready'?await first('SELECT created,verified FROM backups ORDER BY created DESC LIMIT 1'):null;
  const maintenance = database==='ready'?await first("SELECT value FROM settings WHERE key='maintenance-at'"):null;
  const warnings: string[] = [];
  if(!emailReady()) warnings.push('email_not_configured_personal_codes_available');
  if(!latest) warnings.push('first_backup_required');
  else if(Date.now()-latest.created>48*3600000) warnings.push('backup_older_than_48_hours');
  return {
    ready:database==='ready'&&storage==='ready',version:'1.2.0',
    checks:{database,storage,email:emailReady()?'configured':'optional_not_configured'},
    latestBackupAt:latest?.created||null,lastMaintenanceAt:maintenance?Number(maintenance.value):null,
    warnings,serverTime:Date.now(),
  };
}
