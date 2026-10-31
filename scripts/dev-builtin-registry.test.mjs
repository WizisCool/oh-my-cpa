import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { devRegistryPort, selectDockerGateway, startBuiltinRegistryBridge } from './dev-builtin-registry.mjs';

const cpa = (port, gateway, host = '127.0.0.1') => ({
  Ports: { '8317/tcp': [{ HostPort: String(port), HostIp: host }] },
  Networks: { local: { Gateway: gateway } },
});

test('selects only the unambiguous local Docker gateway for the configured CPA port', () => {
  const addresses = new Set(['172.20.0.1', '172.21.0.1']);
  assert.equal(selectDockerGateway('http://127.0.0.1:8317', [cpa(8317, '172.20.0.1'), cpa(9000, '172.21.0.1')], addresses), '172.20.0.1');
  assert.equal(selectDockerGateway('http://localhost:8317', [cpa(8317, '172.20.0.1', '0.0.0.0')], addresses), '172.20.0.1');
  assert.equal(selectDockerGateway('http://remote.example:8317', [cpa(8317, '172.20.0.1')], addresses), '');
  assert.equal(selectDockerGateway('http://127.0.0.1:8317', [cpa(8318, '172.20.0.1')], addresses), '');
  assert.equal(selectDockerGateway('http://127.0.0.1:8317', [cpa(8317, '172.20.0.1', '127.0.0.2')], addresses), '');
  assert.equal(selectDockerGateway('http://127.0.0.1:8317', [cpa(8317, '172.30.0.1')], addresses), '');
  assert.equal(selectDockerGateway('http://127.0.0.1:8317', [cpa(8317, '172.20.0.1'), cpa(8317, '172.21.0.1')], addresses), '');
  assert.equal(devRegistryPort('http://127.0.0.1:8085'), 18085);
});

test('development bridge forwards only the public registry and never forwards client credentials', async (t) => {
  const observed = [];
  const api = http.createServer((request, response) => {
    observed.push({ method: request.method, url: request.url, auth: request.headers.authorization, cookie: request.headers.cookie });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"plugins":[]}');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => api.close());
  const bridge = await startBuiltinRegistryBridge({
    host: '127.0.0.1', port: 0, apiTarget: `http://127.0.0.1:${api.address().port}`, basePath: '/omc/',
  });
  t.after(() => bridge.close());
  const origin = `http://127.0.0.1:${bridge.address().port}`;
  const response = await fetch(`${origin}/omc/plugin-registry/v2.json?plugin_id=test&version=1`, {
    headers: { Authorization: 'Bearer not-for-the-upstream', Cookie: 'session=not-for-the-upstream' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { plugins: [] });
  assert.deepEqual(observed, [{ method: 'GET', url: '/omc/plugin-registry/v2.json?plugin_id=test&version=1', auth: undefined, cookie: undefined }]);
  assert.equal((await fetch(`${origin}/omc/api/v1/management/plugins`)).status, 404);
  assert.equal((await fetch(`${origin}/omc/plugin-registry/v2.json`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${origin}/omc/plugin-registry/v2.json/other`)).status, 404);
  assert.equal(observed.length, 1, 'non-registry requests reached the API');

  const rootBridge = await startBuiltinRegistryBridge({
    host: '127.0.0.1', port: 0, apiTarget: `http://127.0.0.1:${api.address().port}`, basePath: '/',
  });
  t.after(() => rootBridge.close());
  assert.equal((await fetch(`http://127.0.0.1:${rootBridge.address().port}/plugin-registry/v2.json`)).status, 200);
  assert.equal(observed[1].url, '/plugin-registry/v2.json');
});

test('dev:api supplies the callback origin to Air and removes its bridge on exit', { timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-dev-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.dirname(fileURLToPath(import.meta.url));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['dev.mjs', 'api-target.mjs', 'dev-builtin-registry.mjs']) {
    fs.copyFileSync(path.join(source, name), path.join(root, 'scripts', name));
  }
  const fakeAir = path.join(root, 'fake-air');
  fs.writeFileSync(fakeAir, '#!/usr/bin/env node\nconsole.log("FAKE_AIR_ORIGIN=" + process.env.OMCPA_BUILTIN_REGISTRY_ORIGIN); require("node:net").createServer().listen(0, "127.0.0.1");\n', { mode: 0o755 });
  const api = http.createServer((request, response) => {
    response.writeHead(request.url === '/omc/plugin-registry/v2.json' ? 200 : 404);
    response.end('fixture');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => api.close());
  const target = `http://127.0.0.1:${api.address().port}`;
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'dev.mjs'), '--api-only'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, AIR_BIN: fakeAir, OMCPA_API_TARGET: target, OMCPA_BASE_PATH: '/omc', OMCPA_CPA_BASE_URL: 'http://127.0.0.1:5' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/FAKE_AIR_ORIGIN=(http:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`dev launcher exited before Air received the origin: ${code}`)));
  });
  assert.equal(origin, `http://127.0.0.1:${devRegistryPort(target)}`);
  assert.equal((await fetch(`${origin}/omc/plugin-registry/v2.json`)).status, 200);
  assert.equal((await fetch(`${origin}/omc/api/auth/login`)).status, 404);
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  const [exitCode] = await closed;
  assert.equal(exitCode, 0);
  await assert.rejects(fetch(`${origin}/omc/plugin-registry/v2.json`));
});
