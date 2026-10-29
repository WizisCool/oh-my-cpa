import { test, prepareScenario } from './probe-fixtures.ts';
import { SCENARIOS } from '../acceptance/scenarios.mjs';
import { probeWorkspaces } from '../acceptance/check-ui-plan.mjs';
import { PAGE_BOOT_TIMEOUT_MS } from '../acceptance/harness.mjs';

const ids: string[] = JSON.parse(process.env.OMC_PROBE_IDS ?? '[]');
// Warm the authenticated lazy route, not sign-in. Native setup dependencies keep
// cold compilation outside interaction measurements and own browser cancellation.
for (const name of probeWorkspaces(ids)) {
  test(`warm ${name}`, async ({ probe }) => {
    const scenario = SCENARIOS.find(scenario => scenario.id === name)!;
    await prepareScenario(probe, scenario.options?.routes ?? []);
    const deadline = Date.now() + PAGE_BOOT_TIMEOUT_MS;
    await probe.page.goto(`${probe.base}/${name}`, { waitUntil: 'load', timeout: PAGE_BOOT_TIMEOUT_MS });
    await probe.page.locator(`[data-testid="${name}-page"]`).waitFor({ timeout: Math.max(1, deadline - Date.now()) });
  });
}
