import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { isolatedAppEnvironment } from './acceptance/environment.mjs';
import { stopProcess, closeServer } from './acceptance/lifecycle.mjs';
import { until } from './acceptance/harness.mjs';

const binary=path.resolve(process.argv[2]);
const working=fs.mkdtempSync(path.join(os.tmpdir(),'omc-runtime-smoke-'));
let child;
try {
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port;await closeServer(listener);
  const base=`http://127.0.0.1:${port}/tools/omc`;
  child=spawn(binary,[],{cwd:working,stdio:['ignore','ignore','pipe'],env:isolatedAppEnvironment({
    OMCPA_LISTEN_ADDR:`127.0.0.1:${port}`,OMCPA_BASE_PATH:'/tools/omc',OMCPA_DATA_DIR:working,
    OMCPA_MASTER_KEY:randomBytes(32).toString('hex'),OMCPA_CPA_BASE_URL:'http://127.0.0.1:1',
    OMCPA_CPA_MANAGEMENT_KEY:'synthetic-native-runtime-key',OMCPA_USAGE_INGEST_MODE:'off',
    OMCPA_UPDATE_CHECK_ENABLED:'false',OMCPA_UPDATE_CHECK_ON_PAGE_LOAD:'false',
  })});
  let output='',spawnError;child.stderr.on('data',chunk=>{output+=chunk;});child.on('error',error=>{spawnError=error;});
  let health;
  await until(async()=>{
    if(spawnError)throw spawnError;
    if(child.exitCode!==null)throw new Error(output);
    try{const response=await fetch(`${base}/api/healthz`,{signal:AbortSignal.timeout(1000)});if(response.ok){health=await response.json();return true;}}catch{}
    return false;
  },{label:'native runtime readiness'});
  assert.equal(health.database_status,'ok');
  assert.equal(health.cpa_connected,false);
  const page=await fetch(`${base}/`,{signal:AbortSignal.timeout(1000)});assert.equal(page.status,200);
  const html=await page.text();const scripts=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match=>match[1]);
  assert.ok(scripts.length>0,'Native smoke must serve embedded SPA, not placeholder HTML');
  for(const asset of scripts){assert.equal(new URL(asset,`${base}/`).origin,new URL(base).origin);assert.equal((await fetch(new URL(asset,`${base}/`),{signal:AbortSignal.timeout(1000)})).status,200);}
  assert.equal((await fetch(`${base}/api/v1/management/system`,{signal:AbortSignal.timeout(1000)})).status,401);
  console.log(`PASS native runtime ${process.platform}/${process.arch}: SQLite, embedded assets, subpath and authentication`);
}finally{await stopProcess(child);fs.rmSync(working,{recursive:true,force:true});}
