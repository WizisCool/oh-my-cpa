import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateReference } from './bundle-report.mjs';

function runGitHub(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('GitHub baseline retrieval failed');
  return result.stdout;
}

export function selectBaselineRun(runs, revision) {
  return runs.filter((run) => run.head_sha === revision && run.event === 'push' && run.conclusion === 'success')
    .sort((left, right) => right.id - left.id)[0];
}

// A missing/expired comparison is reported, never substituted with another commit.
// Structural checks and absolute anomaly ceilings do not depend on this artifact.
export function loadBundleReference({ root, revision, repository, token, file, run = runGitHub, log = console.warn }) {
  if (!revision || !/^[a-f\d]{40}$/.test(revision)) {
    log('Bundle reference unavailable: no exact base revision supplied.');
    return null;
  }
  function readReference(referenceFile) {
    const reference = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
    if (!validateReference(reference, revision)) throw new Error('Bundle reference does not match the requested revision or schema');
    return reference;
  }
  if (file) return readReference(file);
  const seed = path.join(root, 'scripts/bundle-reference.json');
  if (fs.existsSync(seed)) {
    const reference = JSON.parse(fs.readFileSync(seed, 'utf8'));
    if (validateReference(reference, revision)) return reference;
  }
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) {
    log(`Bundle reference unavailable for ${revision}: provide BUNDLE_BASELINE or a GitHub Actions artifact.`);
    return null;
  }
  try {
    const response = JSON.parse(run(['api', '--method', 'GET', `repos/${repository}/actions/workflows/ci.yml/runs`, '-f', `head_sha=${revision}`, '-f', 'event=push', '-f', 'status=success', '-f', 'per_page=20']));
    const selected = selectBaselineRun(response.workflow_runs ?? [], revision);
    if (!selected) throw new Error('No successful push run for the exact base');
    const artifacts = JSON.parse(run(['api', `repos/${repository}/actions/runs/${selected.id}/artifacts`])).artifacts ?? [];
    if (!artifacts.some((artifact) => artifact.name === 'bundle-report' && !artifact.expired)) throw new Error('Base bundle report is missing or expired');
    const directory = path.join(root, 'tmp/bundle/reference');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    run(['run', 'download', String(selected.id), '--repo', repository, '--name', 'bundle-report', '--dir', directory]);
    return readReference(path.join(directory, 'report.json'));
  } catch {
    log(`Bundle reference unavailable for ${revision}: exact-base artifact could not be retrieved. Growth comparison not performed.`);
    return null;
  }
}
