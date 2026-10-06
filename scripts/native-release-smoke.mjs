import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { until } from './acceptance/harness.mjs';
import { isolatedAppEnvironment } from './acceptance/environment.mjs';
import { createNativePlan, RELEASE_DIRECTORY, verifyReleaseAssets } from './native-release.mjs';

const tag = process.env.RELEASE_TAG;
const plan = createNativePlan(tag,
  JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version,
  JSON.parse(fs.readFileSync(new URL('../web/package.json', import.meta.url))).version);
verifyReleaseAssets(RELEASE_DIRECTORY, plan);
assert.equal(process.platform, 'linux', 'Packaged native smoke runs on the Linux release builder');
const target = plan.find(target => target.goos === 'linux' && target.goarch === (process.arch === 'x64' ? 'amd64' : process.arch));
assert.ok(target, 'Runner architecture must be in the release matrix');
const working = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-native-smoke-'));
try {
  execFileSync('tar', ['-xzf', path.join(RELEASE_DIRECTORY, target.archive), '-C', working]);
  assert.ok(fs.readFileSync(path.join(working, '.env.example'), 'utf8').includes('OMCPA_MASTER_KEY='));
  assert.ok(fs.statSync(path.join(working, 'docs/install.md')).size > 0);
  for (const basePath of ['/omc', '/', '/tools/omc']) {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const secret = randomBytes(24).toString('hex');
    const dataDirectory = path.join(working, `data-${port}`);
    const processHandle = spawn(path.join(working, target.binary), [], {
      cwd: working, stdio: ['ignore', 'ignore', 'pipe'],
      env: isolatedAppEnvironment({
        OMCPA_LISTEN_ADDR: `127.0.0.1:${port}`, OMCPA_BASE_PATH: basePath,
        OMCPA_DATA_DIR: dataDirectory, OMCPA_MASTER_KEY: randomBytes(32).toString('hex'),
        OMCPA_CPA_BASE_URL: 'http://127.0.0.1:1', OMCPA_CPA_MANAGEMENT_KEY: secret,
        OMCPA_USAGE_INGEST_MODE: 'off', OMCPA_UPDATE_CHECK_ENABLED: 'false',
        OMCPA_UPDATE_CHECK_ON_PAGE_LOAD: 'false', TZ: 'Asia/Kuala_Lumpur',
      }),
    });
    let spawnError;
    processHandle.on('error', error => { spawnError = error; });
    processHandle.stderr.resume();
    const exited = new Promise(resolve => processHandle.once('close', resolve));
    const origin = `http://127.0.0.1:${port}`;
    const base = `${origin}${basePath === '/' ? '' : basePath}`;
    try {
      let health;
      await until(async () => {
        if (spawnError) throw spawnError;
        if (processHandle.exitCode !== null) throw new Error(`Native process exited: ${processHandle.exitCode}`);
        try {
          const response = await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { health = await response.json(); return true; }
        } catch { /* Startup is observed through HTTP readiness, not a fixed wait. */ }
        return false;
      }, { label: 'packaged executable HTTP readiness' });
      assert.equal(health.database_status, 'ok');
      assert.equal(health.version, tag);
      assert.equal(health.status, 'degraded');
      assert.equal(health.cpa_connected, false);
      if (basePath !== '/') {
        const canonical = await fetch(base, { redirect: 'manual' });
        assert.equal(canonical.status, 308);
        assert.equal(canonical.headers.get('location'), `${basePath}/`);
      }
      const page = await fetch(`${base}/`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.ok(html.includes(tag), 'Embedded runtime configuration must name the tagged build');
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)];
      assert.ok(scripts.length > 0, 'Archive must serve the real console');
      for (const script of scripts) {
        const response = await fetch(new URL(script[1], `${base}/`));
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /javascript/);
        assert.ok((await response.text()).length > 0);
      }
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: secret }) });
      assert.equal(login.status, 200);
      const response = await fetch(`${base}/api/v1/management/system`, {
        headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
      });
      assert.equal(response.status, 200);
      const system = await response.json();
      assert.equal(system.omc_version.running_version, tag);
      assert.equal(system.omc_version.state, 'indeterminate');
      assert.ok(fs.statSync(path.join(dataDirectory, 'oh-my-cpa.db')).size > 0);
      console.log(`PASS native ${target.goarch}: ${basePath} — SQLite, sign-in, embedded SPA assets and version ${tag}`);
    } finally {
      if (processHandle.exitCode === null) processHandle.kill('SIGTERM');
      const shutdownDeadline = setTimeout(() => processHandle.kill('SIGKILL'), 10_000);
      try { await exited; } finally { clearTimeout(shutdownDeadline); }
    }
  }
} finally {
  fs.rmSync(working, { recursive: true, force: true });
}
