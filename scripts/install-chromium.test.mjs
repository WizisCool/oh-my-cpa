/**
 * Tests for the Chromium installer's decision, not its implementation.
 *
 * The script's whole purpose is to skip about 100 seconds of apt work when the runner
 * already has what Chromium needs, without ever leaving the job without a working
 * browser. That is a safety property with two halves, and both are asserted here:
 *
 *   - A launch probe decides, and its verdict - not the download's exit status -
 *     drives whether the OS dependencies are installed.
 *   - The fallback is the command the workflow used to run unconditionally, so a
 *     failed probe still ends in a working browser, and a second failure is reported
 *     rather than swallowed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'install-chromium.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

test('the decision comes from a launch probe, not from the download result', () => {
  // If the exit status of the download decided, a browser whose shared libraries are
  // missing would be treated as ready - which is the exact state `--with-deps` exists
  // to repair.
  assert.match(source, /canLaunchChromium\(\)/, 'a launch probe exists');
  assert.match(source, /const probe = canLaunchChromium\(\);/, 'the probe is consulted');
  assert.match(source, /if \(probe\.ok\)/, 'the probe verdict branches the install');
  // The probe must actually launch and close a browser, not merely resolve the module.
  assert.match(source, /chromium\.launch\(/, 'the probe launches Chromium');
  assert.match(source, /browser\.close\(\)/, 'the probe closes it');
});

test('the fallback is the command the workflow used to run unconditionally', () => {
  // The worst case of the optimisation must be the previous cost, never a new failure
  // mode: a probe that cannot tell the difference must still end in a working browser.
  assert.match(source, /install\(\['--with-deps'\]\)/, 'the fallback installs OS dependencies');
});

test('a browser that still cannot launch is reported rather than ignored', () => {
  // Without this, the fallback could fail silently and surface as a browser job with
  // no browser - a failure attributed to the tests rather than to the environment.
  assert.match(source, /const recheck = canLaunchChromium\(\);/, 'the fallback is re-probed');
  assert.match(source, /still cannot launch after installing dependencies/, 'the second failure is reported');
});

test('the probe cannot leave a browser handle behind', () => {
  // The probe runs in a separate process on purpose, so a failed launch cannot strand
  // a half-initialised handle inside the installer.
  assert.match(source, /spawnSync\(/, 'the probe is a subprocess');
  assert.match(source, /--input-type=module/, 'the probe is evaluated as a module');
});

test('the workflow runs the installer and does not install dependencies directly', () => {
  assert.match(workflow, /node scripts\/install-chromium\.mjs/, 'the workflow uses the installer');
  assert.ok(
    !/playwright-core install --with-deps chromium/.test(workflow),
    'the workflow does not run the unconditional install itself',
  );
});

test('the workflow still verifies the installer failed before continuing', () => {
  // The installer is backgrounded so it overlaps the SPA build; its status has to be
  // collected, or a failed install would be reported as a green step.
  assert.match(workflow, /wait "\$\{install_pid\}"/, 'the install status is awaited');
  assert.match(workflow, /exit "\$\{install_status\}"/, 'a failed install fails the step');
});
