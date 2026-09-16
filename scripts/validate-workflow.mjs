import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

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
  if (!browserSteps.some((step) => step.if === "github.event_name == 'pull_request'" && step.run === 'pnpm verify:browser:smoke')) {
    throw new Error('CI workflow has no pull-request browser smoke step');
  }
  if (!browserSteps.some((step) => step.if === "github.event_name == 'pull_request'" && step.run === 'pnpm verify:browser:p0')) {
    throw new Error('CI workflow has no pull-request browser P0 gate');
  }
  // The two browser phases run concurrently on master, and the step must fail when
  // either does: a concurrent step whose status is not collected reports a green
  // build for a failed run, which is worse than running them sequentially.
  const masterBrowser = browserSteps.find((step) => step.name === 'Run browser acceptance and probes');
  if (!masterBrowser) {
    throw new Error('CI workflow does not run the browser phases together on master');
  }
  if (masterBrowser.run.includes('verify:browser:smoke')) {
    throw new Error('the master browser step must not run the pull-request smoke path');
  }
  if (masterBrowser.run !== 'pnpm verify:browser:release') {
    throw new Error('the master browser step does not use the release browser orchestrator');
  }
  // The probes reach master for the first time here: they used to sit outside every
  // gate, so a regression in overlay stacking or column geometry was only caught if
  // someone remembered the command.
  const browserOrchestrator = fs.readFileSync(path.join(root, 'scripts', 'run-browser-release.mjs'), 'utf8');
  for (const marker of ['scripts/browser-acceptance.mjs', 'scripts/browser-probes.mjs', 'Promise.all', 'failed.length']) {
    if (!browserOrchestrator.includes(marker)) {
      throw new Error(`the browser orchestrator omits ${marker}`);
    }
  }
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
  for (const name of ['Run deterministic browser smoke', 'Run deterministic browser P0 gates']) {
    const step = browserSteps.find((candidate) => candidate.name === name);
    if (step?.env?.OMCPA_BROWSER_BINARY !== 'tmp/oh-my-cpa-browser') {
      throw new Error(`${name} does not reuse the prepared browser binary`);
    }
  }
  if (masterBrowser.env?.OMCPA_BROWSER_BINARY !== 'tmp/oh-my-cpa-browser') {
    throw new Error('the master browser step does not reuse the prepared browser binary');
  }
  console.log(`CI workflow parsed with ${value.jobs.static.steps.length} static and ${browserSteps.length} browser steps.`);
}
