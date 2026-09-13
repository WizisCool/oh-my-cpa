/**
 * Installs Playwright's Chromium and guarantees it can actually launch.
 *
 * `playwright-core install --with-deps chromium` costs about 100 seconds on a CI
 * runner, almost all of it apt: the OS shared libraries Chromium links against. The
 * browser cache cannot help, because a cache hit proves the browser *files* are
 * present and says nothing about those libraries.
 *
 * Running it unconditionally is therefore safe but expensive, and skipping it on the
 * assumption that the runner image has the libraries would be an assumption. This
 * script settles the question by asking the only authority there is: it downloads the
 * browser, tries to launch it, and installs the OS dependencies only if the launch
 * fails.
 *
 * The order matters and is what makes it safe rather than optimistic:
 *
 *   1. Install the browser files without `--with-deps`. On a warm cache this is
 *      nearly free; on a cold one it is the download that has to happen either way.
 *   2. Probe a real launch. A download that reports success while the binary cannot
 *      start is exactly the state `--with-deps` exists to repair, so the probe, not
 *      the exit status, decides.
 *   3. On failure, run `--with-deps` and probe again. A second failure is reported
 *      rather than swallowed: the fallback is today's behaviour, so a genuine
 *      installation problem must still fail the job.
 *
 * `--with-deps` is the same command the workflow used to run unconditionally, so the
 * worst case is the previous cost, not a new failure mode.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The probe is a separate process rather than a dynamic import, so a launch failure
 * cannot leave a half-initialised browser handle inside this one.
 */
const PROBE_SOURCE = `
import { chromium } from 'playwright-core';
try {
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error?.message ?? error) + '\\n');
  process.exit(1);
}
`;

/**
 * Whether Chromium can launch right now.
 *
 * `execArgv` is inherited from this process, so the probe runs under the same Node
 * flags the caller used; `probe.js` is written to a temporary directory with the
 * project as its working directory so module resolution finds the pinned
 * `playwright-core`.
 */
export function canLaunchChromium() {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', PROBE_SOURCE],
    { cwd: root, encoding: 'utf8', timeout: 120_000 },
  );
  return { ok: result.status === 0, detail: (result.stderr ?? '').trim() };
}

/** Runs one Playwright install step, streaming its output. */
function install(args) {
  const started = Date.now();
  const result = spawnSync(
    'pnpm',
    ['exec', 'playwright-core', 'install', ...args, 'chromium'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  return { ok: result.status === 0, seconds: (Date.now() - started) / 1000 };
}

const filesOnly = install([]);
if (!filesOnly.ok) {
  console.error('[chromium] the browser download failed');
  process.exit(1);
}
console.log(`[chromium] browser files ready in ${filesOnly.seconds.toFixed(1)}s`);

const probe = canLaunchChromium();
if (probe.ok) {
  // The common case on a runner image that already carries the libraries: the
  // ~100s of apt work is skipped because a real launch just proved it unnecessary.
  console.log('[chromium] launches as installed; OS dependencies not needed');
  process.exit(0);
}

console.log('[chromium] launch failed, installing OS dependencies');
console.log(`[chromium] probe said: ${probe.detail.split('\n')[0] ?? 'no detail'}`);

const withDeps = install(['--with-deps']);
if (!withDeps.ok) {
  console.error('[chromium] installing OS dependencies failed');
  process.exit(1);
}
console.log(`[chromium] OS dependencies installed in ${withDeps.seconds.toFixed(1)}s`);

const recheck = canLaunchChromium();
if (!recheck.ok) {
  // Reported rather than tolerated: this is the state that would otherwise surface
  // as a browser job with no browser.
  console.error(`[chromium] still cannot launch after installing dependencies:\n${recheck.detail}`);
  process.exit(1);
}
console.log('[chromium] launches after installing OS dependencies');
