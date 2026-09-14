/**
 * The focused browser probes, as the release gate's entry point.
 *
 * Each of these used to be a standalone script with its own Vite server and its own
 * Chromium, and three of them sat outside `pnpm verify:full` entirely: the
 * icon-picker stacking, the column geometry and the dashboard chart marks were only
 * run if someone remembered the command. A probe that guards a real invariant but
 * never runs in the gate is a comment with a `pnpm` script attached.
 *
 * They now share one server and one browser through `acceptance/probe.mjs`, and the
 * scenarios themselves live in `acceptance/scenarios.mjs` as data. That split is
 * what lets `pnpm check:ui` run the relevant subset against the dev server during
 * development without this file's release-gate framing getting in the way.
 *
 * Run it with `pnpm verify:probes`; it is also part of `pnpm verify:full`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProbeChecker, runProbes } from './acceptance/probe.mjs';
import { SCENARIOS } from './acceptance/scenarios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The dev server port is pinned and `strictPort` is on, so a collision fails loudly
// instead of silently binding elsewhere and testing an unrelated app.
const PORT = 5180;

const { check, failures } = createProbeChecker();

// Every scenario, in registry order. The registry supplies the fixtures and the
// assertions; this file supplies the runner's reporting, so a scenario does not have
// to know whether it is being run by the release gate or by the fast path.
const scenarios = SCENARIOS.map((scenario) => ({ ...scenario, check }));

const FAILURE_DIR = path.join(root, 'tmp', 'probe-failure');
const startedAt = Date.now();
const { passed, failures: runFailures } = await runProbes({ port: PORT, scenarios });

// A scenario that threw rather than asserted is reported through the same channel as
// a failed check, so the exit code reflects it either way.
for (const failure of runFailures) check(`scenario ${failure} completed`, false);

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\n${failures.length} probe check(s) failed across ${passed}/${scenarios.length} scenario(s) in ${seconds}s.`);
  if (fs.existsSync(FAILURE_DIR)) {
    console.error(`Diagnostics (screenshot, DOM, page errors) are in ${path.relative(root, FAILURE_DIR)}.`);
  }
  process.exit(1);
}
console.log(`\nprobe run complete: ${scenarios.length} scenario(s) passed in ${seconds}s.`);
