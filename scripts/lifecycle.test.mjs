import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { withinBudget, createShutdownController, withOwnedCleanup, stopProcess, closeServer } from './acceptance/lifecycle.mjs';

test('budgets are cleared on success and report the active operation on hangs', async () => {
  assert.equal(await withinBudget(Promise.resolve(42),100,'success'),42);
  await assert.rejects(withinBudget(new Promise(()=>{}),5,'held scenario'),/held scenario exceeded/);
});
test('shutdown is bounded, escalates and is safe after exit', async () => {
  const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
  const signals=[];
  child.kill=signal=>{signals.push(signal);if(signal==='SIGKILL'){child.signalCode=signal;queueMicrotask(()=>child.emit('close',null,signal));}};
  await stopProcess(child,5);await stopProcess(child,5);
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  let closed=false;
  await closeServer({closeAllConnections:()=>{closed=true;},close:callback=>callback()});
  assert.equal(closed,true);
});

test('owned browser shutdown can terminate its child when close hangs', async () => {
  const { launchBrowser, closeBrowser } = await import('./acceptance/lifecycle.mjs');
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit('close', null, signal)); };
  const browser = {};
  let launchOptions;
  const server = { wsEndpoint: () => 'ws://127.0.0.1:9999', close: () => Promise.reject(new Error('wedged close')), process: () => child };
  assert.equal(await launchBrowser({ launchServer: async options => { launchOptions = options; return server; }, connect: async () => browser }), browser);
  assert.equal(launchOptions.host, '127.0.0.1');
  await closeBrowser(browser);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('shutdown closes admission immediately and concurrent callers await the same owned cleanup', async () => {
  let release;
  let cleanups = 0;
  const held = new Promise(resolve => { release = resolve; });
  const controller = createShutdownController(async () => { cleanups += 1; await held; });
  assert.equal(controller.isStopping, false);
  const watchdog = controller.shutdown();
  assert.equal(controller.isStopping, true);
  const normalFinally = controller.shutdown();
  assert.equal(normalFinally, watchdog);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanups, 1);
  release();
  await Promise.all([watchdog, normalFinally]);
  assert.equal(controller.isStopping, true);
  assert.equal(controller.shutdown(), watchdog);
});

test('cleanup rejection is retained rather than rerunning or silently succeeding', async () => {
  let cleanups = 0;
  const controller = createShutdownController(() => { cleanups += 1; throw new Error('owned cleanup failed'); });
  await assert.rejects(controller.shutdown(), /owned cleanup failed/);
  await assert.rejects(controller.shutdown(), /owned cleanup failed/);
  assert.equal(cleanups, 1);
  assert.equal(controller.isStopping, true);
});

test('diagnostic capture failure cannot bypass owned resource cleanup', async () => {
  const calls = [];
  await assert.rejects(withOwnedCleanup(async () => {
    calls.push('capture');
    throw new Error('artifact write failed');
  }, async () => { calls.push('cleanup'); }), /artifact write failed/);
  assert.deepEqual(calls, ['capture', 'cleanup']);
  assert.equal(await withOwnedCleanup(async () => 42, async () => { calls.push('success cleanup'); }), 42);
  assert.equal(calls.at(-1), 'success cleanup');
});
