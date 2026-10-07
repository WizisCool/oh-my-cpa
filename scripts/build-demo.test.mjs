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

test('demo packaging rejects relative assets in an otherwise unchanged staged module', async context => {
  const fixture = await createFixture(context);
  await writeFile(join(fixture.sourceDirectory, 'assets/unhandled.js'), 'const asset = "./assets/new.svg";');
  await assert.rejects(stageDemo(fixture), error => {
    assert.match(error.message, /staged module .*unhandled\.js still references an asset relatively/);
    assert.match(error.message, /\.\/assets\/new\.svg/);
    return true;
  });
});

for (const { path, content, reference } of [
  { path: 'runtime.js', content: 'const icon = `./lobe-icons/${name}.svg`;', reference: './lobe-icons/' },
  { path: 'runtime.css', content: '@font-face{src:url(./body.woff2)}', reference: './body.woff2' },
  { path: 'assets/chunks/deep/icons.js', content: 'const icon = "./lobe-icons/new.svg";', reference: './lobe-icons/' },
  { path: 'assets/chunks/deep/app.css', content: 'body{background:url("./assets/new.svg")}', reference: './assets/' },
  { path: 'assets/font.css', content: '@font-face{src:url("./body.variable.woff2")}', reference: './body.variable.woff2' },
  { path: 'assets/chunks/deep/font.css', content: '@font-face{src:url("./fonts/body.woff2")}', reference: './fonts/body.woff2' },
  { path: 'assets/chunks/deep/font.js', content: 'const font = "./字体.woff2";', reference: './字体.woff2' },
]) {
  test(`demo packaging rejects uncovered relative references in ${path}`, async context => {
    const fixture = await createFixture(context);
    const segments = path.split('/');
    await mkdir(join(fixture.sourceDirectory, ...segments.slice(0, -1)), { recursive: true });
    await writeFile(join(fixture.sourceDirectory, path), content);
    await assert.rejects(stageDemo(fixture), error => {
      assert.ok(error.message.includes(`staged module ${join(...segments)} still references an asset relatively`), error.message);
      assert.ok(error.message.includes(reference), error.message);
      return true;
    });
  });
}

test('demo packaging preserves safe root and nested modules that need no asset rewrite', async context => {
  const fixture = await createFixture(context);
  const modules = [
    { path: 'runtime.js', content: 'import "./chunk.js"; const icon = "/lobe-icons/test.svg";' },
    { path: 'assets/chunks/deep/app.js', content: 'import "./sibling.js"; const asset = "/assets/new.svg";' },
    { path: 'assets/chunks/deep/app.css', content: '@font-face{src:url("/assets/body.woff2")}body{background:url("/assets/new.svg")}' },
  ];
  for (const { path, content } of modules) {
    await mkdir(join(fixture.sourceDirectory, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(fixture.sourceDirectory, path), content);
  }
  const result = await stageDemo(fixture);
  assert.equal(result.rewritten, 2);
  for (const { path, content } of modules) {
    assert.equal(await readFile(join(fixture.stageDirectory, path), 'utf8'), content);
    assert.equal(await readFile(join(fixture.sourceDirectory, path), 'utf8'), content);
  }
});
