import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks, pruneCheckArtifacts } from './parallel-checks.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withinBudget } from './acceptance/lifecycle.mjs';

test('completed verdicts are emitted before a blocked peer finishes; failures retain their output', async () => {
  const runner = new URL('./parallel-checks.mjs', import.meta.url).href;
  const fs = await import('node:fs');
  const os = await import('node:os');
  const directory = fs.mkdtempSync(`${os.tmpdir()}/omc-parallel-`);
  const release = `${directory}/release`;
  const held = `const fs=require('fs');const finish=()=>{if(fs.existsSync(${JSON.stringify(release)})){console.error('held-detail');process.exit(1);}};fs.watch(${JSON.stringify(directory)},finish);finish();`;
  const source = `import {runChecks} from ${JSON.stringify(runner)};
    const ok=await runChecks([
      {label:'fast',command:'node',args:['-e','console.log("fast-detail")']},
      {label:'held',command:'node',args:['-e',${JSON.stringify(held)}]}
    ],{quiet:true});process.exitCode=ok?0:1;`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
  let output='', errors='';
  child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('PASS fast'))fs.writeFileSync(release,'go');});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  try {
    const [code] = await withinBudget(once(child,'close'),5000,'parallel completion');
    assert.equal(code,1);assert.match(output,/PASS fast/);assert.doesNotMatch(output,/fast-detail/);
    assert.match(errors,/FAIL held/);assert.match(errors,/held-detail/);
  } finally {child.kill('SIGKILL');fs.rmSync(directory,{recursive:true,force:true});}
});

test('cancellation terminates the owned check and remains a failed verdict', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-check-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ready = path.join(directory, 'ready');
  const controller = new AbortController();
  let childPid;
  const watcher = fs.watch(directory, () => {
    if (!fs.existsSync(ready)) return;
    const candidate = Number(fs.readFileSync(ready, 'utf8'));
    if (!Number.isSafeInteger(candidate) || candidate <= 0) return;
    childPid = candidate;
    controller.abort();
  });
  t.after(() => watcher.close());
  const deadline = setTimeout(() => controller.abort(), 5000);
  t.after(() => clearTimeout(deadline));
  const hasPassed = await runChecks([{ label: 'cancelled check', command: 'node', args: ['--input-type=module', '-e', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`] }], { quiet: true, signal: controller.signal });
  assert.equal(hasPassed, false);
  assert.ok(childPid, 'the check reached its observable readiness');
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});


test('a completed detached check cannot leave an inherited worker running', async context => {
  if (process.platform === 'win32') return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-check-descendant-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ready = path.join(directory, 'worker');
  const source = `const fs=require('fs'),cp=require('child_process');const worker=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},String(worker.pid));worker.unref();`;
  assert.equal(await runChecks([{ label: 'owned descendant', command: 'node', args: ['-e', source] }], { quiet: true }), true);
  const workerPid = Number(fs.readFileSync(ready, 'utf8'));
  context.after(() => { try { process.kill(workerPid, 'SIGKILL'); } catch {} });
  const isRunning = () => {
    try {
      process.kill(workerPid, 0);
      if (process.platform === 'linux') return fs.readFileSync(`/proc/${workerPid}/stat`, 'utf8').split(') ')[1][0] !== 'Z';
      return true;
    } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return false; throw error; }
  };
  const { until } = await import('./acceptance/harness.mjs');
  await until(() => !isRunning(), { label: 'owned descendant exited', timeoutMs: 2000 });
});


test('artifact retention removes only expired files belonging to inactive owners', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-check-retention-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = Date.now();
  const old = new Date(now - 31 * 24 * 60 * 60 * 1000);
  const expired = ['111-failed-check-1.stdout.log', '111-failed-check-1.stderr.log', '111-1.json'];
  const retained = ['222-live-1.stdout.log', '222-1.json', '111-recent-failure-2.stderr.log', 'foreign.log'];
  for (const name of [...expired, ...retained]) {
    fs.writeFileSync(path.join(directory, name), 'diagnostic evidence');
    if (!name.includes('recent')) fs.utimesSync(path.join(directory, name), old, old);
  }
  fs.mkdirSync(path.join(directory, '111-directory-1.stdout.log'));
  pruneCheckArtifacts(directory, { now, isOwnerAlive: pid => pid === 222 });
  for (const name of expired) assert.equal(fs.existsSync(path.join(directory, name)), false);
  for (const name of retained) assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), 'diagnostic evidence');
  assert.ok(fs.statSync(path.join(directory, '111-directory-1.stdout.log')).isDirectory());
});
