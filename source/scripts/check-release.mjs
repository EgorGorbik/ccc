import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const tests=readdirSync(resolve(root,'tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
for(const args of [
 ['node_modules/typescript/bin/tsc','--noEmit'],
 ['--no-warnings','--experimental-loader','./tests/loader.mjs','--test',...tests],
]){
 const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
console.log('Release checks passed. Build and package this exact source before deployment.');
