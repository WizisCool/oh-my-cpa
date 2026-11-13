import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageApiDocs, stageSite } from './build-site.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('stageApiDocs emits self-contained assets and hashed Scalar bundle', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-api-docs-'));
  try {
    const { scalarFile } = await stageApiDocs({ outDir });
    assert.match(scalarFile, /^scalar\.[a-f0-9]{8}\.js$/);

    const files = fs.readdirSync(outDir).sort();
    assert.deepEqual(files, ['favicon.svg', 'index.html', scalarFile, 'swagger.json']);

    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(html.includes(`./${scalarFile}`), 'HTML must load the hashed local Scalar bundle');
    assert.ok(html.includes('./swagger.json'), 'HTML must load the local swagger.json');
    assert.equal(html.includes('cdn.jsdelivr.net'), false);
    assert.equal(html.includes('unpkg.com'), false);

    const committedSpec = fs.readFileSync(path.join(ROOT, 'docs', 'openapi', 'swagger.json'), 'utf8');
    const stagedSpec = fs.readFileSync(path.join(outDir, 'swagger.json'), 'utf8');
    assert.equal(stagedSpec, committedSpec);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('stageSite accepts custom replaceable landing root, stages /demo subpath, and protects path ownership', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-site-'));
  try {
    const customLanding = path.join(sandbox, 'custom-landing');
    const fakeConsoleDist = path.join(sandbox, 'console-dist');
    const outDir = path.join(sandbox, 'dist');

    fs.mkdirSync(customLanding, { recursive: true });
    fs.writeFileSync(path.join(customLanding, 'index.html'), '<!doctype html><html><body>Custom Landing</body></html>\n');

    fs.mkdirSync(path.join(fakeConsoleDist, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeConsoleDist, 'index.html'),
      '<!doctype html><html><head><script>window.__OMCPA_CONFIG__ = {};</script></head><body><div id="root"></div></body></html>\n',
    );
    fs.writeFileSync(path.join(fakeConsoleDist, 'assets', 'app.js'), 'console.log("ok");\n');

    const { scalarFile, hasDemo } = await stageSite({
      outDir,
      landingDir: customLanding,
      consoleSourceDir: fakeConsoleDist,
    });
    assert.equal(hasDemo, true);
    assert.equal(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), '<!doctype html><html><body>Custom Landing</body></html>\n');
    assert.ok(fs.existsSync(path.join(outDir, '_headers')));
    assert.ok(fs.existsSync(path.join(outDir, 'favicon.svg')));
    assert.ok(fs.existsSync(path.join(outDir, 'api-docs', scalarFile)));
    assert.ok(fs.existsSync(path.join(outDir, 'api-docs', 'swagger.json')));

    const demoHtml = fs.readFileSync(path.join(outDir, 'demo', 'index.html'), 'utf8');
    assert.ok(demoHtml.includes('<base href="/demo/">'));
    assert.ok(demoHtml.includes('"basePath":"/demo"'));
    assert.ok(demoHtml.includes('"apiBaseUrl":"/demo/api/v1"'));
    assert.ok(demoHtml.includes('"mediaBaseUrl":"/demo/media"'));
    assert.ok(demoHtml.includes('"demo":true'));
    assert.equal(fs.existsSync(path.join(outDir, 'demo', '_headers')), false);

    const docsOnlyOut = path.join(sandbox, 'dist-no-demo');
    const noDemoResult = await stageSite({ outDir: docsOnlyOut, landingDir: customLanding, includeDemo: false });
    assert.equal(noDemoResult.hasDemo, false);
    assert.equal(fs.existsSync(path.join(docsOnlyOut, 'demo')), false);

    const conflictingLanding = path.join(sandbox, 'conflicting-landing');
    fs.mkdirSync(path.join(conflictingLanding, 'api-docs'), { recursive: true });
    await assert.rejects(() => stageSite({ outDir, landingDir: conflictingLanding, includeDemo: false }), /must not contain api-docs/);

    const conflictingDemoLanding = path.join(sandbox, 'conflicting-demo-landing');
    fs.mkdirSync(path.join(conflictingDemoLanding, 'demo'), { recursive: true });
    await assert.rejects(
      () => stageSite({ outDir, landingDir: conflictingDemoLanding, consoleSourceDir: fakeConsoleDist }),
      /must not contain demo/,
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
