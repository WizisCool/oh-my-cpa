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
import { canLaunchChromium, installChromium } from './install-chromium.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

const SILENT = { log() {}, error() {} };

/** Runs the decision against scripted install and probe results, recording the calls. */
function decide({ installs, probes }) {
  const calls = [];
  const code = installChromium({
    runInstall: (args) => {
      calls.push(['install', ...args]);
      return { ok: installs.shift(), seconds: 0 };
    },
    probeLaunch: () => {
      calls.push(['probe']);
      return { ok: probes.shift(), detail: 'libnss3.so: cannot open shared object file' };
    },
    log: SILENT,
  });
  return { code, calls };
}

test('a browser that launches as downloaded skips the OS dependencies', () => {
  const { code, calls } = decide({ installs: [true], probes: [true] });
  assert.equal(code, 0);
  assert.deepEqual(calls, [['install'], ['probe']]);
});

test('the launch probe, not the download result, decides the fallback', () => {
  const { code, calls } = decide({ installs: [true, true], probes: [false, true] });
  assert.equal(code, 0);
  assert.deepEqual(calls, [['install'], ['probe'], ['install', '--with-deps'], ['probe']]);
});

test('a failed download stops before probing', () => {
  const { code, calls } = decide({ installs: [false], probes: [] });
  assert.equal(code, 1);
  assert.deepEqual(calls, [['install']]);
});

test('a failed dependency install fails the job', () => {
  const { code } = decide({ installs: [true, false], probes: [false] });
  assert.equal(code, 1);
});

test('a browser that still cannot launch is reported rather than ignored', () => {
  const { code, calls } = decide({ installs: [true, true], probes: [false, false] });
  assert.equal(code, 1);
  assert.equal(calls.filter(([step]) => step === 'probe').length, 2);
});

test('the probe runs in its own process, so a failed launch cannot leave a handle behind', () => {
  const spawned = [];
  const verdict = canLaunchChromium((command, args) => {
    spawned.push([command, ...args]);
    return { status: 1, stderr: 'launch failed\n' };
  });
  assert.deepEqual(verdict, { ok: false, detail: 'launch failed' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][0], process.execPath);
  assert.ok(spawned[0].includes('--input-type=module'));
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
