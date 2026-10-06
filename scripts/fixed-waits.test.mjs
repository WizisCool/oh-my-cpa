/**
 * A ratchet on fixed waits in tests.
 *
 * A fixed wait either wastes its remaining window or releases too early on a busy
 * runner, so it makes a suite both slower and flakier. Tests here wait on something
 * observable instead: a response, an element, a held route released by the test, a
 * channel, an injected clock. The counts below are what remains: the polling loops
 * inside the condition helpers themselves, waits whose cadence is the contract under
 * test, and older waits nobody has replaced yet.
 *
 * The ratchet only turns one way. Adding a fixed wait fails this test: replace it
 * with a condition (see "Writing a test" in docs/testing.md). Removing one also fails
 * until the count below is lowered, so an improvement cannot be quietly undone.
 *
 * The browser pattern counts `setTimeout` in any form, not only the `setTimeout(resolve`
 * shorthand. Matching the shorthand left the same wait one arrow function away from
 * being invisible to this test, and a ratchet that a small rewrite defeats guards
 * nothing. What this now also counts is the timeout that `rejects` or `fails` a promise
 * rather than waiting for the application - a deadline, which is the opposite of a fixed
 * wait - so those are recorded below instead of being excluded by pattern.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const BASELINE = {
  'internal/api/management_provider_writes_test.go': 1,
  'internal/api/management_system_release_test.go': 4,
  'internal/api/playground_test.go': 1,
  'internal/api/usage_ingest_test.go': 1,
  'internal/api/usage_provider_key_masks_test.go': 1,
  'internal/pricing/pricing_test.go': 2,
  'internal/release/service_test.go': 5,
  'internal/repository/audit_test.go': 1,
  'internal/repository/maintenance_test.go': 6,
  'internal/repository/pricing_openrouter_test.go': 2,
  'internal/repository/usage_pricing_test.go': 1,
  'internal/repository/writegate_test.go': 2,
  'internal/usage/ingest/ingest_gaps_test.go': 3,
  'internal/usage/ingest/ingest_test.go': 4,
  'internal/usage/ingest/polling_test.go': 1,
  'internal/usage/ingest/sync_test.go': 3,
  'scripts/acceptance/harness.mjs': 5,
  // Two deadline guards and the polling cadence of the condition helpers themselves.
  'scripts/acceptance/probe.mjs': 6,
  'scripts/acceptance/probes/dashboardCharts.mjs': 5,
  'scripts/acceptance/probes/dashboardTokenHeatmap.mjs': 8,
  'scripts/acceptance/probes/oauthManagement.mjs': 7,
  'scripts/acceptance/probes/omcSettings.mjs': 1,
  'scripts/acceptance/probes/overlayHistory.mjs': 1,
  'scripts/acceptance/probes/phoneLists.mjs': 1,

  'scripts/acceptance/probes/systemInformation.mjs': 2,
  'scripts/acceptance/probes/touchErgonomics.mjs': 3,
  'scripts/acceptance/probes/usageRecords.mjs': 4,
  'scripts/acceptance/usage-events/filterPanel.mjs': 1,
  'scripts/acceptance/usage-events/searchAndRejections.mjs': 1,
  'scripts/browser-acceptance.mjs': 2,
  'scripts/browser-live-smoke.mjs': 22,
  // Browser test code that the scan set did not reach until the pattern widened: it drives
  // Playwright, and the `hasDemoContent` it exports runs in the page.
  'scripts/demo-readiness.mjs': 1,
  // Raced deadlines - the guards that fail a run when a required read or the browser cleanup
  // never finishes. They reject rather than wait for the application, which is the opposite of
  // a fixed wait, and the widened pattern counts them rather than pretending they are absent.
  'scripts/demo-smoke.mjs': 2,
};

const BROWSER_WAIT = /\bwaitForTimeout\(|\bsleep\(|setTimeout\(/g;
const GO_WAIT = /time\.Sleep\(/g;

function testFiles() {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard',
    'scripts/acceptance', 'scripts/browser-acceptance.mjs', 'scripts/browser-live-smoke.mjs',
    'scripts/demo-smoke.mjs', 'scripts/demo-readiness.mjs', 'scripts/verify-demo.mjs', '*_test.go'], { encoding: 'utf8' });
  return [...new Set(listed.split('\n'))].filter((file) => file && !file.endsWith('.test.mjs') && fs.existsSync(file));
}

test('fixed waits in tests only ever decrease', () => {
  const problems = [];
  for (const file of testFiles()) {
    const pattern = file.endsWith('.go') ? GO_WAIT : BROWSER_WAIT;
    const count = fs.readFileSync(file, 'utf8').match(pattern)?.length ?? 0;
    const allowed = BASELINE[file] ?? 0;
    if (count > allowed) problems.push(`${file}: ${count} fixed wait(s), ${allowed} allowed - wait on an observable condition instead`);
    if (count < allowed) problems.push(`${file}: ${count} fixed wait(s) - lower its baseline in scripts/fixed-waits.test.mjs from ${allowed}`);
  }
  for (const file of Object.keys(BASELINE)) {
    if (!fs.existsSync(file)) problems.push(`${file} no longer exists - remove its baseline`);
  }
  assert.deepEqual(problems, []);
});
