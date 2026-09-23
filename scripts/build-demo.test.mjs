import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(root, 'scripts', 'build-demo.mjs');
const STAGE = join(root, 'tmp', 'cloudflare-demo', 'assets');

/**
 * These test the packaging step against the real built console, because the two bugs it
 * fixes were both invisible until a browser loaded a deep route.
 *
 * A fetch of the site root proved nothing: the references it rewrites are inside a
 * JavaScript chunk and a stylesheet, and they only resolve wrongly when the document is
 * not at the root. So the assertions are about the staged FILES - which is where the
 * mistake lives - rather than about a rendered page.
 */

/** Whether the product's build output is present to stage from. */
function hasBuiltConsole() {
  return existsSync(join(root, 'internal', 'web', 'dist', 'assets'));
}

async function runBuild() {
  const { stdout } = await run('node', [BUILD], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

test('the build rewrites every relative asset reference it stages', async (t) => {
  if (!hasBuiltConsole()) {
    // The gate runs after `pnpm build`; skipping keeps this honest rather than failing
    // for a reason that is not the subject.
    t.skip('no built console at internal/web/dist/assets; run pnpm build first');
    return;
  }

  await runBuild();

  const assets = join(STAGE, 'assets');
  const files = await readdir(assets);
  const offenders = [];

  for (const name of files) {
    if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
    const source = await readFile(join(assets, name), 'utf8');
    // The convention that breaks a deep link: a path beginning `./` in a module or a
    // stylesheet resolves against the current route, not the site root.
    for (const match of source.matchAll(/[("'`]\.\/(lobe-icons|assets|[A-Za-z0-9_-]+\.woff2)/g)) {
      offenders.push(`${name}: ${match[0].slice(1)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `staged modules still reference assets relatively, so they break on a deep route:\n  ${offenders.join('\n  ')}`,
  );
});

test('the staged HTML references only absolute assets', async (t) => {
  if (!hasBuiltConsole()) {
    t.skip('no built console; run pnpm build first');
    return;
  }

  await runBuild();
  const html = await readFile(join(STAGE, 'index.html'), 'utf8');
  const relative = [...html.matchAll(/(?:src|href)="\.\//g)].map((m) => m[0]);
  assert.deepEqual(relative, [], `the staged index still has relative references: ${relative.join(', ')}`);
});

test('the staged page is marked as the demonstration', async (t) => {
  if (!hasBuiltConsole()) {
    t.skip('no built console; run pnpm build first');
    return;
  }

  await runBuild();
  const html = await readFile(join(STAGE, 'index.html'), 'utf8');
  // The console reads this in its first frame to decide whether to show demonstration
  // notices; without it the page renders as an ordinary console.
  assert.match(html, /"demo":\s*true/, 'the runtime configuration does not mark the page as a demonstration');
  assert.match(html, /"basePath":\s*""/, 'the demonstration is served from the root, not a sub-path');
  assert.match(html, /"apiBaseUrl":\s*"\/api\/v1"/, 'the API base is not the demonstration’s');
});
