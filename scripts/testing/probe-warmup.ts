import { chromium } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import { installRoutes } from '../acceptance/probe.mjs';
import { guardBrowserContext } from '../acceptance/browser-guard.mjs';
import { SCENARIOS } from '../acceptance/scenarios.mjs';
import { probeWorkspaces } from '../acceptance/check-ui-plan.mjs';
import { PAGE_BOOT_TIMEOUT_MS } from '../acceptance/harness.mjs';

// A cold workspace route must finish compiling before interaction measurements.
// An anonymous visit only renders sign-in, so it never warms either lazy workspace.
export default async function warmUpDevServer(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  const ids: string[] = JSON.parse(process.env.OMC_PROBE_IDS ?? '[]');
  const workspaces = probeWorkspaces(ids);
  if (!baseURL || !workspaces.length) return;
  const browser = await chromium.launch();
  try {
    for (const name of workspaces) {
      const context = await browser.newContext();
      try {
        const scenario = SCENARIOS.find(scenario => scenario.id === name)!;
        const ledger = await guardBrowserContext(context, [baseURL]);
        await installRoutes(context, scenario.options?.routes ?? [], ledger);
        const page = await context.newPage();
        const deadline = Date.now() + PAGE_BOOT_TIMEOUT_MS;
        await page.goto(`${baseURL}/${name}`, { waitUntil: 'load', timeout: PAGE_BOOT_TIMEOUT_MS });
        await page.locator(`[data-testid="${name}-page"]`).waitFor({ timeout: Math.max(1, deadline - Date.now()) });
        if (ledger.unexpected().length) throw new Error(`Unexpected browser faults while warming ${name}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
