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
  if (!browserSteps.some((step) => step.if === "github.event_name != 'pull_request'" && step.run === 'pnpm verify:browser')) {
    throw new Error('CI workflow has no full browser acceptance step');
  }
  const browserPreparation = browserSteps.find((step) => step.name === 'Prepare Chromium and build embedded SPA');
  if (!browserPreparation?.run?.includes('playwright-core install') || !browserPreparation.run.includes('pnpm build')) {
    throw new Error('CI workflow does not prepare Chromium and build the SPA in one step');
  }
  if (!browserPreparation.run.includes('tmp/oh-my-cpa-browser')) {
    throw new Error('CI workflow does not prepare a reusable browser binary');
  }
  for (const name of ['Run deterministic browser smoke', 'Run deterministic browser acceptance']) {
    const step = browserSteps.find((candidate) => candidate.name === name);
    if (step?.env?.OMCPA_BROWSER_BINARY !== 'tmp/oh-my-cpa-browser') {
      throw new Error(`${name} does not reuse the prepared browser binary`);
    }
  }
  console.log(`CI workflow parsed with ${value.jobs.static.steps.length} static and ${browserSteps.length} browser steps.`);
}
