import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stageApiReference, stageSite } from './build-site.mjs';
import { syncDocsSite, DOCS_PAGES, META_FILES } from './sync-docs-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('docs site manifest points every curated EN/ZH page to an existing canonical repository file', () => {
  for (const page of DOCS_PAGES) {
    assert.ok(fs.existsSync(path.join(ROOT, page.enSource)), `missing EN source: ${page.enSource}`);
    assert.ok(fs.existsSync(path.join(ROOT, page.zhSource)), `missing ZH source: ${page.zhSource}`);
  }
  const metaPairs = new Map();
  for (const entry of META_FILES) {
    const base = entry.file.replace(/\.zh\.json$/, '.json');
    metaPairs.set(base, (metaPairs.get(base) ?? 0) + 1);
  }
  for (const [base, count] of metaPairs.entries()) {
    assert.equal(count, 2, `meta file ${base} must exist in both EN and ZH`);
  }
});

test('syncDocsSite generates complete EN/ZH MDX output with rewritten links and local assets', async () => {
  const result = await syncDocsSite({ repoRoot: ROOT });
  assert.equal(result.pageCount, DOCS_PAGES.length * 2);
  assert.ok(fs.existsSync(path.join(result.contentDir, 'index.mdx')));
  assert.ok(fs.existsSync(path.join(result.contentDir, 'index.zh.mdx')));
  assert.ok(fs.existsSync(path.join(result.contentDir, 'getting-started', 'install.mdx')));
  assert.ok(fs.existsSync(path.join(result.contentDir, 'getting-started', 'install.zh.mdx')));

  const enIntro = fs.readFileSync(path.join(result.contentDir, 'index.mdx'), 'utf8');
  assert.ok(enIntro.includes('/docs/images/usage-events.en.webp'));
  assert.ok(enIntro.includes('](/en/getting-started/install/)'));
  assert.ok(enIntro.includes('](/api-reference/)'));
  assert.ok(enIntro.includes('](/demo/)'));

  const zhIntro = fs.readFileSync(path.join(result.contentDir, 'index.zh.mdx'), 'utf8');
  assert.ok(zhIntro.includes('/docs/images/usage-events.zh.webp'));
  assert.ok(zhIntro.includes('](/zh/getting-started/install/)'));
  assert.ok(zhIntro.includes('](/api-reference/)'));
  assert.ok(zhIntro.includes('](/demo/)'));

  const zhInstall = fs.readFileSync(path.join(result.contentDir, 'getting-started', 'install.zh.mdx'), 'utf8');
  assert.ok(!zhInstall.includes('```caddyfile'), 'unsupported caddyfile language must be normalized for Shiki');
});

test('stageApiReference emits self-contained assets and hashed Scalar bundle', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-api-reference-'));
  try {
    const { scalarFile } = await stageApiReference({ outDir });
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

    const headersText = fs.readFileSync(path.join(ROOT, 'deploy', 'site', '_headers'), 'utf8');
    const catchAllPos = headersText.indexOf('\n/*\n');
    const docsRulePos = headersText.indexOf('/docs/_next/static/*');
    const scalarRulePos = headersText.indexOf('/api-reference/scalar.*.js');
    const demoRulePos = headersText.indexOf('/demo/assets/*');
    assert.ok(
      catchAllPos >= 0 && docsRulePos > catchAllPos && scalarRulePos > catchAllPos && demoRulePos > catchAllPos,
      'catch-all /* rule must precede asset overrides',
    );
    assert.equal(headersText.match(/!\s*Cache-Control/g)?.length, 3, 'each asset override must detach inherited Cache-Control');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('stageSite composes replaceable landing root, /docs, /api-reference, and /demo with path ownership checks', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-site-'));
  try {
    const customLanding = path.join(sandbox, 'custom-landing');
    const fakeDocsDist = path.join(sandbox, 'docs-dist');
    const fakeConsoleDist = path.join(sandbox, 'console-dist');
    const outDir = path.join(sandbox, 'dist');

    fs.mkdirSync(customLanding, { recursive: true });
    fs.writeFileSync(path.join(customLanding, 'index.html'), '<!doctype html><html><body>Custom Landing</body></html>\n');

    fs.mkdirSync(path.join(fakeDocsDist, 'en'), { recursive: true });
    fs.mkdirSync(path.join(fakeDocsDist, 'zh'), { recursive: true });
    fs.writeFileSync(path.join(fakeDocsDist, 'index.html'), '<html>docs entry</html>');
    fs.writeFileSync(path.join(fakeDocsDist, 'en', 'index.html'), '<html>en docs</html>');
    fs.writeFileSync(path.join(fakeDocsDist, 'zh', 'index.html'), '<html>zh docs</html>');
    fs.writeFileSync(path.join(fakeDocsDist, 'search-index.json'), '{"type":"advanced"}');

    fs.mkdirSync(path.join(fakeConsoleDist, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeConsoleDist, 'index.html'),
      '<!doctype html><html><head><script>window.__OMCPA_CONFIG__ = {};</script></head><body><div id="root"></div></body></html>\n',
    );
    fs.writeFileSync(path.join(fakeConsoleDist, 'assets', 'app.js'), 'console.log("ok");\n');

    const { scalarFile, hasDocs, hasDemo } = await stageSite({
      outDir,
      landingDir: customLanding,
      docsSourceDir: fakeDocsDist,
      consoleSourceDir: fakeConsoleDist,
    });
    assert.equal(hasDocs, true);
    assert.equal(hasDemo, true);
    assert.equal(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), '<!doctype html><html><body>Custom Landing</body></html>\n');
    assert.ok(fs.existsSync(path.join(outDir, '_headers')));
    assert.ok(fs.existsSync(path.join(outDir, 'favicon.svg')));
    assert.ok(fs.existsSync(path.join(outDir, 'wordmark-light.svg')));
    assert.ok(fs.existsSync(path.join(outDir, 'wordmark-dark.svg')));
    assert.ok(fs.existsSync(path.join(outDir, 'api-reference', scalarFile)));
    assert.ok(fs.existsSync(path.join(outDir, 'api-reference', 'swagger.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'docs', 'index.html')));
    assert.ok(fs.existsSync(path.join(outDir, 'docs', 'en', 'index.html')));
    assert.ok(fs.existsSync(path.join(outDir, 'docs', 'zh', 'index.html')));
    assert.ok(fs.existsSync(path.join(outDir, 'docs', 'search-index.json')));

    const demoHtml = fs.readFileSync(path.join(outDir, 'demo', 'index.html'), 'utf8');
    assert.ok(demoHtml.includes('<base href="/demo/">'));
    assert.ok(demoHtml.includes('"basePath":"/demo"'));
    assert.ok(demoHtml.includes('"apiBaseUrl":"/demo/api/v1"'));
    assert.ok(demoHtml.includes('"mediaBaseUrl":"/demo/media"'));
    assert.ok(demoHtml.includes('"demo":true'));
    assert.equal(fs.existsSync(path.join(outDir, 'demo', '_headers')), false);

    const apiOnlyOut = path.join(sandbox, 'dist-api-only');
    const apiOnlyResult = await stageSite({
      outDir: apiOnlyOut,
      landingDir: customLanding,
      includeDocs: false,
      includeDemo: false,
    });
    assert.equal(apiOnlyResult.hasDocs, false);
    assert.equal(apiOnlyResult.hasDemo, false);
    assert.equal(fs.existsSync(path.join(apiOnlyOut, 'docs')), false);
    assert.equal(fs.existsSync(path.join(apiOnlyOut, 'demo')), false);

    const conflictingApiLanding = path.join(sandbox, 'conflicting-api-landing');
    fs.mkdirSync(path.join(conflictingApiLanding, 'api-reference'), { recursive: true });
    await assert.rejects(
      () => stageSite({ outDir, landingDir: conflictingApiLanding, includeDocs: false, includeDemo: false }),
      /must not contain api-reference/,
    );

    const conflictingDocsLanding = path.join(sandbox, 'conflicting-docs-landing');
    fs.mkdirSync(path.join(conflictingDocsLanding, 'docs'), { recursive: true });
    await assert.rejects(
      () => stageSite({ outDir, landingDir: conflictingDocsLanding, docsSourceDir: fakeDocsDist, includeDemo: false }),
      /must not contain docs/,
    );

    const conflictingDemoLanding = path.join(sandbox, 'conflicting-demo-landing');
    fs.mkdirSync(path.join(conflictingDemoLanding, 'demo'), { recursive: true });
    await assert.rejects(
      () => stageSite({ outDir, landingDir: conflictingDemoLanding, includeDocs: false, consoleSourceDir: fakeConsoleDist }),
      /must not contain demo/,
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
