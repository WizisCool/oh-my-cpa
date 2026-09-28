import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { validateArtifactGates, validateBrowserPhases, validateProbeJobs } from './workflow-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = path.join(root, '.github', 'workflows', 'ci.yml');
const source = fs.readFileSync(workflow, 'utf8');
const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
if (document.errors.length > 0) {
  for (const error of document.errors) console.error(error.message);
  process.exitCode = 1;
} else {
  const value = document.toJS();
  for (const jobName of ['static', 'browser']) {
    if (!value.jobs?.[jobName]?.steps?.length) throw new Error(`CI workflow has no ${jobName} steps`);
  }
  if (value.concurrency?.['cancel-in-progress'] !== true) {
    throw new Error('CI workflow does not cancel superseded runs');
  }
  const browserSteps = value.jobs.browser.steps;
  validateArtifactGates(browserSteps);
  const requiredActions = [
    ['static', 'actions/checkout@v7'],
    ['static', 'actions/setup-go@v7'],
    ['static', 'actions/setup-node@v7'],
    ['static', 'actions/cache@v6'],
    ['browser', 'actions/upload-artifact@v7'],
  ];
  for (const [jobName, action] of requiredActions) {
    if (!value.jobs[jobName].steps.some((step) => step.uses === action)) {
      throw new Error(`CI workflow has no ${action} step in ${jobName}`);
    }
  }
  // The browser phases and the probe shards are checked by parsed structure, with
  // negative cases in `workflow-checks.test.mjs`: a step that runs on the wrong event,
  // a shard count that leaves part of the catalog unrun, or an aggregate that passes
  // on a failed shard is each refused.
  validateBrowserPhases(browserSteps);
  validateProbeJobs(value.jobs);
  const browserPreparation = browserSteps.find((step) => step.name === 'Prepare Chromium and build embedded SPA');
  if (!browserPreparation?.run?.includes('install-chromium.mjs') || !browserPreparation.run.includes('pnpm build')) {
    throw new Error('CI workflow does not prepare Chromium and build the SPA in one step');
  }
  if (!browserPreparation.run.includes('tmp/oh-my-cpa-browser')) {
    throw new Error('CI workflow does not prepare a reusable browser binary');
  }
  // The application binary embeds `internal/web/dist`, so it must be compiled after
  // `pnpm build` finishes. A concurrent build could embed a half-written bundle, and
  // the ordering is what the preparation step's own sequencing comment claims.
  const applicationBuildIndex = browserPreparation.run.indexOf('go build -trimpath -o tmp/oh-my-cpa-browser');
  const spaBuildIndex = browserPreparation.run.indexOf('pnpm build');
  if (applicationBuildIndex < 0 || spaBuildIndex < 0 || applicationBuildIndex < spaBuildIndex) {
    throw new Error('CI workflow must build the embedded SPA before the application binary that embeds it');
  }
  // Chromium's shared libraries are not part of the browser cache. The installer
  // probes a real launch and installs them only when it fails, so the guarantee is
  // kept without paying the apt cost on a runner that already has them. Asserting
  // the script is used is what keeps that guarantee from being optimised away again.
  if (!browserPreparation.run.includes('install-chromium.mjs')) {
    throw new Error('CI workflow does not install Chromium through the probe-and-fallback script');
  }
  console.log(`CI workflow parsed: ${value.jobs.static.steps.length} static steps, ${browserSteps.length} browser steps, ${value.jobs.probes.strategy.matrix.shard.length} probe shards.`);
}
