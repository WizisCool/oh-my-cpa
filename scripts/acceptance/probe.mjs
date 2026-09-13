/**
 * Shared primitives for the focused browser probes.
 *
 * Each probe used to start its own Vite server and its own Chromium, mock the same
 * API surface, seed the same `localStorage` and install the same error capture.
 * Four probes therefore paid for four dev servers and four browsers to assert four
 * unrelated properties.
 *
 * The fix is ownership, not a helper: `runProbes` owns one server and one browser
 * for the whole run and gives each scenario its own *context*, which is where the
 * isolation actually lives. A context has its own `localStorage`, cookies and
 * service workers, so a scenario cannot see another's state, while the two
 * expensive resources are paid for once.
 *
 * A scenario that needs a different fixture gets it from `context.route`, which is
 * per-context and therefore cannot leak into a sibling.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Longer than any probe expects to wait, short enough to fail the run rather than hang CI. */
const DEFAULT_WATCHDOG_MS = 150_000;

export const probeRoot = root;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the dev server to answer.
 *
 * A port is passed in rather than chosen, so a caller can pin one; `strictPort`
 * on the Vite side means a collision fails loudly instead of silently binding
 * elsewhere, which is what makes a pinned port safe.
 */
export async function startVite(port) {
  const base = `http://127.0.0.1:${port}/omc`;
  const server = spawn(
    process.execPath,
    [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: path.join(root, 'web'), stdio: 'pipe', windowsHide: true },
  );
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`probe Vite server exited with ${server.exitCode}`);
    if (await fetch(base).then((response) => response.ok).catch(() => false)) return { server, base };
    await sleep(200);
  }
  server.kill();
  throw new Error('probe Vite server did not become ready');
}

/**
 * The API surface every probe mocks, as a table of (matcher → responder).
 *
 * Probes compose this with their own responses rather than restating the session,
 * preference and health endpoints each time. The order is significant: a later
 * entry wins, so a scenario's own handler can override a default.
 */
export function defaultRoutes() {
  return [
    [(url) => url.pathname.endsWith('/api/auth/session'), () => ({ authenticated: true })],
    [(url, method) => url.pathname.endsWith('/preferences') && method === 'GET', () => ({ preferences: {} })],
    [(url) => url.pathname.includes('/preferences/'), () => ({ ok: true })],
    [(url) => url.pathname.endsWith('/management/auth-files'), () => ({ files: [], total: 0 })],
    [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [], total: 0 })],
    [(url) => url.pathname.endsWith('/health'), () => ({ cpa_connected: true, version: 'probe', status: 'ok' })],
  ];
}

/**
 * Installs the API mock for one context.
 *
 * `extra` entries are checked first, so a scenario expresses only what it changes.
 */
export async function installRoutes(context, extra = []) {
  const table = [...extra, ...defaultRoutes()];
  await context.route('**/omc/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    for (const [matches, respond] of table) {
      if (!matches(url, method)) continue;
      const body = await respond(url, method, request);
      return route.fulfill({ status: 200, json: body });
    }
    return route.fulfill({ status: 200, json: {} });
  });
}

/**
 * Creates one scenario's page in its own context.
 *
 * The theme and language are seeded through `addInitScript` so they apply before
 * the first paint: a probe that measures colours or geometry must not race the
 * stored-theme application.
 */
export async function createProbePage(browser, { viewport = { width: 1440, height: 1000 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('omc-theme', 'light');
    localStorage.setItem('omc-lang', 'en');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

/** Collects results the way `acceptance/harness.mjs` does, for probes that use assertions. */
export function createProbeChecker() {
  const failures = [];
  let count = 0;
  const check = (name, condition, detail = '') => {
    count += 1;
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures.push(name);
    return condition;
  };
  return { check, failures, count: () => count };
}

/**
 * Runs scenarios against one dev server and one browser.
 *
 * A scenario that throws does not stop the others: its failure is recorded and the
 * run continues, because a probe that reports one property and hides the next three
 * is worse than one that reports all four. The process exit code reflects every
 * failure.
 *
 * Each scenario gets a fresh context so its `localStorage`, cookies and routes
 * cannot reach a sibling, and the context is closed even when the scenario throws.
 */
export async function runProbes({ port, scenarios, watchdogMs = DEFAULT_WATCHDOG_MS }) {
  const watchdog = setTimeout(() => {
    console.error('FAIL probe run timed out');
    process.exit(2);
  }, watchdogMs);
  watchdog.unref();

  let server;
  let browser;
  const failures = [];
  let passed = 0;

  try {
    const started = await startVite(port);
    server = started.server;
    const base = started.base;
    browser = await chromium.launch({ headless: true });

    for (const scenario of scenarios) {
      const { context, page, errors } = await createProbePage(browser, scenario.options);
      try {
        await scenario.run({ base, page, context, errors, check: scenario.check, failures });
        passed += 1;
      } catch (error) {
        // The scenario name is reported with the error so a failure in a combined run
        // still says which probe it came from.
        console.error(`FAIL ${scenario.name}: ${error?.stack ?? error?.message ?? error}`);
        failures.push(scenario.name);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    server?.kill('SIGTERM');
    await sleep(300);
  }

  return { passed, failures };
}
