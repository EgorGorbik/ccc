import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export function openDatabase(filename, migrations = path.resolve('drizzle')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), {recursive:true,mode:0o700});
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS falcon_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
  try {
    for (const name of fs.readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort()) {
      const sql=fs.readFileSync(path.join(migrations,name),'utf8');
      const checksum=createHash('sha256').update(sql).digest('hex');
      const applied=sqlite.prepare('SELECT checksum FROM falcon_migrations WHERE name=?').get(name);
      if (applied) {if(applied.checksum!==checksum)throw new Error('Previously applied migration changed: '+name);continue;}
      sqlite.exec('BEGIN IMMEDIATE');
      try {sqlite.exec(sql);sqlite.prepare('INSERT INTO falcon_migrations VALUES (?,?)').run(name,checksum);sqlite.exec('COMMIT');}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    }
  } catch(error){sqlite.close();throw error;}
  class Statement {
    constructor(sql,args=[]){this.sql=sql;this.args=args;}
    bind(...args){return new Statement(this.sql,args);}
    execute(){const results=sqlite.prepare(this.sql).all(...this.args);return {results,success:true,meta:{changes:Number(sqlite.prepare('SELECT changes() AS n').get().n)}};}
    async all(){return this.execute();}
    async first(column){const row=this.execute().results[0];return row ? (column ? row[column] : row) : null;}
    async run(){return this.execute();}
  }
  return {
    sqlite, close:()=>sqlite.close(), prepare:sql=>new Statement(sql),
    async batch(statements){
      // Deliberately no await inside this transaction: another request cannot
      // interleave writes on the same connection between statements.
      sqlite.exec('BEGIN IMMEDIATE');
      try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
}

export function fileBucket(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  function filename(key) {
    if(typeof key!=='string'||!key||key.split('/').some(p=>!p||p==='.'||p==='..'||!/^[a-zA-Z0-9._-]+$/.test(p)))throw new Error('Invalid object key');
    return path.join(directory,key);
  }
  return {
    async put(key,body){
      const target=filename(key);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      const temporary=target+'.tmp-'+randomUUID();let fd;
      try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,target);
        const parent=fs.openSync(path.dirname(target),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
      }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
      return {key};
    },
    async get(key){try{const content=fs.readFileSync(filename(key),'utf8');return {text:async()=>content};}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    async head(key){try{return {key,size:fs.statSync(filename(key)).size};}catch(e){if(e.code==='ENOENT')return null;throw e;}},
  };
}
let database, bucket;
export const nodeEnv={
  get DB(){return database??=openDatabase(path.join(process.env.FALCON_DATA_DIR||'/data','falcon.sqlite'));},
  get BUCKET(){return bucket??=fileBucket(process.env.FALCON_BACKUP_DIR||'/backups');},
  get RESEND_API_KEY(){return process.env.RESEND_API_KEY;},
  get MAIL_FROM(){return process.env.MAIL_FROM;},
};
