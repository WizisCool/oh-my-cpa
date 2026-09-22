#!/usr/bin/env node
/**
 * The maintenance contract for the demonstration's dataset.
 *
 * The demonstration serves answers generated from the real handlers, so a change to a
 * console page's data can leave the served copy behind. That failure is invisible: the
 * page renders, it simply renders what the API said last month. This is the gate that
 * makes keeping it current an obligation rather than a habit.
 *
 * It checks three things, and each covers a way the dataset can go quietly wrong:
 *
 * 1. **Every read the console makes has somewhere to come from.** The routes the Worker
 *    answers are compared with the routes the console requests, so a new page fails
 *    here rather than in front of a visitor.
 * 2. **The committed dataset matches the code that generates it.** A digest over the
 *    inputs - the export, the fixture, the frontend's API client and types - fails when
 *    one of them changes and the dataset has not been regenerated. It proves
 *    acknowledgement, not correctness; the coverage check and the browser run are what
 *    prove the latter.
 * 3. **Nothing private is in it.** The dataset is public, so an operator identifier,
 *    a credential shape or a deployment hostname is a leak rather than a defect.
 *
 * Run `pnpm demo:generate` to accept an intended change.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DATASET = join(root, 'deploy', 'cloudflare', 'data', 'responses.json');
const PROVENANCE = join(root, 'deploy', 'cloudflare', 'data', 'provenance.json');

/**
 * The files the dataset is derived from.
 *
 * A change to any of them can change a served response, so each one invalidates the
 * committed copy. The list is deliberately the shape of the dependency rather than
 * every file that could be involved: a digest over the whole repository would fail on
 * a documentation edit and train everyone to regenerate without reading.
 */
const INPUTS = [
  'internal/api/demo_export_test.go',
  'internal/demo/fixture.go',
  'internal/demo/seed.go',
  'internal/demo/upstream.go',
  'internal/api/demo_policy.go',
  'web/src/api/client.ts',
  'web/src/types/usageEvents.ts',
  'deploy/cloudflare/routes.mjs',
  'deploy/cloudflare/time.mjs',
  'scripts/generate-demo-data.mjs',
];

/**
 * The console's routes, which the browser check drives. Duplicated from App.tsx for the
 * same reason that check duplicates it: importing the router would make a missing route
 * unrepresentable, and representing it is the point.
 */
const CONSOLE_ROUTES = [
  '/dashboard',
  '/quick-start',
  '/ai-providers',
  '/api-keys',
  '/auth-files',
  '/oauth',
  '/quota',
  '/logs',
  '/usage/events',
  '/pricing',
  '/config',
  '/omc-settings',
  '/plugins',
  '/plugin-store',
  '/system',
];

/**
 * The reads each route makes, named as the Worker's route table names them.
 *
 * A route maps to the dataset entries its page needs, so the check fails when a page's
 * data has no captured response even if the route itself renders.
 */
const ROUTE_READS = {
  '/dashboard': ['overview', 'dashboard-24h', 'dashboard-tail-24h', 'dashboard-models-call-24h', 'dashboard-models-model-24h', 'dashboard-token-heatmap-utc'],
  '/quick-start': ['overview', 'providers', 'api-keys'],
  '/ai-providers': ['providers', 'dashboard-providers-24h'],
  '/api-keys': ['api-keys', 'client-key-aliases'],
  '/auth-files': ['auth-files', 'auth-files-model-aliases', 'auth-files-models'],
  '/oauth': ['oauth-providers', 'oauth-status'],
  '/quota': ['quota', 'quota-codex'],
  '/logs': ['logs', 'logs-status', 'request-error-logs'],
  '/usage/events': ['usage-events', 'usage-facets', 'usage-event-detail', 'usage-ingest-status'],
  '/pricing': ['pricing'],
  '/config': ['config', 'config-source'],
  '/omc-settings': ['preferences', 'system'],
  '/plugins': ['plugins'],
  '/plugin-store': ['plugin-store'],
  '/system': ['system', 'system-releases', 'system-maintenance'],
};

/** Values that must never appear in a dataset a stranger can download. */
const FORBIDDEN = [
  { pattern: /junze/i, why: 'an operator identifier' },
  { pattern: /dongjunze/i, why: 'an operator identifier' },
  { pattern: /@gmail\./i, why: 'a personal email domain' },
  { pattern: /vercel\.app/i, why: 'a deployment hostname' },
  { pattern: /\.vercel\.com/i, why: 'a deployment hostname' },
  { pattern: /vcp_[A-Za-z0-9]{10,}/, why: 'a Vercel token shape' },
  { pattern: /ghp_[A-Za-z0-9]{20,}/, why: 'a GitHub token shape' },
  { pattern: /sk-[A-Za-z0-9]{20,}/, why: 'a provider key shape' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, why: 'a Slack token shape' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'a private key' },
];

async function digestOfInputs() {
  const hash = createHash('sha256');
  for (const name of INPUTS) {
    // A listed file that has been renamed is a broken contract, not a smaller digest:
    // silently skipping it would stop the digest covering the thing it exists to
    // protect.
    const content = await readFile(join(root, name), 'utf8');
    hash.update(name);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function main() {
  const failures = [];

  if (!existsSync(DATASET)) {
    console.error(`  FAIL no dataset at ${relative(root, DATASET)}; run pnpm demo:generate`);
    process.exitCode = 1;
    return;
  }

  const dataset = JSON.parse(await readFile(DATASET, 'utf8'));
  const responses = new Set(Object.keys(dataset.responses ?? {}));

  // 1. Coverage: every route the console has, and every read each one makes.
  const coveredRoutes = Object.keys(ROUTE_READS);
  for (const route of CONSOLE_ROUTES) {
    if (!coveredRoutes.includes(route)) {
      failures.push(`${route} is a console route with no reads declared in check-demo.mjs`);
    }
  }
  for (const [route, reads] of Object.entries(ROUTE_READS)) {
    for (const read of reads) {
      if (!responses.has(read)) {
        failures.push(`${route} needs "${read}", which the dataset does not contain`);
      }
    }
  }

  // 2. Freshness: the dataset must acknowledge the code it was generated from.
  const digest = await digestOfInputs();
  if (!existsSync(PROVENANCE)) {
    failures.push('no provenance.json; run pnpm demo:generate');
  } else {
    const provenance = JSON.parse(await readFile(PROVENANCE, 'utf8'));
    if (provenance.inputs_digest !== digest) {
      failures.push(
        'the dataset was generated from different sources; run pnpm demo:generate and review the diff',
      );
    }
    if (provenance.response_count !== responses.size) {
      failures.push(
        `provenance records ${provenance.response_count} responses but the dataset has ${responses.size}`,
      );
    }
  }

  // 3. Privacy: the dataset is served to anyone who opens the link.
  const body = JSON.stringify(dataset);
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(body)) {
      failures.push(`the dataset contains ${why} (${pattern})`);
    }
  }

  for (const failure of failures) console.error(`  FAIL ${failure}`);
  if (failures.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `the demonstration dataset is current: ${responses.size} responses covering ${CONSOLE_ROUTES.length} console routes`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`check-demo: ${error.message}`);
  process.exitCode = 1;
}
