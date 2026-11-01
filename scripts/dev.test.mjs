import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withinBudget } from './acceptance/lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function watchOutput(child) {
  let output = '';
  const events = new Map();
  const waiters = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    output += line + '\n';
    if (!line.startsWith('FIXTURE ')) return;
    const event = JSON.parse(line.slice('FIXTURE '.length));
    events.set(event.type, event);
    waiters.get(event.type)?.(event);
  });
  child.stderr.on('data', chunk => { output += chunk; });
  return {
    output: () => output,
    wait: type => events.has(type) ? Promise.resolve(events.get(type))
      : withinBudget(new Promise(resolve => waiters.set(type, resolve)), 5000, `fixture ${type}`),
    close: () => lines.close(),
  };
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function finishFixture(port) {
  const socket = net.connect(port, '127.0.0.1');
  const closed = once(socket, 'close');
  socket.end('finish');
  await withinBudget(closed, 5000, 'fixture release');
}

for (const scenario of [
  { name: 'repeated SIGINT', signal: 'SIGINT' },
  { name: 'repeated SIGTERM', signal: 'SIGTERM' },
  { name: 'terminal Ctrl+C through pnpm', signal: 'SIGINT', pnpm: true },
]) {
  test(`dev joins Air cleanup after ${scenario.name}`, { timeout: 15000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-dev-shutdown-'));
    const air = path.join(directory, 'air.cjs');
    // A readiness/finish handshake holds Air's cleanup open without relying on
    // timing. No Go binary, developer data directory, Vite port or CPA is used.
    fs.writeFileSync(air, `#!/usr/bin/env node
const net = require('node:net');
const emit = event => console.log('FIXTURE ' + JSON.stringify(event));
const server = net.createServer(socket => {
  socket.resume();
  socket.on('end', () => {
    socket.end();
    server.close();
  });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => emit({type:'stopping', signal}));
server.listen(0, '127.0.0.1', () => emit({type:'ready', pid:process.pid, parent:process.ppid, port:server.address().port}));
`, { mode: 0o700 });
    const child = scenario.pnpm
      ? spawn('pnpm', ['dev:api'], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AIR_BIN: air, OMCPA_ENV_FILE: path.join(directory, 'no-env') },
      })
      : spawn(process.execPath, ['scripts/dev.mjs', '--api-only'], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AIR_BIN: air, OMCPA_ENV_FILE: path.join(directory, 'no-env') },
      });
    const closed = once(child, 'close');
    const observed = watchOutput(child);
    let ready;
    try {
      ready = await observed.wait('ready');
      const stopping = observed.wait('stopping');
      process.kill(scenario.pnpm ? -child.pid : child.pid, scenario.signal);
      await stopping;
      if (!scenario.pnpm) process.kill(child.pid, scenario.signal);
      await finishFixture(ready.port);
      const [code, signal] = await withinBudget(closed, 5000, 'development shutdown');
      assert.equal(signal, null, observed.output());
      assert.equal(code, 0, observed.output());
      assert.equal(isProcessAlive(ready.pid), false, 'Air survived development shutdown');
      if (scenario.pnpm) assert.equal(isProcessAlive(ready.parent), false, 'dev script survived pnpm');
    } finally {
      for (const pid of [ready?.pid, ready?.parent, child.pid]) {
        if (!pid) continue;
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await withinBudget(closed, 5000, 'fixture cleanup');
      observed.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
