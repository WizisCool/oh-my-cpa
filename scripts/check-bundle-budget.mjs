import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { analyzeBundle, evaluateBundle, renderBundleSummary } from './bundle-report.mjs';
import { loadBundleReference } from './bundle-baseline.mjs';

export function runBundleVerification({ root, environment = process.env,
  resolveRevision = (reference) => execFileSync('git', ['rev-parse', reference], { cwd: root, encoding: 'utf8' }).trim(),
  log = console.log, warn = console.warn }) {
  const directory = path.join(root, 'tmp/bundle');
  let revision = null;
  function saveEvidence(report, summary) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, 'summary.md'), summary);
    if (environment.GITHUB_STEP_SUMMARY) fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
  }
  try {
    revision = resolveRevision('HEAD');
    const graph = JSON.parse(fs.readFileSync(path.join(directory, 'graph.json'), 'utf8'));
    const report = analyzeBundle(path.join(root, 'web/dist'), graph, revision);
    let baseRevision = environment.BUNDLE_BASE_SHA;
    if (!baseRevision) {
      try { baseRevision = resolveRevision('origin/master'); } catch { /* The comparison is optional; the gate is not. */ }
    }
    const reference = loadBundleReference({ root, revision: baseRevision,
      repository: environment.GITHUB_REPOSITORY, token: environment.GH_TOKEN,
      file: environment.BUNDLE_BASELINE, log: warn });
    const result = evaluateBundle(report, reference);
    const summary = renderBundleSummary(report, reference, result);
    saveEvidence(report, summary);
    log(summary);
    return result.failures.length === 0;
  } catch (error) {
    const message = `Bundle verification failed: ${error.message}`;
    // Replace stale success evidence even when graph/reference validation fails.
    const summary = `## Bundle verification: FAIL\n\n${message}\n`;
    try { saveEvidence({ version: 1, revision, error: message, violations: [message] }, summary); }
    catch { warn('Bundle failure evidence could not be written.'); }
    warn(message);
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!runBundleVerification({ root })) process.exitCode = 1;
}
