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
import { chromium } from 'playwright-core';

const BASE = (process.env.OMCPA_DEMO_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

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
