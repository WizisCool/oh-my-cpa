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
 * in reverse order of registration. A single dispatcher checks scenario entries
 * before shared defaults, with explicit method matching for writes.
 */
import { runScenarioQueue } from './probe-scheduler.mjs';
import { appendProbeTiming } from './probe-timings.mjs';
import { createPreferenceFixture } from './preferences-fixture.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { guardBrowserContext, fulfillFixture, createProblemLedger } from './browser-guard.mjs';
import { withinBudget, createShutdownController, stopProcess, launchBrowser, closeBrowser } from './lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Longer than any probe expects to wait, short enough to fail the run rather than hang CI.
 *
 * Measured rather than guessed: with the conversation-workspace scenarios the suite was observed at
 * 290-301s when `verify:full` runs it alongside the browser acceptance, and a 300s ceiling sat inside
 * that spread and failed the gate at random - the same failure an earlier 150s ceiling produced
 * when the suite measured ~150s. The watchdog exists to stop a hang, not to enforce a speed budget,
 * so the margin is wide enough that only a stuck run reaches it. Complete local catalogs reuse
 * the CI partition in sequential batches, each retaining this ceiling as the catalog grows.
 */
const DEFAULT_WATCHDOG_MS = 480_000;

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
  const owner = randomUUID();
  const server = spawn(
    process.execPath,
    [path.join(root, 'scripts/acceptance/vite-server.mjs'), String(port)],
    { env: {...process.env, OMC_PROBE_OWNER:owner}, cwd: path.join(root, 'web'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
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
    if (await fetch(readyURL, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok && response.headers.get('X-OMC-Probe-Owner') === owner).catch(() => false)) return { server, base };
    await sleep(200);
  }
  await stopProcess(server);
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
    coverage: { rollup_requests: 0, detail_requests: 0, pending_inbox: 0, has_usage: false },
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
  const respondPreference = createPreferenceFixture();
  return [
    [(url, method) => method === 'GET' && url.pathname.endsWith('/api/auth/session'), () => ({ authenticated: true })],
    [
      (url, method) => url.pathname.endsWith('/preferences') && method === 'GET',
      (url, method) => respondPreference(url, method),
    ],
    [
      (url, method) => url.pathname.includes('/preferences/') && method === 'PUT',
      (url, method, request) => respondPreference(url, method, request.postData()),
    ],

    [(url, method) => method === 'GET' && url.pathname.endsWith('/custom-icons'), () => ({ icons: [] })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/auth-files'), () => ({ files: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/quota'), () => ({ summary: { total_credentials: 0, healthy_count: 0, warning_count: 0, exhausted_count: 0, cooldown_count: 0, attention_count: 0 }, quotas: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/providers'), () => ({ providers: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/health'), () => ({ cpa_connected: true, version: 'probe', status: 'ok' })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/healthz', () => ({ cpa_connected: true, version: 'probe', status: 'ok' })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/plugins', () => ({ plugins: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/api-keys', () => ({ keys: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/pricing/attention', () => ({ unpriced: [] })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/dashboard/models', () => ({ window: dashboardBody().window, total_tokens: 0, models: [], partial_errors: [] })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/dashboard/providers', () => ({ window: dashboardBody().window, providers: [], partial_errors: [] })],
    // The shell every route mounts reads these, so they are defaults rather than
    // per-scenario fixtures.
    [(url, method) => method === 'GET' && url.pathname.endsWith('/dashboard'), () => dashboardBody()],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/dashboard/tail'), () => dashboardBody()],
    [
      (url, method) => method === 'GET' && url.pathname.endsWith('/management/overview'),
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
 * changes. One dispatcher checks scenario entries first and shared defaults last,
 * so a default cannot override a scenario's method-specific response.
 */
export async function installRoutes(context, extra = [], ledger) {
  const table = [...extra, ...defaultRoutes()];
  await context.route('**/omc/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    for (const [matches, respond] of table) {
      if ((matches.length < 2 && method !== 'GET') || !matches(url, method)) continue;
      const body = await respond(url, method, request);
      // A scenario that needs to prove something about a failing request returns a
      // `{ status, json }` envelope; everything else is a successful body. Without an
      // error path a scenario could only assert the happy state, which is how a panel
      // that hangs on a first-load failure goes unnoticed.
      if (body && typeof body === 'object' && typeof body.status === 'number' && 'json' in body) {
        return fulfillFixture(route, { status: body.status, json: body.json, ...(body.headers ? { headers: body.headers } : {}) });
      }
      if (body?.contentType && typeof body.body === 'string') {
        return route.fulfill({ status: 200, contentType: body.contentType, body: body.body });
      }
      return route.fulfill({ status: 200, json: body });
    }
    ledger?.record({ kind: 'fixture', method, url: request.url(), message: 'Undeclared API fixture' });
    return route.fulfill({ status: 501, json: { error: 'undeclared_probe_fixture', method, path: url.pathname } });
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
  { viewport = { width: 1440, height: 1000 }, hasTouch = false, origins = [] } = {},
) {
  // `hasTouch` alone, without Playwright's `isMobile`, and that distinction is load-bearing: a
  // scenario asserting the console's touch rules needs `(pointer: coarse)` and `(hover: none)` to
  // match, which `hasTouch` provides, but it must NOT get the mobile viewport emulation - that
  // one makes Chrome zoom out to fit content which overflows, and the zoom grows
  // `window.innerWidth`, which flips the very breakpoint the scenario is measuring and hides the
  // overflow that caused it.
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch, serviceWorkers: 'block' });
  try {
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(20_000);
  const ledger = await guardBrowserContext(context, origins);
  await context.addInitScript(() => {
    // Seed only on a fresh context. addInitScript runs on every navigation and
    // reload, so unconditional writes would make a scenario's own theme choice
    // disappear exactly when it reloads to prove persistence.
    if (!/^https?:$/.test(location.protocol)) return;
    if (!localStorage.getItem('omc-theme')) localStorage.setItem('omc-theme', 'omc-light');
    if (!localStorage.getItem('omc-lang')) localStorage.setItem('omc-lang', 'en');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // What the page said and where it went, kept for the failure log only. A step that silently
  // does nothing leaves no page error, and a screenshot cannot tell a refused action from a
  // reload that discarded it; the console's warnings and the main frame's navigations can.
  const trail = [];
  const startedAt = performance.now();
  const note = (line) => trail.push(`+${Math.round(performance.now() - startedAt)}ms ${line}`);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') note(`console.${message.type()}: ${message.text()}`);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) note(`navigated: ${frame.url()}`);
  });
  return { context, page, errors, trail, ledger };
  } catch (error) {
    try { await withinBudget(context.close(), 2000, 'page setup cleanup'); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Probe page setup and cleanup failed'); }
    throw error;
  }
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
 * The same evidence the acceptance suite keeps on failure: a screenshot, the DOM, the
 * URL and the page's errors, under `tmp/probe-failure/` so CI can upload it.
 */
async function writeProbeDiagnostics(page, errors, trail, scenarioName, failureDirectory) {
  fs.mkdirSync(failureDirectory, { recursive: true });
  const slug = scenarioName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await page.screenshot({ path: path.join(failureDirectory, `${slug}.png`), fullPage: true, timeout: 2000 }).catch(() => {});
  await page
    .content()
    .then((html) => fs.writeFileSync(path.join(failureDirectory, `${slug}.html`), html))
    .catch(() => {});
  fs.writeFileSync(
    path.join(failureDirectory, `${slug}.log`),
    [`url: ${page.url()}`, '', 'page errors:', ...errors, '', 'console and navigation:', ...trail].join('\n'),
  );
}

/**
 * Runs scenarios against one dev server and one browser.
 *
 * A scenario that throws does not stop the others: its failure is recorded and the
 * run continues, because a probe that reports one property and hides the next three
 * is worse than one that reports all four. The caller's exit code reflects every
 * failure.
 *
 * Scheduling may overlap two contexts; verdicts are collated in catalog order
 * and teardown joins every admitted worker before shared resources close.
 * Each scenario gets a fresh context and a fresh page error listener, so one
 * scenario's runtime errors cannot be attributed to another.
 */
export async function runProbes({ port, scenarios, watchdogMs = DEFAULT_WATCHDOG_MS, shouldResetDiagnostics = true, artifactLabel = 'probe', concurrency = 1 }) {
  if (concurrency !== 1 && concurrency !== 2) throw new Error('Probe concurrency must be one or two');
  if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) throw new Error('Probe runs require unique scenario IDs');
  if (!/^[a-z][a-z-]*$/.test(artifactLabel)) throw new Error('Invalid probe artifact namespace');
  const failureDirectory = path.join(root, 'tmp', `${artifactLabel}-failure`, String(port));
  const timingDirectory = path.join(root, 'tmp', `${artifactLabel}-timings`);
  const timingFile = path.join(timingDirectory, `${port}.json`);
  let watchdog;

  let server;
  let browser;
  const outcomes = new Map();

  /**
   * Releases what the run holds, in the order that matters. Idempotent, because both the
   * watchdog and the normal exit path call it.
   *
   * The server goes first: it holds the probe port, and a port left listening is what made
   * every later run fail at startup with a conflict instead of reporting the timeout that
   * caused it. The browser close is bounded, because this runs on the watchdog path too -
   * a wedged browser must not stop the watchdog from exiting.
   */
  const shutdownController = createShutdownController(async () => {
    const runningServer = server;
    const runningBrowser = browser;
    server = undefined;
    browser = undefined;
    try { await stopProcess(runningServer); }
    finally { await closeBrowser(runningBrowser); }
  });
  const shutdown = () => shutdownController.shutdown();

  const activeScenarios = new Map();
  const onSignal = async () => { try { await shutdown(); } finally { process.exit(2); } };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  watchdog = setTimeout(async () => {
    console.error(`FAIL probe run timed out during ${[...activeScenarios.values()].join(', ') || 'startup'}`);
    // `process.exit` skips the `finally` below, so the timed-out run used to leave its Vite
    // server listening on the probe port. Every later run then failed at startup with a port
    // conflict -- a confusing symptom that outlived the timeout it came from.
    try { await shutdown(); }
    finally { process.exit(2); }
  }, watchdogMs);
  watchdog.unref();

  try {
    // Reset before the first batch starts so startup failures cannot expose stale evidence.
    // Later batches retain artifacts from this same invocation rather than erasing its failures.
    if (shouldResetDiagnostics) {
      fs.rmSync(failureDirectory, { recursive: true, force: true });
      fs.rmSync(timingFile, { force: true });
    }
    fs.mkdirSync(timingDirectory, { recursive: true });

    const started = await startVite(port);
    server = started.server;
    const base = started.base;
    browser = await launchBrowser(chromium, { headless: true });

    await runScenarioQueue(scenarios, async scenario => {
      const failures = [];
      activeScenarios.set(scenario.id, scenario.id);
      const startedAt = performance.now();
      const options = scenario.options ?? {};
      let context, page;
      let errors = [], trail = [], ledger = createProblemLedger();
      const steps = [];
      const step = async (name, task) => {
        activeScenarios.set(scenario.id, `${scenario.id}/${name}`);
        const started = performance.now();
        try { return await task(); }
        finally { steps.push({name, durationMs: Math.round(performance.now() - started)}); }
      };
      // Counted per scenario so a failed check keeps the same evidence a thrown error
      // does; most probe failures are checks, and they used to leave nothing behind.
      let failedChecks = 0;
      const check = (name, condition, detail) => {
        if (!condition) failedChecks += 1;
        return scenario.check(name, condition, detail);
      };
      try {
        ({ context, page, errors, trail, ledger } = await createProbePage(browser, {...options, origins: [base]}));
        await installRoutes(context, options.routes, ledger);
        await withinBudget(scenario.run({ base, page, context, errors, check, failures, step, expectProblem: rule => ledger.expect(rule) }), 120_000, `scenario ${scenario.id}`);
        const unexpected = ledger.unexpected();
        check('no unexpected browser or fixture faults', unexpected.length === 0, JSON.stringify(unexpected));
        if (failedChecks > 0) { failures.push(scenario.name); await writeProbeDiagnostics(page, errors, trail, scenario.name, failureDirectory); }

      } catch (error) {
        // The scenario name travels with the error, so a failure in a combined run
        // still says which probe it came from. The page's own errors and text are
        // reported too: a fixture that does not satisfy a response contract shows up
        // as a runtime error or an error banner, and a bare locator timeout hides
        // which one it was.
        console.error(`FAIL ${scenario.name}: ${error?.stack ?? error?.message ?? error}`);
        console.error(`  browser/fixture faults: ${JSON.stringify(ledger.unexpected())}`);
        if (errors.length > 0) console.error(`  page errors: ${errors.join(' | ')}`);
        // The tail of the trail goes in the job log itself: the artifact holds all of it, but the
        // log is what a reader of a red run sees first.
        if (trail.length > 0) console.error(`  console and navigation (last ${Math.min(trail.length, 10)}):\n    ${trail.slice(-10).join('\n    ')}`);
        await page?.
          locator('body')
          .innerText()
          .then((text) => console.error(`  page text: ${JSON.stringify(text.slice(0, 400))}`))
          .catch(() => {});
        if (page) await writeProbeDiagnostics(page, errors, trail, scenario.name, failureDirectory);
        failures.push(scenario.name);
      } finally {
        try {
          if (context) await withinBudget(context.close(), 2000, 'scenario context shutdown');
        } catch (error) {
          console.error(`FAIL ${scenario.name} teardown: ${error.message}`);
          if (!failures.includes(scenario.name)) failures.push(scenario.name);
        }
        // Closing drains pending events before the final verdict; late errors must not
        // become another scenario's problem or disappear after its assertions passed.
        const unexpected = ledger.unexpected();
        if (unexpected.length > 0 && !failures.includes(scenario.name)) {
          check('no late browser or fixture faults', false, JSON.stringify(unexpected));
          failures.push(scenario.name);
          fs.mkdirSync(failureDirectory, { recursive: true });
          fs.writeFileSync(path.join(failureDirectory, `${scenario.id}.log`), JSON.stringify(unexpected, null, 2));
        }
        try {
          const timingError = appendProbeTiming(timingFile, { id: scenario.id, durationMs: Math.round(performance.now() - startedAt), status: failedChecks > 0 || failures.includes(scenario.name) ? 'failed' : 'passed', steps });
          if (timingError) throw timingError;
        } catch (error) {
          console.error(`FAIL ${scenario.name} timing evidence: ${error.message}`);
          failures.push(`${scenario.name} timing evidence`);
        }
        console.log(`[probe] ${scenario.id ?? scenario.name}: ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
        outcomes.set(scenario.id, { passed: failedChecks === 0 && failures.length === 0, failures });
        activeScenarios.delete(scenario.id);
      }
    }, { concurrency, shouldStop: () => shutdownController.isStopping });
  } finally {
    clearTimeout(watchdog);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    await shutdown();
  }

  const records = scenarios.map(scenario => outcomes.get(scenario.id)).filter(Boolean);
  return { passed: records.filter(record => record.passed).length, failures: records.flatMap(record => record.failures) };
}
