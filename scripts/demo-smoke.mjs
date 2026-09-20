// Browser smoke test for the public demonstration.
//
// What this covers that nothing else does: the demo is a second deployment mode of
// the same console, and a change that breaks it - a page that reads a CPA endpoint
// the fixture does not answer, a write the route policy refuses by accident, a
// control that assumes a signed-in operator - produces a working self-hosted
// deployment and a broken demo. `verify:browser` cannot see it, because it drives
// the self-hosted path against a fake gateway.
//
// It boots the real binary in demo mode, over a temporary data directory, and drives
// a real Chromium across every console page. No gateway, no credential and no
// provider service is configured anywhere in this run: that is the property under
// test as much as the rendering is.
//
// Usage:
//   node scripts/demo-smoke.mjs
//   OMCPA_DEMO_URL=https://... node scripts/demo-smoke.mjs   # check a deployment
// Env overrides:
//   OMCPA_DEMO_URL (check a deployment instead of starting one), OMCPA_BROWSER

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createChecker, until } from './acceptance/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, checkEventually, failures, checks } = createChecker();

/**
 * The console's pages, with the one thing each has to show to prove it is not an
 * empty shell. A page that renders its frame and no data is the failure this suite
 * exists for, so every entry asserts on content rather than on a status code.
 */
const PAGES = [
  { route: 'dashboard', label: 'dashboard', selector: '.dashboard-tile', min: 4 },
  { route: 'quick-start', label: 'quick start', selector: '.ant-card', min: 3 },
  { route: 'ai-providers', label: 'providers', selector: '.ant-table-row', min: 2 },
  { route: 'api-keys', label: 'gateway keys', selector: '.ant-table-row', min: 2 },
  { route: 'auth-files', label: 'credentials', selector: '.ant-card', min: 4 },
  { route: 'oauth', label: 'oauth providers', selector: '[data-oauth-card]', min: 4 },
  // The quota cards are `<article class="terminal-panel ...">`, not Ant Design cards, so
  // the selector is the panel class the console lays every one of them out with.
  { route: 'quota', label: 'quota', selector: 'article.terminal-panel', min: 6 },
  { route: 'logs', label: 'logs', selector: '.ant-typography, .log-line, .ant-tabs', min: 1 },
  { route: 'usage/events', label: 'request records', selector: '.ant-table-row, .request-row, [data-request-row]', min: 1 },
  { route: 'pricing', label: 'pricing', selector: '.ant-table-row', min: 5 },
  { route: 'config', label: 'configuration', selector: '.ant-input, .ant-select, .config-field', min: 3 },
  { route: 'omc-settings', label: 'oh my cpa settings', selector: '.ant-segmented, .ant-radio-group, .ant-card', min: 2 },
  { route: 'plugins', label: 'plugins', selector: '.ant-table-row', min: 2 },
  { route: 'plugin-store', label: 'plugin store', selector: '.ant-table-row', min: 2 },
  { route: 'system', label: 'system', selector: '.ant-card', min: 3 },
];

/**
 * Calls the server refuses in demo mode, reached with fetch rather than through the
 * page. The console hides or disables the controls for these, and this is what proves
 * the refusal is the server's answer instead of the browser's kindness.
 */
const REFUSED = [
  { method: 'POST', path: '/api/v1/management/oauth/start', body: { provider: 'codex' } },
  { method: 'POST', path: '/api/v1/management/oauth/callback', body: { provider: 'codex', code: 'x' } },
  { method: 'GET', path: '/api/v1/management/auth-files/download?name=codex-team-primary.json' },
  { method: 'POST', path: '/api/v1/management/auth-files?name=uploaded.json', body: { type: 'codex' } },
  { method: 'DELETE', path: '/api/v1/management/auth-files', body: { names: ['codex-team-primary.json'] } },
  // The route is refused whatever the name is, so the name here is deliberately not one the
  // fixture lists: that is the stronger claim.
  { method: 'GET', path: '/api/v1/management/request-error-logs/request-error-2026-01-01T00-00-00Z.log' },
  { method: 'GET', path: '/api/v1/usage/events/1/request-log' },
  { method: 'POST', path: '/api/v1/management/plugin-store/otel-bridge/install', body: {} },
  { method: 'PATCH', path: '/api/v1/management/plugins/usage-exporter/status', body: { enabled: false } },
  { method: 'PUT', path: '/api/v1/management/config/source', body: { source: 'debug: true' } },
  { method: 'PUT', path: '/api/v1/management/config/debug', body: { value: true } },
  { method: 'POST', path: '/api/v1/management/providers/pull-models', body: {} },
  { method: 'POST', path: '/api/v1/pricing/sync', body: {} },
  { method: 'POST', path: '/api/v1/management/quota/redeem-credit', body: { auth_index: 'auth-codex-01' } },
  { method: 'GET', path: '/api/v1/management/system/diagnostics' },
];

/**
 * Writes that the demonstration performs instead of refusing. They reach the
 * fixture or Oh My CPA's own metadata, and each one has to answer with success and
 * with the header that says the result is not durable.
 */
const SIMULATED = [
  { method: 'PATCH', path: '/api/v1/management/auth-files/status', body: { name: 'codex-standby.json', disabled: false } },
  { method: 'POST', path: '/api/v1/management/quota/refresh', body: { auth_index: 'auth-codex-01' } },
  { method: 'POST', path: '/api/v1/usage/ingest/refresh' },
];

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status > 0) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? 'no response'}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    timeout.unref();
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** Starts the binary under test, or reports that an existing deployment is used. */
async function startLocalDemo() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-demo-smoke-'));
  const binary = path.join(temporary, process.platform === 'win32' ? 'oh-my-cpa.exe' : 'oh-my-cpa');
  console.log('building the binary under test...');
  execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/oh-my-cpa'], {
    cwd: root,
    env: { ...process.env, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
  const port = await freePort();
  const output = [];
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      OMCPA_DEMO_MODE: 'true',
      OMCPA_BASE_PATH: '/',
      // The fixture rebuilds this directory on every boot; see internal/demo.
      OMCPA_DATA_DIR: path.join(temporary, 'data'),
      OMCPA_LISTEN_ADDR: `127.0.0.1:${port}`,
      OMCPA_MASTER_KEY: 'demo-smoke-master-key-000000000000',
      OMCPA_VERSION: 'v0.1.0-demo-smoke',
      // Proof that the demonstration does not read a deployment it inherits: the
      // process is handed a real-looking gateway and must ignore it.
      OMCPA_CPA_BASE_URL: 'http://127.0.0.1:1',
      OMCPA_CPA_MANAGEMENT_KEY: 'inherited-key-that-must-not-be-used',
      // And that it needs no outbound network: a resolver that answers nothing.
      HTTPS_PROXY: 'http://127.0.0.1:1',
      HTTP_PROXY: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => output.push(String(chunk)));
  }
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/api/healthz`);
  } catch (error) {
    child.kill('SIGKILL');
    console.error(output.join(''));
    throw error;
  }
  return {
    base,
    log: () => output.join(''),
    stop: async () => {
      await waitForExit(child);
      // Windows keeps the executable and SQLite files mapped briefly after the
      // process closes. Retry the cleanup instead of failing an otherwise green
      // smoke run on that transient lock.
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function main() {
  const configured = process.env.OMCPA_DEMO_URL?.trim();

  let demo;
  if (configured) {
    demo = { base: configured.replace(/\/$/, ''), log: () => '', stop: () => {} };
    console.log(`checking the deployment at ${demo.base}`);
  } else {
    demo = await startLocalDemo();
    console.log(`checking a local demo on ${demo.base}`);
  }

  // No executable path: the browser the acceptance suite already installed is the
  // one Playwright resolves by itself, and naming it here would be a second place to
  // update when that changes.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // A page that fails a request or throws has a defect the eye can miss: the console
  // renders an empty panel and says nothing.
  const failedRequests = [];
  const consoleErrors = [];
  page.on('response', (response) => {
    if (!response.url().startsWith(demo.base)) return;
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.request().method()} ${response.url().replace(demo.base, '')}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 200)}`));

  try {
    await page.goto(`${demo.base}/dashboard`, { waitUntil: 'domcontentloaded' });

    // The marker and the sign-out control are the two visible consequences of demo
    // mode in the shell, and their absence is what a visitor would notice first.
    await checkEventually('the shell marks the deployment as a demonstration', async () => (await page.locator('.demo-chip').count()) === 1);
    check('the shell does not offer a sign-out that cannot mean anything', (await page.locator('.header-logout').count()) === 0);
    // Nothing was signed in: the console reached its pages by itself.
    check(
      'the console is reachable without a credential',
      !page.url().includes('login'),
      page.url().replace(demo.base, ''),
    );

    for (const definition of PAGES) {
      failedRequests.length = 0;
      consoleErrors.length = 0;
      await page.goto(`${demo.base}/${definition.route}`, { waitUntil: 'domcontentloaded' });
      const ok = await until(async () => (await page.locator(definition.selector).count()) >= definition.min, {
        label: `${definition.label} to render at least ${definition.min} ${definition.selector}`,
        timeoutMs: 20_000,
      }).then(() => true, (error) => error.message);
      check(
        `${definition.label} page renders its own data`,
        ok === true,
        ok === true ? `${definition.selector} × ≥${definition.min}` : ok,
      );
      // Nothing the page needs may be missing: an empty panel is what a fixture gap
      // looks like from the outside.
      check(`${definition.label} page loads every request it makes`, failedRequests.length === 0, failedRequests.join(' | '));
      check(`${definition.label} page reports no script error`, consoleErrors.length === 0, consoleErrors.join(' | '));
    }

    // The boundary, reached without the page's help.
    await page.goto(`${demo.base}/dashboard`, { waitUntil: 'domcontentloaded' });
    const refused = await page.evaluate(async (calls) => {
      const results = [];
      for (const call of calls) {
        const response = await fetch(call.path, {
          method: call.method,
          credentials: 'same-origin',
          headers: call.body ? { 'Content-Type': 'application/json', Origin: location.origin } : { Origin: location.origin },
          body: call.body ? JSON.stringify(call.body) : undefined,
        });
        results.push({ path: call.path, status: response.status, marker: response.headers.get('x-omcpa-demo-blocked'), body: (await response.text()).slice(0, 160) });
      }
      return results;
    }, REFUSED);
    for (const result of refused) {
      // Decoded rather than matched as text: the code is the part a client may branch on,
      // and the message is prose that may be reworded.
      let body = {};
      try {
        body = JSON.parse(result.body);
      } catch {
        body = {};
      }
      check(
        `the server refuses ${result.path}`,
        result.status === 403 && result.marker === 'demo mode' && body.code === 'demo_operation_refused',
        `status=${result.status} marker=${result.marker} code=${body.code}`,
      );
    }

    const simulated = await page.evaluate(async (calls) => {
      const results = [];
      for (const call of calls) {
        const response = await fetch(call.path, {
          method: call.method,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Origin: location.origin },
          body: call.body ? JSON.stringify(call.body) : undefined,
        });
        results.push({ path: call.path, status: response.status, persistence: response.headers.get('x-omcpa-demo-persistence') });
      }
      return results;
    }, SIMULATED);
    for (const result of simulated) {
      check(
        `a safe write still works: ${result.path}`,
        result.status === 200 && result.persistence === 'none',
        `status=${result.status} persistence=${result.persistence}`,
      );
    }

    // A write the demonstration allows, performed the way an operator performs it: the
    // console has to say the result is not durable, or an edited credential would look
    // saved. This is the only check here that goes through the notice path rather than
    // calling the API directly.
    await page.goto(`${demo.base}/auth-files`, { waitUntil: 'domcontentloaded' });
    const toggle = page.locator('.ant-switch').first();
    await toggle.waitFor({ state: 'visible', timeout: 20_000 });
    await toggle.click();
    const notice = await until(async () => {
      const text = await page.locator('.ant-message').innerText().catch(() => '');
      // Matched on either language's own word for the claim, because the console's
      // language follows the browser rather than this run.
      return /persisted|被保存/.test(text) ? text.trim() : false;
    }, { label: 'the console to report that the change is not persisted', timeoutMs: 20_000 }).then(
      (text) => text,
      () => '',
    );
    check('a permitted edit reports that it is not persisted', notice !== '', notice.replace(/\s+/g, ' ').slice(0, 120));

    // Revealing a credential is one of the operations a demo must not perform, and both
    // pages whose contract includes editing keys ask for it with `include_keys=true`.
    // Asserted on the real endpoint rather than on a unit: this is the response a
    // visitor gets.
    const revealed = await page.evaluate(async () => {
      const [keys, providers] = await Promise.all([
        fetch('/api/v1/management/api-keys?include_keys=true', { credentials: 'same-origin' }).then((r) => r.json()),
        fetch('/api/v1/management/providers?include_keys=true', { credentials: 'same-origin' }).then((r) => r.json()),
      ]);
      return { keys, providers };
    });
    const revealedBody = JSON.stringify(revealed);
    check(
      'asking for key material in the demo returns masks',
      !revealedBody.includes('omc-demo-key-'),
      revealedBody.slice(0, 200),
    );
    check(
      'the key list still answers, so the page renders',
      Array.isArray(revealed.keys?.keys) && revealed.keys.keys.length > 0 && revealed.keys.keys.every((item) => typeof item.key === 'string'),
      `keys=${revealed.keys?.keys?.length}`,
    );

    // The demonstration holds no CPA credential, and the run proves it: the process
    // was started with one, and the instance it serves is its own fixture.
    const system = await page.evaluate(async () => {
      const response = await fetch('/api/v1/management/system', { credentials: 'same-origin' });
      return await response.json();
    });
    check(
      'no real gateway is behind the console',
      JSON.stringify(system).includes('127.0.0.1'),
      JSON.stringify(system).slice(0, 200),
    );

    // The cost column is the number a fixture most easily gets wrong, because a
    // request is priced against the version in force at its own request time.
    const dashboard = await page.evaluate(async () => {
      const response = await fetch('/api/v1/management/dashboard?range=30d', { credentials: 'same-origin' });
      return await response.json();
    });
    check(
      'the thirty-day window has traffic, tokens and spend',
      dashboard.requests?.total > 0 && dashboard.tokens?.total > 0 && dashboard.metrics?.cost > 0,
      `requests=${dashboard.requests?.total} tokens=${dashboard.tokens?.total} cost=${dashboard.metrics?.cost}`,
    );
    check(
      'the spend is reported as complete rather than as a placeholder',
      dashboard.metrics?.cost_source === 'estimated',
      `cost_source=${dashboard.metrics?.cost_source}`,
    );
  } finally {
    await browser.close();
    await demo.stop();
  }

  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    if (process.env.OMCPA_DEMO_URL) console.error('\n(no server log: the deployment under test is remote)');
    else console.error(`\nserver log:\n${demo.log()}`);
    process.exit(1);
  }
}

await main();
