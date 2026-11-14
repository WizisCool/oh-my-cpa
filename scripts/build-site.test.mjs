import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveSiteVersion, stageApiReference, stageSite } from './build-site.mjs';
import { syncDocsSite, listDocsPages, DOCS_SECTIONS } from './sync-docs-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('docs site manifest points every page to existing EN/ZH canonical repository files', () => {
  const slugs = new Set();
  for (const page of listDocsPages()) {
    assert.ok(fs.existsSync(path.join(ROOT, page.source.en)), `missing EN source: ${page.source.en}`);
    assert.ok(fs.existsSync(path.join(ROOT, page.source.zh)), `missing ZH source: ${page.source.zh}`);
    assert.ok(page.title.en && page.title.zh && page.description.en && page.description.zh, `untranslated page: ${page.slug}`);
    assert.equal(slugs.has(page.slug), false, `duplicate slug: ${page.slug}`);
    slugs.add(page.slug);
  }
  assert.equal(DOCS_SECTIONS[0].dir, 'start', 'the first section is the beginner path');
});

test('syncDocsSite generates EN/ZH MDX, agent Markdown and llms.txt with rewritten links', async () => {
  const result = await syncDocsSite({ repoRoot: ROOT });
  assert.equal(result.pageCount, listDocsPages().length * 2);
  for (const file of ['index.mdx', 'index.zh.mdx', 'start/quickstart.mdx', 'start/quickstart.zh.mdx', 'install/index.mdx', 'install/index.zh.mdx']) {
    assert.ok(fs.existsSync(path.join(result.contentDir, file)), `missing ${file}`);
  }

  const enQuickstart = fs.readFileSync(path.join(result.contentDir, 'start', 'quickstart.mdx'), 'utf8');
  assert.ok(enQuickstart.includes('source: "docs/quickstart.md"'));
  assert.ok(enQuickstart.includes('](/en/install/standalone/)'));

  const zhQuickstart = fs.readFileSync(path.join(result.contentDir, 'start', 'quickstart.zh.mdx'), 'utf8');
  assert.ok(zhQuickstart.includes('](/zh/install/standalone/)'), 'same-language links inside ZH docs must stay in ZH locale');

  const zhQuota = fs.readFileSync(path.join(result.contentDir, 'features', 'quota.zh.mdx'), 'utf8');
  assert.ok(zhQuota.includes('](/en/features/quota/)'), 'explicit English-original links inside ZH docs must resolve to the EN page');

  const zhRemote = fs.readFileSync(path.join(result.contentDir, 'install', 'remote-access.zh.mdx'), 'utf8');
  assert.ok(!zhRemote.includes('```caddyfile'), 'unsupported caddyfile language must be normalized for Shiki');

  const publicDir = path.join(ROOT, 'deploy', 'site', 'docs', 'public');
  const agentMarkdown = fs.readFileSync(path.join(publicDir, 'en', 'start', 'quickstart.md'), 'utf8');
  assert.ok(agentMarkdown.startsWith('# Quickstart'));
  assert.ok(agentMarkdown.includes('](https://omc.junze.dev/docs/en/install/standalone/)'), 'agent Markdown links are absolute');
  const llms = fs.readFileSync(path.join(publicDir, 'llms.txt'), 'utf8');
  assert.ok(llms.includes('https://omc.junze.dev/docs/en/start/quickstart.md'));
  assert.ok(fs.existsSync(path.join(publicDir, 'zh', 'llms.txt')));
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

    const sitemap = fs.readFileSync(path.join(outDir, 'sitemap.xml'), 'utf8');
    assert.ok(sitemap.includes('<loc>https://omc.junze.dev/docs/zh/install/standalone/</loc>'));
    assert.ok(sitemap.includes('hreflang="zh-CN" href="https://omc.junze.dev/docs/zh/start/quickstart/"'));
    assert.equal(sitemap.includes('<loc>https://omc.junze.dev/</loc>'), false, 'a copied landing has no known pages');
    assert.ok(fs.readFileSync(path.join(outDir, 'robots.txt'), 'utf8').includes('Sitemap: https://omc.junze.dev/sitemap.xml'));

    const renderedOut = path.join(sandbox, 'dist-rendered');
    await stageSite({ outDir: renderedOut, includeDocs: false, includeDemo: false });
    assert.equal(fs.existsSync(path.join(renderedOut, 'render.mjs')), false, 'the renderer is build input, not a published file');
    assert.equal(fs.existsSync(path.join(renderedOut, 'copy.mjs')), false, 'landing copy module is build input, not a published file');
    const enLanding = fs.readFileSync(path.join(renderedOut, 'index.html'), 'utf8');
    const zhLanding = fs.readFileSync(path.join(renderedOut, 'zh', 'index.html'), 'utf8');
    assert.ok(enLanding.includes('<link rel="canonical" href="https://omc.junze.dev/">'));
    assert.ok(enLanding.includes('hreflang="zh-CN" href="https://omc.junze.dev/zh/"'));
    assert.ok(enLanding.includes('content="https://omc.junze.dev/og/home-en.png"'));
    assert.ok(enLanding.includes('"@type":"SoftwareApplication"'));
    assert.ok(zhLanding.includes('<html lang="zh-CN"'));
    assert.ok(zhLanding.includes('<link rel="canonical" href="https://omc.junze.dev/zh/">'));
    for (const asset of ['site.css', 'site.js', 'images/hero-split.en.webp', 'og/home-en.png', 'og/docs-zh.png']) {
      assert.ok(fs.existsSync(path.join(renderedOut, asset)), `missing ${asset}`);
    }
    assert.ok(fs.readFileSync(path.join(renderedOut, 'sitemap.xml'), 'utf8').includes('<loc>https://omc.junze.dev/zh/</loc>'));

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

test('resolveSiteVersion prefers stable GitHub latest release tag and falls back to package.json', async () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  assert.equal(
    await resolveSiteVersion({
      repoRoot: ROOT,
      fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v0.9.1' }), { status: 200 }),
    }),
    '0.9.1',
  );

  assert.equal(
    await resolveSiteVersion({
      repoRoot: ROOT,
      fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v1.0.0-rc.1' }), { status: 200 }),
    }),
    pkgVersion,
  );

  assert.equal(
    await resolveSiteVersion({
      repoRoot: ROOT,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    }),
    pkgVersion,
  );
});
