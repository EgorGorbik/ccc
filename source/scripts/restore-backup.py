#!/usr/bin/env python3
"""Restore an exported Falcon Time snapshot into a NEW, isolated SQLite database."""
import json, sqlite3, sys
from pathlib import Path
if len(sys.argv) != 3:
    raise SystemExit('Usage: python scripts/restore-backup.py snapshot.json NEW-database.sqlite')
source, destination = map(Path, sys.argv[1:])
if destination.exists():
    raise SystemExit('Refusing to replace an existing database. Choose a new path.')
data = json.loads(source.read_text())
if data.get('format') != 'falcon-time-backup' or data.get('version') != 1:
    raise SystemExit('Use the full backup downloaded from the owner cabinet.')
allowed = {'settings','people','projects','devices','events','corrections','audit','review_events','session_archive'}
if set(data.get('tables', {})) - allowed:
    raise SystemExit('Unexpected table in backup.')
required = {'settings','people','projects','devices','events','corrections','audit'}
if not required.issubset(data['tables']):
    raise SystemExit('Backup is missing required tables.')
db = sqlite3.connect(':memory:')
root = Path(__file__).resolve().parent.parent
for migration in sorted((root/'drizzle').glob('*.sql')):
    db.executescript(migration.read_text())
with db:
    for table, rows in data['tables'].items():
        allowed_columns = {c[1] for c in db.execute(f'PRAGMA table_info("{table}")')}
        for row in rows:
            if set(row) - allowed_columns:
                raise ValueError(f'Unexpected column in {table}')
            columns = list(row)
            quoted = ','.join(f'"{c}"' for c in columns)
            db.execute(f'INSERT INTO "{table}" ({quoted}) VALUES ({",".join("?" for _ in columns)})', [row[c] for c in columns])
    db.execute('UPDATE devices SET active=0')
    db.execute("UPDATE people SET code_hash=NULL WHERE role NOT IN ('owner','admin')")
    db.execute("DELETE FROM settings WHERE key IN ('backup-lease','backup-error')")
    db.execute('INSERT INTO audit (id,actor,action,target,detail,at) VALUES (lower(hex(randomblob(16))),?,?,?,?,CAST(strftime(\'%s\',\'now\') AS INTEGER)*1000)',('restore-tool','restore','database',json.dumps({'source_date':data['created'],'devices_disabled':True})))
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
# Exclusive creation happens only after complete parsing and validation.
with destination.open('xb'):
    pass
out = sqlite3.connect(destination)
db.backup(out)
print(f'Restored {len(data["tables"])} tables. Integrity OK. Devices disabled; issue new employee codes before reconnecting.')
out.close();db.close()
