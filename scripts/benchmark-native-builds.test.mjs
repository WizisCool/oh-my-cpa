import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBuildPool, snapshotNativeInputs } from './benchmark-native-builds.mjs';
test('build experiments retain every target, preserve results and bound concurrent processes', async () => {
  for (const concurrency of [1, 2]) {
    let active = 0, peak = 0;
    const targets = Array.from({ length: 8 }, (_, index) => index);
    const results = await runBuildPool(targets, concurrency, async target => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return target;
    });
    assert.equal(peak, concurrency);
    assert.deepEqual(results, targets);
  }
  await assert.rejects(runBuildPool([1], 8, async value => value));
});


test('a failed build waits for already-owned siblings before returning failure', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let hasSettled = false;
  const running = runBuildPool([0, 1], 2, async target => {
    if (target === 0) throw new Error('failed target');
    await held;
  });
  running.then(() => { hasSettled = true; }, () => { hasSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hasSettled, false);
  release();
  await assert.rejects(running, /Build experiment failed/);
});


test('native experiments embed immutable captured inputs rather than a changing product stage', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-native-inputs-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'root');
  fs.mkdirSync(path.join(root, 'internal/web/dist/assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cmd'));
  fs.mkdirSync(path.join(root, 'migrations'));
  for (const [name, value] of [['go.mod', 'module fixture'], ['go.sum', 'fixture checksum'], ['cmd/main.go', 'package main'], ['migrations/embed.go', 'package migrations'], ['migrations/001.sql', 'CREATE TABLE fixture (id INTEGER);'], ['internal/web/dist/index.html', '<script src="./assets/app-hash.js"></script>'], ['internal/web/dist/assets/app-hash.js', 'captured SPA']]) {
    fs.writeFileSync(path.join(root, name), value);
  }
  const destination = path.join(directory, 'captured');
  const digest = snapshotNativeInputs(root, destination);
  assert.match(digest, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(root, 'migrations/001.sql'), 'changed migration');
  assert.notEqual(snapshotNativeInputs(root, path.join(directory, 'changed')), digest);
  assert.equal(fs.readFileSync(path.join(destination, 'migrations/001.sql'), 'utf8'), 'CREATE TABLE fixture (id INTEGER);');
  fs.rmSync(path.join(root, 'internal/web/dist/assets/app-hash.js'));
  fs.writeFileSync(path.join(root, 'cmd/main.go'), 'changed source');
  assert.equal(fs.readFileSync(path.join(destination, 'internal/web/dist/assets/app-hash.js'), 'utf8'), 'captured SPA');
  assert.equal(fs.readFileSync(path.join(destination, 'cmd/main.go'), 'utf8'), 'package main');
});

test('cancellation stops new target admission and joins active builds before reporting', async () => {
  const controller = new AbortController();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const targets = [];
  let hasSettled = false;
  const running = runBuildPool([0, 1, 2, 3], 2, async target => {
    targets.push(target);
    await held;
    return target;
  }, { signal: controller.signal });
  running.then(() => { hasSettled = true; }, () => { hasSettled = true; });
  controller.abort(new Error('interrupted fixture'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hasSettled, false);
  release();
  await assert.rejects(running, error => error.message === 'interrupted fixture' && JSON.stringify(error.results) === '[0,1]');
  assert.deepEqual(targets, [0, 1]);
});
