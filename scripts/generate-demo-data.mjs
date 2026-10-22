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
 *
 * Freshness is checked by `go test ./internal/api`: the same export runs there and
 * fails when the committed copy differs from what the handlers now answer.
 *
 * The isolation matters more than it looks. The run must not inherit the repository's
 * `.env`: an earlier un-isolated run of the demo binary read it, contacted a real
 * gateway and had the address banned. `OMCPA_ENV_FILE=/dev/null` and a throwaway data
 * directory are set below, and the export itself seeds into memory, so nothing it does
 * can reach the network or the worktree.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the generated dataset is tracked. */
const DATA_DIR = join(root, 'deploy', 'cloudflare', 'data');

/** The export's own test, which writes the dataset when it is given an output directory. */
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
      TZ: 'UTC',
      OMCPA_ENV_FILE: '/dev/null',
      OMCPA_DATA_DIR: directory,
      OMCPA_DEMO_EXPORT_DIR: directory,
    },
  });
  return join(directory, 'responses.json');
}

async function main() {
  const generated = await generateInto(DATA_DIR);
  const raw = await readFile(generated, 'utf8');
  console.log(`wrote ${generated} (${(raw.length / 1024).toFixed(1)} KB)`);
  console.log('review the diff before committing: it is where a changed response shape shows up');
}

try {
  await main();
} catch (error) {
  console.error(`demo-generate: ${error.message}`);
  process.exitCode = 1;
}
