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
    const size = (await readFile(generated)).length;
    console.log(`wrote ${generated} (${(size / 1024).toFixed(1)} KB)`);
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
