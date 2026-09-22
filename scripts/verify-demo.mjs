#!/usr/bin/env node
/**
 * Browser acceptance for the public demonstration.
 *
 * It drives every console route against a running demonstration and fails when a page
 * does not render, when the API answers with an error, or when the console logs one.
 * That combination is what catches the failures a unit test cannot: the session path
 * being wrong put every page on the sign-in card, and a rebase that misread a model
 * name as a date broke the pricing catalogue. Both passed their unit tests and both
 * were visible in one browser run.
 *
 * Point it at a deployed demonstration to check that instead:
 *
 *   OMCPA_DEMO_URL=https://<host> pnpm verify:demo
 *
 * Without that variable it expects a local server, which `pnpm dev:demo` starts.
 *
 * The run is a claim about what a visitor sees, so it checks rendered content and not
 * just status codes: an empty root is a 200 as far as the network is concerned.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A configured address is used as given; otherwise the check serves the
 * demonstration itself.
 *
 * Serving it here rather than through `wrangler dev` is deliberate. Wrangler starts a
 * workerd process to do it, and that turned this check into a step that never finished
 * in CI: the two workerd children outlived the script, held the step open, and a job
 * with a twenty-minute budget was cancelled with the check still running. What is under
 * test is this repository's Worker, not Cloudflare's runtime, and importing the Worker's
 * own `fetch` exercises exactly that - with no orphan process, no bundler and no
 * cross-process startup to wait for.
 *
 * The shape being emulated is the deployed one: a static asset wins, anything under
 * `/api` reaches the Worker, and an unknown path falls back to `index.html` so the
 * console's own router can answer it.
 */
const CONFIGURED_URL = process.env.OMCPA_DEMO_URL;
const LOCAL_PORT = Number(process.env.OMCPA_DEMO_PORT ?? 8787);
const BASE = (CONFIGURED_URL ?? `http://127.0.0.1:${LOCAL_PORT}`).replace(/\/$/, '');

const ASSETS = join(root, 'tmp', 'cloudflare-demo', 'assets');

/** The content types the staged console actually contains. */
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json; charset=utf-8'],
]);

/** Resolves a request path inside the staged assets, refusing anything that escapes it. */
function assetPathFor(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(ASSETS, `.${decoded}`);
  // A traversal attempt would otherwise read outside the staged console.
  if (!candidate.startsWith(ASSETS)) return undefined;
  return candidate;
}

/**
 * Stages the console the local server serves.
 *
 * The Worker reads `tmp/cloudflare-demo/assets`, which `pnpm build:demo` writes. Staging
 * it here rather than requiring it to have been staged keeps this check runnable on its
 * own, which is what its callers assume: an earlier version read a directory that only
 * existed because someone had run the build by hand, so it passed locally and would have
 * failed the first time it ran unattended.
 */
async function stageConsole() {
  await new Promise((resolveBuild, reject) => {
    const build = spawn('pnpm', ['build:demo'], { cwd: root, stdio: 'inherit' });
    build.on('exit', (code) =>
      code === 0 ? resolveBuild() : reject(new Error(`pnpm build:demo exited with ${code}`)),
    );
  });
}

/**
 * Stages the console and serves it, returning a function that stops the server.
 *
 * The Worker is imported rather than reimplemented: `worker.fetch` is the code the
 * deployment runs, so a routing or re-basing mistake fails here rather than on the
 * public page.
 */
async function startLocalDemo() {
  await stageConsole();
  const { default: worker } = await import('../deploy/cloudflare/worker.mjs');

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, BASE);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

    if (isApi) {
      const workerResponse = await worker.fetch(new Request(url, { method: request.method }), {
        // The staging directory is the asset binding, so a defensive branch in the
        // Worker is exercised here rather than skipped.
        ASSETS: {
          fetch: async () => {
            const file = assetPathFor(url.pathname);
            const body = file ? await readFile(file).catch(() => undefined) : undefined;
            return body
              ? new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
              : new Response('not found', { status: 404 });
          },
        },
      });
      response.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers));
      response.end(await workerResponse.text());
      return;
    }

    // A static asset wins; otherwise the console's router answers the path, which is
    // what the deployed `not_found_handling: single-page-application` provides.
    const file = assetPathFor(url.pathname);
    const body = file ? await readFile(file).catch(() => undefined) : undefined;
    if (body) {
      const type = CONTENT_TYPES.get(extname(file)) ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type });
      response.end(body);
      return;
    }
    const index = await readFile(join(ASSETS, 'index.html'));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(index);
  });

  await new Promise((resolveReady) => server.listen(LOCAL_PORT, '127.0.0.1', resolveReady));
  return () => server.close();
}

/**
 * The console's routes, as the application registers them.
 *
 * This list is duplicated from `web/src/App.tsx` on purpose. Importing it would mean
 * the check can never fail for the reason it exists - a route the demonstration cannot
 * render - because adding a route would add it to the check in the same edit.
 */
const ROUTES = [
  '/dashboard',
  '/quick-start',
  '/ai-providers',
  '/api-keys',
  '/auth-files',
  '/oauth',
  '/quota',
  '/logs',
  '/usage/events',
  '/pricing',
  '/config',
  '/omc-settings',
  '/plugins',
  '/plugin-store',
  '/system',
];

/**
 * What must be on the page for it to count as rendered.
 *
 * A route's own heading, so an error boundary or a fallback to the sign-in view is
 * reported as the wrong page rather than as a pass. The strings are the console's own
 * Chinese labels because the demonstration serves the console as built.
 */
const EXPECTED = {
  '/dashboard': '仪表盘',
  '/quick-start': '快速开始',
  '/ai-providers': 'AI 提供商',
  '/api-keys': '密钥管理',
  '/auth-files': 'OAuth 管理',
  '/logs': '日志',
  '/usage/events': '请求记录',
  '/pricing': '费用与用量',
  '/system': '系统信息',
};

/** A generous ceiling: a cold start on a deployed demonstration is the slow case. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** How long a page is given to finish its first data fetch before it is read. */
const SETTLE_MS = 2_500;

async function main() {
  // A local server is only started when no deployment was named, and it needs the
  // console staged before it can serve one.
  const stopServer = CONFIGURED_URL ? undefined : await startLocalDemo();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(BASE).origin && response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    }
  });

  const failures = [];

  for (const route of ROUTES) {
    try {
      // `networkidle` is the wrong signal here and was the first version's bug: the
      // console polls - the dashboard's tail, the log tail, the ingest status - so the
      // network never goes idle and every route timed out against a page that had
      // already rendered. The wait is for the application to mount and settle instead.
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForFunction(
        () => (document.getElementById('root')?.children.length ?? 0) > 0,
        undefined,
        { timeout: NAVIGATION_TIMEOUT_MS },
      );
    } catch (error) {
      failures.push(`${route}: could not be opened (${error.message})`);
      continue;
    }
    await page.waitForTimeout(SETTLE_MS);

    const state = await page.evaluate(() => ({
      mounted: (document.getElementById('root')?.children.length ?? 0) > 0,
      text: document.body.innerText ?? '',
    }));

    if (!state.mounted) {
      failures.push(`${route}: the application did not mount`);
      continue;
    }
    // The sign-in card means the console never learned it was signed in, which is what
    // the wrong session path produced.
    if (state.text.includes('Management Key') || state.text.includes('使用 CPA')) {
      failures.push(`${route}: rendered the sign-in card instead of the console`);
      continue;
    }
    const expected = EXPECTED[route];
    if (expected && !state.text.includes(expected)) {
      failures.push(`${route}: rendered without its own heading (${expected})`);
    }
  }

  await browser.close();
  await stopServer?.();

  for (const failure of failures) console.error(`  FAIL ${failure}`);
  if (failedRequests.length > 0) {
    console.error(`  FAIL the API answered with errors:`);
    for (const request of [...new Set(failedRequests)].slice(0, 10)) console.error(`       ${request}`);
  }
  if (consoleErrors.length > 0) {
    console.error(`  FAIL the console logged errors:`);
    for (const error of [...new Set(consoleErrors)].slice(0, 10)) console.error(`       ${error}`);
  }

  if (failures.length > 0 || failedRequests.length > 0 || consoleErrors.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`the demonstration renders all ${ROUTES.length} routes at ${BASE}`);
}

try {
  await main();
} catch (error) {
  console.error(`verify-demo: ${error.message}`);
  process.exitCode = 1;
}
