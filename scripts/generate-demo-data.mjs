#!/usr/bin/env node
/**
 * Regenerates the dataset the public demonstration is served from.
 *
 * The demonstration runs on a static host, so its API answers are files rather than a
 * running Go process. Those files are produced by the real handlers, through the
 * export in `internal/api/demo_export_test.go`, so this script is the refresh path a
 * future agent runs after changing the console or the API.
 *
 * Running it is deliberately the only way the tracked data changes. A generation that
 * could happen as a side effect of the ordinary suite would let a dataset be committed
 * that nobody looked at, and the review of that diff is the point: it is where a
 * changed response shape is noticed before it reaches the demonstration.
 *
 *   pnpm demo:generate            write the dataset
 *   pnpm demo:generate --check    regenerate to a temporary directory and compare,
 *                                 exiting non-zero when the committed data is stale
 *
 * The isolation matters more than it looks. The run must not inherit the repository's
 * `.env`: an earlier un-isolated run of the demo binary read it, contacted a real
 * gateway and had the address banned. `OMCPA_ENV_FILE=/dev/null` and a throwaway data
 * directory are set below, and the export itself seeds into memory, so nothing it does
 * can reach the network or the worktree.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the generated dataset is tracked. */
const DATA_DIR = join(root, 'deploy', 'cloudflare', 'data');
const DATASET = join(DATA_DIR, 'responses.json');
const PROVENANCE = join(DATA_DIR, 'provenance.json');

/**
 * The files the dataset is derived from, hashed into the provenance record.
 *
 * Kept in step with `scripts/check-demo.mjs`, which recomputes the same digest. A
 * change to any of these is a change that can alter a served response, and the digest
 * is what makes that change fail the check until somebody regenerates and reads the
 * diff.
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
  // The Worker decides routing, refusals and what each response becomes, so a change to
  // it changes what a visitor is served as surely as a change to the export does. It was
  // missing from this list, which meant the two files that most directly shape a served
  // response were the two the digest did not cover.
  'deploy/cloudflare/worker.mjs',
  'scripts/generate-demo-data.mjs',
  // The packaging step decides what the served assets reference, so a change to it
  // changes the demonstration as surely as a change to the Worker does.
  'scripts/build-demo.mjs',
];

/** The digest of the inputs the dataset was generated from. */
async function digestOfInputs() {
  const hash = createHash('sha256');
  for (const name of INPUTS) {
    hash.update(name);
    hash.update('\0');
    hash.update(await readFile(join(root, name), 'utf8'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The export's own test, which is skipped unless it is given an output directory. */
const EXPORT_TEST = 'TestExportDemoDataset';

const GENERATE_TIMEOUT_MS = 300_000;

async function generateInto(directory) {
  await mkdir(directory, { recursive: true });
  await run('go', ['test', './internal/api', '-run', `^${EXPORT_TEST}$`, '-count=1'], {
    cwd: root,
    timeout: GENERATE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      // The demonstration's data is synthetic and seeded into memory, but the process
      // is still a Go binary that reads its environment: pointing it at /dev/null and
      // a temporary directory is what keeps a run from picking up a real deployment's
      // configuration.
      OMCPA_ENV_FILE: '/dev/null',
      OMCPA_DATA_DIR: directory,
      OMCPA_DEMO_EXPORT_DIR: directory,
    },
  });
  return join(directory, 'responses.json');
}

async function main() {
  const check = process.argv.includes('--check');

  if (!check) {
    const generated = await generateInto(DATA_DIR);
    const raw = await readFile(generated, 'utf8');
    // The provenance record is what the freshness check compares against, so it is
    // written by the same run that writes the data it describes.
    const decoded = JSON.parse(raw);
    await writeFile(
      PROVENANCE,
      `${JSON.stringify(
        {
          inputs_digest: await digestOfInputs(),
          response_count: Object.keys(decoded.responses ?? {}).length,
          reference_ms: decoded.reference_ms,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote ${generated} (${(raw.length / 1024).toFixed(1)} KB)`);
    console.log(`wrote ${PROVENANCE}`);
    console.log('review the diff before committing: it is where a changed response shape shows up');
    return;
  }

  // A dry run still regenerates: comparing against the committed file is the only way
  // to tell "the dataset matches the code" from "nobody has regenerated it".
  const scratch = await mkdtemp(join(tmpdir(), 'omc-demo-check-'));
  try {
    const generated = await generateInto(scratch);
    if (!existsSync(DATASET)) {
      throw new Error(`no committed dataset at ${DATASET}; run pnpm demo:generate`);
    }
    const [fresh, committed] = await Promise.all([
      readFile(generated, 'utf8'),
      readFile(DATASET, 'utf8'),
    ]);
    if (fresh === committed) {
      console.log('the committed demonstration dataset matches the current code');
      return;
    }
    await writeFile(join(scratch, 'expected.json'), committed);
    console.error('the committed demonstration dataset is stale; run pnpm demo:generate');
    console.error(`  regenerated: ${generated}`);
    console.error(`  committed  : ${DATASET}`);
    console.error(`  fresh copy : ${join(scratch, 'expected.json')}`);
    process.exitCode = 1;
  } finally {
    if (process.exitCode !== 1) await rm(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`demo-generate: ${error.message}`);
  process.exitCode = 1;
}
