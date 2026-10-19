import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkDemo, CONSOLE_ROUTES, ROUTE_READS } from './check-demo.ts';
import { INPUTS } from './demo-inputs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = 'deploy/cloudflare/data/responses.json';
const PROVENANCE = 'deploy/cloudflare/data/provenance.json';
const RECORDINGS = ['web/src/demo/agentRecording.json', 'web/src/demo/playgroundRecording.json'];
const execute = promisify(execFile);

// Negative controls must own their inputs. Restoring a shared file in finally cannot
// protect a concurrent gate (or another developer) from reading the mutation window.
async function createFixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'omc-demo-check-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([...new Set([...INPUTS, DATASET, PROVENANCE, ...RECORDINGS])].map(async name => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await cp(join(ROOT, name), join(root, name));
  }));
  return root;
}

async function mutateJSON<T>(root: string, name: string, mutate: (value: T) => void) {
  const file = join(root, name);
  const value = JSON.parse(await readFile(file, 'utf8'));
  mutate(value);
  await writeFile(file, JSON.stringify(value));
}

async function runCheck(root: string) {
  const script = `import { runDemoCheck } from ${JSON.stringify(new URL('./check-demo.ts', import.meta.url).href)}; process.exitCode = await runDemoCheck(${JSON.stringify(root)});`;
  try {
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: ROOT });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

test('the gate succeeds on an isolated copy of the committed inputs', async context => {
  const result = await runCheck(await createFixture(context));
  assert.equal(result.code, 0, result.output);
});

test('source changes fail the gate with a nonzero exit code', async context => {
  const root = await createFixture(context);
  const file = join(root, 'deploy/cloudflare/routes.mjs');
  await writeFile(file, `${await readFile(file, 'utf8')}\n// modified fixture input\n`);
  const result = await runCheck(root);
  assert.equal(result.code, 1);
  assert.match(result.output, /generated from different sources/);
});

test('console routes and declared reads cannot silently lose coverage', async context => {
  const root = await createFixture(context);
  assert.ok((await checkDemo(root, { consoleRoutes: [...CONSOLE_ROUTES, '/a-new-page'] })).failures.some(message => /a-new-page is a console route with no reads/.test(message)));
  assert.ok((await checkDemo(root, { routeReads: { ...ROUTE_READS, '/dashboard': ['a-missing-response'] } })).failures.some(message => /a-missing-response/.test(message)));
});

test('public responses and recordings reject private identifiers', async context => {
  const root = await createFixture(context);
  await mutateJSON(root, DATASET, (value: { responses: Record<string, { body: string }> }) => {
    value.responses[Object.keys(value.responses)[0]].body = '{"leaked":"junze · laptop"}';
  });
  assert.ok((await checkDemo(root)).failures.some(message => /operator identifier/.test(message)));
  await mutateJSON(root, RECORDINGS[0], (value: { client_key_fingerprint: string }) => { value.client_key_fingerprint = `hmac:${'ab12'.repeat(16)}`; });
  assert.ok((await checkDemo(root)).failures.some(message => /agentRecording\.json contains a client key fingerprint/.test(message)));
});

test('provenance counts and every OAuth model read are enforced', async context => {
  const root = await createFixture(context);
  await mutateJSON(root, PROVENANCE, (value: { response_count: number }) => { value.response_count += 1; });
  assert.ok((await checkDemo(root)).failures.some(message => /provenance records/.test(message)));
  for (const name of ['auth-files-excluded-models', 'auth-files-provider-models-claude', 'auth-files-provider-models-codex', 'auth-files-provider-models-none']) {
    await mutateJSON(root, DATASET, (value: { responses: Record<string, unknown> }) => { delete value.responses[name]; });
    assert.ok((await checkDemo(root)).failures.some(message => message.includes(`/oauth-management needs "${name}"`)));
  }
});

test('concurrent negative controls do not alter each other or the live worktree', async context => {
  const names = [...new Set([...INPUTS, DATASET, PROVENANCE, ...RECORDINGS])];
  const before = await Promise.all(names.map(name => readFile(join(ROOT, name))));
  const [broken, intact] = await Promise.all([createFixture(context), createFixture(context)]);
  await mutateJSON(broken, PROVENANCE, (value: { response_count: number }) => { value.response_count = -1; });
  const [negative, positive, live] = await Promise.all([checkDemo(broken), checkDemo(intact), checkDemo()]);
  assert.ok(negative.failures.some(message => /provenance records/.test(message)));
  assert.deepEqual(positive.failures, []);
  assert.deepEqual(live.failures, []);
  for (const [index, name] of names.entries()) assert.deepEqual(await readFile(join(ROOT, name)), before[index], name);
});
