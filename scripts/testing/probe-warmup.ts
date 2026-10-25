import { chromium } from '@playwright/test';
import type { FullConfig } from '@playwright/test';

/**
 * Compiles the console's module graph once, before any scenario runs.
 *
 * The dev server transforms a route's graph on the first request for it, and the Agent's is the
 * largest; without this, whichever scenario runs first spends that compile inside its own first
 * assertion, which is a cost of the harness rather than of the page. The visit is throwaway: it
 * installs no routes and asserts nothing, and a failure here leaves the scenario's own budgets as
 * they are.
 */
export default async function warmUpDevServer(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${baseURL}/agent`, { waitUntil: 'load', timeout: 120_000 });
  } catch {
    // A warm-up that cannot complete is not a verdict: a host with only another browser installed,
    // or a launch that fails, still lets the scenarios below report on their own.
  } finally {
    await browser?.close();
  }
}
