/**
 * Runs the two independent release browser phases concurrently.
 *
 * Acceptance drives the built binary, fake CPA and seeded SQLite; probes drive
 * Vite with mocked routes. They have separate browser processes and services, so
 * sharing one workflow step is an optimization, not a shared fixture. Each phase
 * keeps its own status and log: a failure in one must never be hidden by the
 * other finishing first.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phases = [
  { label: 'browser acceptance', script: 'scripts/browser-acceptance.mjs', log: 'tmp/acceptance.log' },
  { label: 'browser probes', script: 'scripts/browser-probes.mjs', log: 'tmp/probes.log' },
];

function runPhase(phase) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs', phase.script], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '';
    // Decode per stream rather than per chunk: acceptance diagnostics contain
    // localized text, and a multi-byte character split across two chunks would
    // otherwise be read as replacement characters in the failure log.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => resolve({ phase, code: 1, output: `${output}${error.message}\n` }));
    child.once('close', (code) => resolve({ phase, code: code ?? 1, output }));
  });
}

const results = await Promise.all(phases.map(runPhase));
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
for (const result of results) {
  fs.writeFileSync(path.join(root, result.phase.log), result.output);
  console.log(`::group::${result.phase.label} log`);
  process.stdout.write(result.output);
  console.log('::endgroup::');
}
const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  console.error(`${failed.map((result) => result.phase.label).join(', ')} failed.`);
  process.exit(1);
}
console.log('browser acceptance and probes passed.');
