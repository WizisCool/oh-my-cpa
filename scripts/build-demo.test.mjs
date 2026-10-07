import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stageDemo } from './build-demo.mjs';

async function createFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'omc-demo-stage-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDirectory = join(directory, 'source');
  const stageDirectory = join(directory, 'stage');
  await mkdir(join(sourceDirectory, 'assets'), { recursive: true });
  await writeFile(join(sourceDirectory, 'index.html'), '<script>window.__OMCPA_CONFIG__={};</script><script src="./assets/app.js"></script><link href="./assets/app.css">');
  await writeFile(join(sourceDirectory, 'assets/app.js'), 'const icon = `./lobe-icons/${name}-color.svg`;');
  await writeFile(join(sourceDirectory, 'assets/app.css'), '@font-face{src:url("./body.woff2")}');
  await writeFile(join(sourceDirectory, '.gitkeep'), '');
  return { directory, sourceDirectory, stageDirectory };
}

test('demo packaging rewrites HTML, modules and styles without a product build', async context => {
  const fixture = await createFixture(context);
  const result = await stageDemo(fixture);
  assert.equal(result.rewritten, 2);
  const html = await readFile(join(fixture.stageDirectory, 'index.html'), 'utf8');
  assert.match(html, /"demo":true/);
  assert.match(html, /"basePath":""/);
  assert.match(html, /"apiBaseUrl":"\/api\/v1"/);
  assert.match(html, /src="\/assets\/app.js"/);
  assert.match(html, /href="\/assets\/app.css"/);
  assert.doesNotMatch(html, /(?:src|href)="\.\//);
  assert.equal(await readFile(join(fixture.stageDirectory, 'assets/app.js'), 'utf8'), 'const icon = `/lobe-icons/${name}-color.svg`;');
  assert.equal(await readFile(join(fixture.stageDirectory, 'assets/app.css'), 'utf8'), '@font-face{src:url("/assets/body.woff2")}');
  assert.ok((await readFile(join(fixture.stageDirectory, '_headers'), 'utf8')).length > 0);
  assert.ok(!(await readdir(fixture.stageDirectory)).includes('.gitkeep'));
  assert.match(await readFile(join(fixture.sourceDirectory, 'assets/app.js'), 'utf8'), /\.\/lobe-icons/);
});

test('concurrent packaging owns only its supplied stage and preserves sibling runtime assets', async context => {
  const first = await createFixture(context);
  const second = await createFixture(context);
  const runtimeStage = join(first.directory, 'runtime');
  await mkdir(runtimeStage);
  await writeFile(join(runtimeStage, 'index.html'), 'live runtime');
  await mkdir(first.stageDirectory);
  await writeFile(join(first.stageDirectory, 'stale.txt'), 'old artifact');
  await Promise.all([stageDemo(first), stageDemo(second)]);
  assert.equal(await readFile(join(runtimeStage, 'index.html'), 'utf8'), 'live runtime');
  assert.ok(!(await readdir(first.stageDirectory)).includes('stale.txt'));
  for (const fixture of [first, second]) {
    assert.match(await readFile(join(fixture.stageDirectory, 'index.html'), 'utf8'), /"demo":true/);
  }
});

test('missing builds and missing runtime markers fail packaging', async context => {
  const fixture = await createFixture(context);
  await rm(join(fixture.sourceDirectory, 'index.html'));
  await assert.rejects(stageDemo(fixture), /no built console/);
  await writeFile(join(fixture.sourceDirectory, 'index.html'), '<html></html>');
  await assert.rejects(stageDemo(fixture), /no runtime configuration/);
});
