import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MAINTENANCE_CHECKS, runMaintenanceChecks } from './maintenance-checks.mjs';
test('maintenance checks are bounded and race instrumentation never leaks into normal builds', t => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-maintenance-test-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const calls=[];
  assert.equal(runMaintenanceChecks('race',(command,args,options)=>{calls.push(options);assert.ok(args.includes('-race'));return{status:0,stdout:''};}, outputDirectory),true);
  assert.equal(calls[0].env.CGO_ENABLED,'1');assert.equal(calls[0].timeout,240_000);
  assert.equal(runMaintenanceChecks('fuzz',(command,args,options)=>{assert.equal(options.env.CGO_ENABLED,'0');assert.ok(args.includes('-fuzztime=10s'));return{status:1,stderr:'fixture failure'};}, outputDirectory),false);
  assert.throws(()=>runMaintenanceChecks('unknown'));
  assert.equal(MAINTENANCE_CHECKS.fuzz.length,3);
});

// Cost narrowing is confined to the extra race lane; full ordinary Go tests remain in verify.
test('the bounded race selection owns repository and API concurrency/cancellation contracts', async () => {
  const fs = await import('node:fs');
  const pattern = MAINTENANCE_CHECKS.race[1][1].find(argument => argument.startsWith('-run=')).slice(5).replace('(?i)', '');
  const matcher = new RegExp(pattern, 'i');
  for (const [directory, contracts] of [
    ['internal/repository', ['TestConcurrentAggregateUsageGrainIsAtomicAndExact','TestQueuedWriterAbandonsItsWaitWhenCancelled','TestTransactionHoldsTheGateUntilItEnds','TestConcurrentWritersAllSucceedAndGateDoesNotDeadlock']],
    ['internal/api', ['TestBrowserRunShutdownJoinsInference','TestBrowserRunBoundsConcurrentSameIDBodyReadsAndReleasesSlots','TestConcurrentProviderTogglesDoNotLoseAWrite','TestPlaygroundStreamDeadlineContextAndCancellation']],
  ]) {
    const source = fs.readdirSync(directory).filter(name => name.endsWith('_test.go')).map(name => fs.readFileSync(`${directory}/${name}`, 'utf8')).join('\n');
    const names = [...source.matchAll(/^func (Test\w+)\(/gm)].map(match => match[1]);
    for (const contract of contracts) { assert.ok(names.includes(contract)); assert.ok(matcher.test(contract), contract); }
  }
});

test('stale or unreadable advisory ownership fails the verdict but retains both scanner logs', context => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-triage-evidence-'));
  context.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  for (const message of ['advisory needs a renewed review', 'invalid triage JSON']) {
    const calls = [];
    const hasPassed = runMaintenanceChecks('advisories', (command, args) => {
      calls.push(command);
      return { status: 0, stdout: `${command} evidence`, stderr: '' };
    }, outputDirectory, { reportTriage: () => { throw new Error(message); } });
    assert.equal(hasPassed, false);
    assert.deepEqual(calls, ['pnpm', 'go']);
    assert.match(fs.readFileSync(path.join(outputDirectory, 'advisories-triage.log'), 'utf8'), new RegExp(message));
    assert.match(fs.readFileSync(path.join(outputDirectory, 'advisories-0.log'), 'utf8'), /pnpm evidence/);
    assert.match(fs.readFileSync(path.join(outputDirectory, 'advisories-1.log'), 'utf8'), /go evidence/);
  }
});

test('valid advisory ownership never suppresses a failed audit', context => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-audit-evidence-'));
  context.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const calls = [];
  assert.equal(runMaintenanceChecks('advisories', command => {
    calls.push(command);
    return { status: command === 'pnpm' ? 1 : 0, stdout: 'scanner evidence' };
  }, outputDirectory, { reportTriage: () => {} }), false);
  assert.deepEqual(calls, ['pnpm', 'go']);
  assert.match(fs.readFileSync(path.join(outputDirectory, 'advisories-triage.log'), 'utf8'), /PASS/);
});
