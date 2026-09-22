import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = join(root, 'scripts', 'check-demo.mjs');
const DATASET = join(root, 'deploy', 'cloudflare', 'data', 'responses.json');
const PROVENANCE = join(root, 'deploy', 'cloudflare', 'data', 'provenance.json');

/**
 * These are negative controls.
 *
 * The maintenance gate exists to fail when the demonstration's dataset stops matching
 * the code, and a gate that cannot fail is worse than none: it reads as coverage while
 * proving nothing. Each test breaks the dataset in one of the ways the gate claims to
 * catch, asserts that the check reports it, and restores the file afterwards.
 *
 * The check is run as a child process rather than imported, because the exit code is
 * what the gate's callers act on. A check that reports a failure while exiting zero
 * would pass in the fast path and fail only in review.
 */

async function runCheck() {
  try {
    const { stdout } = await run('node', [CHECK], { cwd: root });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * Runs the check against a modified copy of one file, restoring it whatever happens.
 *
 * The restore is in a finally block rather than after the assertions: a failing
 * assertion here would otherwise leave the worktree holding a deliberately broken
 * dataset, and the next command anyone runs would report a defect that this test
 * created.
 */
async function withModifiedFile(path, mutate, assertion) {
  const original = await readFile(path, 'utf8');
  try {
    await writeFile(path, await mutate(original));
    await assertion(await runCheck());
  } finally {
    await writeFile(path, original);
  }
}

test('the check passes on the committed dataset', async () => {
  // Without this, every negative control below could pass for the wrong reason - a
  // check that always fails would satisfy all of them.
  const result = await runCheck();
  assert.equal(result.code, 0, `the check failed on an unmodified worktree:\n${result.output}`);
});

test('it fails when a source the dataset derives from has changed', async () => {
  const source = join(root, 'deploy', 'cloudflare', 'routes.mjs');
  await withModifiedFile(
    source,
    (content) => `${content}\n// an edit the dataset does not acknowledge\n`,
    (result) => {
      assert.equal(result.code, 1);
      assert.match(result.output, /generated from different sources/);
    },
  );
});

test('it fails when a console route has no declared reads', async () => {
  const source = join(root, 'scripts', 'check-demo.mjs');
  await withModifiedFile(
    source,
    (content) => content.replace("  '/system',\n];", "  '/system',\n  '/a-new-page',\n];"),
    (result) => {
      assert.equal(result.code, 1);
      assert.match(result.output, /a-new-page is a console route with no reads/);
    },
  );
});

test('it fails when a declared read has no captured response', async () => {
  const source = join(root, 'scripts', 'check-demo.mjs');
  await withModifiedFile(
    source,
    (content) => content.replace("'/dashboard': ['overview',", "'/dashboard': ['a-missing-response',"),
    (result) => {
      assert.equal(result.code, 1);
      assert.match(result.output, /a-missing-response/);
    },
  );
});

test('it fails when the dataset carries an operator identifier', async () => {
  // The dataset is downloadable by anyone, so this is the failure with the highest
  // cost and the one most likely to be reintroduced by a fixture edit.
  await withModifiedFile(
    DATASET,
    (content) => {
      const decoded = JSON.parse(content);
      const first = Object.keys(decoded.responses)[0];
      decoded.responses[first].body = `{"leaked":"junze · laptop"}`;
      return JSON.stringify(decoded);
    },
    (result) => {
      assert.equal(result.code, 1);
      assert.match(result.output, /operator identifier/);
    },
  );
});

test('it fails when the provenance record disagrees with the dataset', async () => {
  await withModifiedFile(
    PROVENANCE,
    async (content) => {
      const decoded = JSON.parse(content);
      decoded.response_count += 1;
      return JSON.stringify(decoded, null, 2);
    },
    (result) => {
      assert.equal(result.code, 1);
      assert.match(result.output, /provenance records/);
    },
  );
});

test('it reports the dataset as current when everything agrees', async () => {
  // The final control: after six mutations have come and gone, the restored worktree
  // must still pass, which is what proves the restore above is real.
  const scratch = await mkdtemp(join(tmpdir(), 'omc-check-demo-'));
  assert.ok(scratch.startsWith(tmpdir()));
  await rm(scratch, { recursive: true, force: true });

  const result = await runCheck();
  assert.equal(result.code, 0, `the worktree was left modified:\n${result.output}`);
});
