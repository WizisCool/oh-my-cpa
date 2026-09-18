/**
 * Shared primitives for the focused browser probes.
 *
 * Each probe used to start its own Vite server and its own Chromium, mock the same
 * API surface, seed the same `localStorage` and install the same error capture.
 * Four probes therefore paid for four dev servers and four browsers to assert four
 * unrelated properties, and three of them sat outside the full gate entirely.
 *
 * The fix is ownership, not a helper: `runProbes` owns one server and one browser
 * for the whole run and gives each scenario its own *context*, which is where the
 * isolation actually lives. A context has its own `localStorage`, cookies and
 * service workers, so a scenario cannot see another's state, while the two
 * expensive resources are paid for once.
 *
 * A scenario's own routes are installed on its own context through `context.route`,
 * which is per-context and therefore cannot leak into a sibling. Routes are matched
 * in reverse order of registration, so a scenario's entries are checked before the
 * shared defaults.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Longer than any probe expects to wait, short enough to fail the run rather than hang CI. */
const DEFAULT_WATCHDOG_MS = 150_000;

export const probeRoot = root;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether something is already listening on the port.
 *
 * A bare TCP connect, not an HTTP request: the point is to detect an occupant of *any* kind
 * before spawning, so the check cannot be satisfied by a server that answers a different route
 * or refuses the ones this suite uses. `127.0.0.1` matches the `--host` the dev server binds.
 */
function portIsOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (occupied) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

/**
 * Waits for the dev server to answer.
 *
 * A port is passed in rather than chosen, so a caller can pin one; `strictPort`
 * on the Vite side means a collision fails loudly instead of silently binding
 * elsewhere, which is what makes a pinned port safe to reason about.
 *
 * That guarantee needs this function's help, because a readiness probe alone cannot
 * provide it. Readiness is decided by fetching the base URL, and a fetch cannot tell
 * whose server answered: if another run already holds the port - a second worktree's
 * probe run, a stray `pnpm dev` - the fetch succeeds against *its* server, this
 * function returns happily, and every scenario is then served a foreign worktree's
 * sources. The failure is silent and looks like a genuine regression in whichever
 * check happens to disagree with the other tree (observed once: another branch's i18n
 * labels appearing in a failure dump while the scenarios here asserted this branch's).
 * The spawned Vite does die of `EADDRINUSE`, but only after readiness already passed,
 * so waiting on its exit code does not close the window either.
 *
 * So the port is checked before spawning, and the ready loop requires this run's own
 * server to still be alive. Both make a collision loud, which is what the pinned port
 * was for.
 */
export async function startVite(port) {
  if (await portIsOccupied(port)) {
    throw new Error(
      `probe dev server port ${port} is already in use.\n`
      + 'Another probe/dev server is running - commonly a verify:full, verify:probes or check:ui in\n'
      + 'a different worktree. Readiness is decided by fetching the base URL, which cannot tell whose\n'
      + 'server answered, so continuing would run these scenarios against that worktree\'s sources.\n'
      + 'Wait for it to finish, then re-run.',
    );
  }

  // `base` carries no trailing slash because scenarios append paths to it, while the
  // readiness probe needs one: the dev entry is `/omc/`, and the bare `/omc` is
  // answered 404 with Vite's base-prefix guard. Probing the bare path would report a
  // dev server that is serving happily as "did not become ready".
  const base = `http://127.0.0.1:${port}/omc`;
  const readyURL = `${base}/`;
  const server = spawn(
    process.execPath,
    [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: path.join(root, 'web'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  // Captured rather than discarded: a dev server that dies on startup (a port taken
  // by something else, a syntax error in the app) reports why, and a bare "did not
  // become ready" would send the next reader looking in the wrong place.
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`probe Vite server exited with ${server.exitCode}:\n${output}`);
    }
    // `server.exitCode` is re-read on every iteration, so a Vite that lost the port
    // race after this run's pre-check is reported as itself rather than as a timeout.
    if (await fetch(readyURL).then((response) => response.ok).catch(() => false)) return { server, base };
    await sleep(200);
  }
  server.kill();
  throw new Error(`probe Vite server did not become ready on ${readyURL}:\n${output}`);
}

/**
 * A well-formed dashboard body.
 *
 * Every route's shell reads the dashboard, so a scenario that does not care about it
 * still needs a valid response: returning `{}` crashes the page on `window.bucket_ms`
 * and takes the scenario's own assertion down with it, which is a failure that says
 * nothing about what the scenario was testing.
 *
 * `series` is overridable because the sparkline probe needs buckets that reach the
 * plot floor; an empty series is the right default for a scenario that never looks
 * at the tiles.
 */
export function dashboardBody(series = [], { bucketMS = 60_000, preset = '1h' } = {}) {
  const total = series.reduce((sum, point) => sum + point.v, 0);
  const tokens = series.reduce((sum, point) => sum + (point.tokens ?? 0), 0);
  const now = Date.now();
  return {
    window: {
      preset,
      from: now - 60 * bucketMS,
      to: now,
      bucket_ms: bucketMS,
      minutes: 60,
      complete: true,
      open_end: false,
    },
    requests: { total, success: total, failed: 0, success_rate: total > 0 ? 100 : null, series },
    tokens: {
      total: tokens,
      input: tokens,
      output: 0,
      reasoning: 0,
      cached: 0,
      cache_read: 0,
      cache_creation: 0,
      series,
    },
    metrics: { rpm: 0, tpm: 0, cache_rate: 0, cost: 0, cost_source: 'none', cost_note: '', avg_latency_ms: 0, avg_ttft_ms: 0 },
    coverage: { rollup_requests: 0, detail_requests: 0, pending_inbox: 0, stored_events: 0 },
    partial_errors: [],
  };
}

/**
 * The API surface every probe mocks, as a table of `[matches, respond]`.
 *
 * Probes compose this with their own responses rather than restating the session,
 * preference and health endpoints each time.
 *
 * The preferences document is stateful rather than always empty, because a probe that
 * asserts a setting survives a write needs the mock to remember it. A store per
 * `installRoutes` call keeps the state inside one scenario's context, which is where
 * the isolation lives: a write in one scenario cannot be read by another.
 */
export function defaultRoutes() {
  const preferences = {};
  return [
    [(url) => url.pathname.endsWith('/api/auth/session'), () => ({ authenticated: true })],
    [
      (url, method) => url.pathname.endsWith('/preferences') && method === 'GET',
      () => ({ preferences: { ...preferences } }),
    ],
    [
      (url, method) => url.pathname.includes('/preferences/') && method !== 'GET',
      (url, _method, request) => {
        // The key is the last path segment; the body is the document to store. The
        // shape mirrors the real endpoint closely enough for a probe that reads it
        // back through the same API.
        const key = url.pathname.split('/').pop();
        try {
          preferences[key] = JSON.parse(request.postData() ?? 'null');
        } catch {
          preferences[key] = null;
        }
        return { ok: true };
      },
    ],
    [(url) => url.pathname.includes('/preferences/'), () => ({ ok: true })],
    [(url) => url.pathname.endsWith('/management/auth-files'), () => ({ files: [], total: 0 })],
    [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [], total: 0 })],
    [(url) => url.pathname.endsWith('/health'), () => ({ cpa_connected: true, version: 'probe', status: 'ok' })],
    // The shell every route mounts reads these, so they are defaults rather than
    // per-scenario fixtures.
    [(url) => url.pathname.endsWith('/dashboard'), () => dashboardBody()],
    [(url) => url.pathname.endsWith('/dashboard/tail'), () => dashboardBody()],
    [
      (url) => url.pathname.endsWith('/management/overview'),
      () => ({
        cpa: { connected: true, version: 'probe', latency_ms: 1 },
        counts: { management_keys: 1, provider_keys: 0, credentials: 0, models: 0 },
        providers: [],
        credentials: { total: 0, active: 0, disabled: 0, unavailable: 0, by_type: [] },
        traffic: {
          bucket_minutes: 10,
          window_minutes: 60,
          buckets: [],
          total_success: 0,
          total_failure: 0,
          total: 0,
          success_rate: null,
        },
        partial_errors: [],
      }),
    ],
  ];
}

/**
 * Installs the API mock for one context.
 *
 * `extra` is checked before the defaults, so a scenario expresses only what it
 * changes. It is registered first and the defaults afterwards because Playwright
 * consults the most recently added route handler first - registering the defaults
 * last is what keeps the shared entries as the fallback rather than as an override.
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
      // A scenario that needs to prove something about a failing request returns a
      // `{ status, json }` envelope; everything else is a successful body. Without an
      // error path a scenario could only assert the happy state, which is how a panel
      // that hangs on a first-load failure goes unnoticed.
      if (body && typeof body === 'object' && typeof body.status === 'number' && 'json' in body) {
        return route.fulfill({ status: body.status, json: body.json });
      }
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
export async function createProbePage(
  browser,
  { viewport = { width: 1440, height: 1000 }, hasTouch = false } = {},
) {
  // `hasTouch` alone, without Playwright's `isMobile`, and that distinction is load-bearing: a
  // scenario asserting the console's touch rules needs `(pointer: coarse)` and `(hover: none)` to
  // match, which `hasTouch` provides, but it must NOT get the mobile viewport emulation - that
  // one makes Chrome zoom out to fit content which overflows, and the zoom grows
  // `window.innerWidth`, which flips the very breakpoint the scenario is measuring and hides the
  // overflow that caused it.
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch });
  await context.addInitScript(() => {
    // Seed only on a fresh context. addInitScript runs on every navigation and
    // reload, so unconditional writes would make a scenario's own theme choice
    // disappear exactly when it reloads to prove persistence.
    if (!localStorage.getItem('omc-theme')) localStorage.setItem('omc-theme', 'omc-light');
    if (!localStorage.getItem('omc-lang')) localStorage.setItem('omc-lang', 'en');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

/** Collects results the way `acceptance/harness.mjs` does, for probes that assert. */
export function createProbeChecker({ quiet = false } = {}) {
  const failures = [];
  let count = 0;
  const check = (name, condition, detail = '') => {
    count += 1;
    // A focused run prints only failures: the fast path exists to answer "is it
    // broken", and forty PASS lines push the answer off the screen. The release gate
    // keeps the full transcript, because there the list of what ran is the evidence.
    if (!quiet || !condition) {
      console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    }
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
 * is worse than one that reports all four. The caller's exit code reflects every
 * failure.
 *
 * Each scenario gets a fresh context and a fresh page error listener, so one
 * scenario's runtime errors cannot be attributed to another.
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
      const options = scenario.options ?? {};
      const { context, page, errors } = await createProbePage(browser, options);
      try {
        await installRoutes(context, options.routes);
        await scenario.run({ base, page, context, errors, check: scenario.check, failures });
        passed += 1;
      } catch (error) {
        // The scenario name travels with the error, so a failure in a combined run
        // still says which probe it came from. The page's own errors and text are
        // reported too: a fixture that does not satisfy a response contract shows up
        // as a runtime error or an error banner, and a bare locator timeout hides
        // which one it was.
        console.error(`FAIL ${scenario.name}: ${error?.stack ?? error?.message ?? error}`);
        if (errors.length > 0) console.error(`  page errors: ${errors.join(' | ')}`);
        await page
          .locator('body')
          .innerText()
          .then((text) => console.error(`  page text: ${JSON.stringify(text.slice(0, 400))}`))
          .catch(() => {});
        // The same evidence the acceptance suite keeps on failure: a screenshot, the
        // DOM and the scenario name, under `tmp/probe-failure/` so CI can upload it.
        const output = path.join(root, 'tmp', 'probe-failure');
        fs.mkdirSync(output, { recursive: true });
        const slug = scenario.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        await page.screenshot({ path: path.join(output, `${slug}.png`), fullPage: true }).catch(() => {});
        await page
          .content()
          .then((html) => fs.writeFileSync(path.join(output, `${slug}.html`), html))
          .catch(() => {});
        fs.writeFileSync(path.join(output, `${slug}.log`), errors.join('\n'));
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
