import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';

test('The 1.2 additive migration preserves existing identities, sessions and OTP records',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const migrations=readdirSync('drizzle').filter(name=>name.endsWith('.sql')).sort();
  for(const file of migrations.filter(name=>name<'0004'))db.exec(readFileSync('drizzle/'+file,'utf8'));
  db.exec("INSERT INTO people (id,name,role,code_hash,created) VALUES ('owner','Owner','owner','old-hash',1)");
  db.exec("INSERT INTO logins (hash,person_id,platform_id,expires) VALUES ('session','owner','platform',99999999)");
  db.exec("INSERT INTO login_codes (id,person_id,platform_id,hash,expires,created) VALUES ('otp','owner','platform','otp-hash',99999999,1)");
  for(const file of migrations.filter(name=>name>='0004'))db.exec(readFileSync('drizzle/'+file,'utf8'));
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(db.prepare("SELECT auth_version FROM people WHERE id='owner'").get().auth_version,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM logins l JOIN people p ON p.id=l.person_id AND p.auth_version=l.auth_version").get().n,1);
  assert.equal(db.prepare("SELECT hash,auth_version FROM login_codes WHERE id='otp'").get().hash,'otp-hash');
  const indices=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r=>r.name));
  for(const name of ['correction_person_interval','audit_at','backup_created'])assert.ok(indices.has(name));
 }finally{db.close();}
});
