#!/usr/bin/env node
/**
 * Assembles the static public site, `/docs` Fumadocs site, `/api-reference` Scalar UI,
 * and `/demo` console assets.
 *
 * Host-agnostic by design:
 * - `pnpm build:api-reference` (`--api-reference-only`) emits a self-contained static
 *   directory (`index.html`, `scalar.<hash>.js`, `swagger.json`, `favicon.svg`) for
 *   `/api-reference/`.
 * - `pnpm build:docs` syncs curated repository docs into `deploy/site/docs/content/docs/`
 *   and runs the Next.js Fumadocs static export (`deploy/site/docs/out/`).
 * - `pnpm build:site` composes the replaceable landing root (`deploy/site/landing/` or
 *   `--landing-dir <dir>`), `/docs/`, `/api-reference/`, `/demo/` (via `stageDemo`), the
 *   social cards (`/og/`), `sitemap.xml`, `robots.txt` and `_headers` into `tmp/site/dist/`.
 *   A landing directory with `render.mjs` is rendered per language; any other directory is
 *   copied as-is.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageDemo } from './build-demo.mjs';
import { ensureDemoDataset } from './generate-demo-data.mjs';
import { DOCS_LANGUAGES, SITE_ORIGIN, docsUrl, listDocsPages } from './sync-docs-site.mjs';
import { GITHUB_REPO } from '../deploy/site/site-meta.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export const DEFAULT_SITE_OUTPUT = join(root, 'tmp', 'site', 'dist');
export const DEFAULT_API_REFERENCE_OUTPUT = join(root, 'tmp', 'api-reference');
export const DEFAULT_DOCS_PROJECT = join(root, 'deploy', 'site', 'docs');
export const DEFAULT_DOCS_OUTPUT = join(DEFAULT_DOCS_PROJECT, 'out');

function resolveScalarStandalone(repoRoot) {
  const direct = join(repoRoot, 'node_modules', '@scalar', 'api-reference', 'dist', 'browser', 'standalone.js');
  if (existsSync(direct)) return direct;
  const entry = require.resolve('@scalar/api-reference');
  return join(dirname(entry), 'browser', 'standalone.js');
}

export async function stageApiReference({
  repoRoot = root,
  outDir = DEFAULT_API_REFERENCE_OUTPUT,
  specPath = join(repoRoot, 'docs', 'openapi', 'swagger.json'),
  templatePath = join(repoRoot, 'deploy', 'site', 'api-reference', 'index.html'),
  faviconPath = join(repoRoot, 'web', 'public', 'favicon.svg'),
  scalarPath = resolveScalarStandalone(repoRoot),
} = {}) {
  for (const [label, file] of [
    ['OpenAPI spec', specPath],
    ['API reference HTML template', templatePath],
    ['Scalar standalone bundle', scalarPath],
    ['favicon', faviconPath],
  ]) {
    if (!existsSync(file)) {
      throw new Error(`missing ${label} at ${file}`);
    }
  }

  const scalarBytes = await readFile(scalarPath);
  const scalarHash = createHash('sha256').update(scalarBytes).digest('hex').slice(0, 8);
  const scalarFile = `scalar.${scalarHash}.js`;

  const template = await readFile(templatePath, 'utf8');
  if (!template.includes('__SCALAR_BUNDLE__')) {
    throw new Error(`API reference template ${templatePath} does not reference __SCALAR_BUNDLE__`);
  }
  const html = template.replaceAll('__SCALAR_BUNDLE__', scalarFile);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), html);
  await writeFile(join(outDir, scalarFile), scalarBytes);
  await cp(specPath, join(outDir, 'swagger.json'));
  await cp(faviconPath, join(outDir, 'favicon.svg'));

  return { outDir, scalarFile };
}

export async function buildDocs({
  repoRoot = root,
  docsDir = join(repoRoot, 'deploy', 'site', 'docs'),
  execute = execFileSync,
} = {}) {
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  const resolvedDocsDir = resolve(repoRoot, docsDir);
  if (process.platform === 'win32') {
    execute('cmd.exe', ['/d', '/s', '/c', 'pnpm run build'], { cwd: resolvedDocsDir, stdio: 'inherit', env });
  } else {
    execute('pnpm', ['run', 'build'], { cwd: resolvedDocsDir, stdio: 'inherit', env });
  }
  return { outDir: join(resolvedDocsDir, 'out') };
}

const LANDING_RENDERER = 'render.mjs';
const LANDING_SOURCES = new Set([LANDING_RENDERER, 'copy.mjs']);
const HREFLANG = { en: 'en', zh: 'zh-CN' };
const STABLE_VERSION_RE = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

function parseLatestRedirectLocation(location, repo) {
  if (typeof location !== 'string' || !location.trim()) return null;
  let parsed;
  try {
    parsed = new URL(location, 'https://github.com');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://github.com') return null;
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathMatch = parsed.pathname.match(new RegExp(`^/${escapedRepo}/releases/tag/([^/]+)/?$`, 'i'));
  if (!pathMatch) return null;
  try {
    const tagMatch = decodeURIComponent(pathMatch[1]).trim().match(STABLE_VERSION_RE);
    return tagMatch ? tagMatch[1] : null;
  } catch {
    return null;
  }
}

export async function fetchLatestReleaseVersion({
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
  repo = GITHUB_REPO,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const requestInit = {
    method: 'HEAD',
    redirect: 'manual',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'oh-my-cpa-site-builder',
    },
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {}),
  };
  try {
    let response = await fetchImpl(`https://github.com/${repo}/releases/latest`, requestInit);
    if (response.status === 405) {
      void response.body?.cancel?.().catch?.(() => {});
      response = await fetchImpl(`https://github.com/${repo}/releases/latest`, {
        ...requestInit,
        method: 'GET',
      });
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel?.().catch?.(() => {});
      return parseLatestRedirectLocation(response.headers.get('location'), repo);
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch?.(() => {});
      return null;
    }
    const payload = await response.json();
    const match = typeof payload?.tag_name === 'string' ? payload.tag_name.trim().match(STABLE_VERSION_RE) : null;
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function resolveSiteVersion({
  repoRoot = root,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
} = {}) {
  const { version: fallback } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const latest = await fetchLatestReleaseVersion({ fetchImpl, timeoutMs });
  return latest ?? fallback;
}

/** Writes the rendered landing documents and returns their public paths and languages. */
async function renderLanding({ landingDir, outDir, version }) {
  const { LANDING_PAGES, renderLanding: render } = await import(pathToFileURL(join(landingDir, LANDING_RENDERER)).href);
  for (const page of LANDING_PAGES) {
    const target = join(outDir, page.file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, render(page.lang, { version }));
  }
  return LANDING_PAGES.map((page) => ({ lang: page.lang, path: page.path }));
}

function sitemapEntry(loc, alternates) {
  const links = alternates
    .map(({ hreflang, href }) => `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${href}"/>`)
    .join('\n');
  return `  <url>\n    <loc>${loc}</loc>\n${links}\n  </url>`;
}

/** Lists every indexable page with its language alternates, landing first. */
export function buildSitemap({ landingPages = [], includeDocs = true } = {}) {
  const entries = [];
  if (landingPages.length) {
    const alternates = landingPages.map((page) => ({ hreflang: HREFLANG[page.lang] ?? page.lang, href: `${SITE_ORIGIN}${page.path}` }));
    alternates.push({ hreflang: 'x-default', href: `${SITE_ORIGIN}/` });
    for (const page of landingPages) entries.push(sitemapEntry(`${SITE_ORIGIN}${page.path}`, alternates));
  }
  if (includeDocs) {
    for (const slug of ['', ...listDocsPages().map((page) => page.slug)]) {
      const alternates = DOCS_LANGUAGES.map((lang) => ({ hreflang: HREFLANG[lang], href: `${SITE_ORIGIN}/docs${docsUrl(lang, slug)}` }));
      alternates.push({ hreflang: 'x-default', href: `${SITE_ORIGIN}/docs${docsUrl('en', slug)}` });
      for (const lang of DOCS_LANGUAGES) entries.push(sitemapEntry(`${SITE_ORIGIN}/docs${docsUrl(lang, slug)}`, alternates));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

export async function stageSite({
  repoRoot = root,
  outDir = DEFAULT_SITE_OUTPUT,
  landingDir = join(repoRoot, 'deploy', 'site', 'landing'),
  headersPath = join(repoRoot, 'deploy', 'site', '_headers'),
  faviconPath = join(repoRoot, 'web', 'public', 'favicon.svg'),
  specPath = join(repoRoot, 'docs', 'openapi', 'swagger.json'),
  templatePath = join(repoRoot, 'deploy', 'site', 'api-reference', 'index.html'),
  scalarPath = resolveScalarStandalone(repoRoot),
  includeDocs = true,
  docsSourceDir = join(repoRoot, 'deploy', 'site', 'docs', 'out'),
  includeDemo = true,
  consoleSourceDir = join(repoRoot, 'internal', 'web', 'dist'),
  demoBasePath = '/demo',
  socialCardsDir = join(repoRoot, 'deploy', 'site', 'og'),
  readmeImagesDir = join(repoRoot, 'docs', 'images', 'readme'),
  releaseVersion,
  resolveLatestRelease = false,
} = {}) {
  if (!existsSync(landingDir)) {
    throw new Error(`missing landing directory at ${landingDir}`);
  }
  if (existsSync(join(landingDir, 'api-reference'))) {
    throw new Error(`landing directory ${landingDir} must not contain api-reference/ (owned by /api-reference module)`);
  }
  if (includeDocs && existsSync(join(landingDir, 'docs'))) {
    throw new Error(`landing directory ${landingDir} must not contain docs/ (owned by /docs module)`);
  }
  if (includeDemo && existsSync(join(landingDir, 'demo'))) {
    throw new Error(`landing directory ${landingDir} must not contain demo/ (owned by /demo module)`);
  }
  if (includeDocs && !existsSync(join(docsSourceDir, 'index.html'))) {
    throw new Error(`missing built Fumadocs site at ${docsSourceDir}; run pnpm build:docs first`);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const isRendered = existsSync(join(landingDir, LANDING_RENDERER));
  await cp(landingDir, outDir, {
    recursive: true,
    filter: (source) => !isRendered || !LANDING_SOURCES.has(relative(landingDir, source)),
  });
  let landingPages = [];
  if (isRendered) {
    const version =
      releaseVersion ??
      (resolveLatestRelease
        ? await resolveSiteVersion({ repoRoot })
        : JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version);
    landingPages = await renderLanding({ landingDir, outDir, version });
    await mkdir(join(outDir, 'images'), { recursive: true });
    for (const name of await readdir(readmeImagesDir)) {
      if (name.startsWith('hero-split.') && name.endsWith('.webp')) {
        await cp(join(readmeImagesDir, name), join(outDir, 'images', name));
      }
    }
    const landingFont = join(repoRoot, 'web', 'src', 'assets', 'fonts', 'sarasa', 'sarasa-mono-sc-400-000.woff2');
    if (existsSync(landingFont)) {
      await mkdir(join(outDir, 'fonts'), { recursive: true });
      await cp(landingFont, join(outDir, 'fonts', 'sarasa-mono-sc-400.woff2'));
    }
  }
  if (existsSync(socialCardsDir)) {
    await cp(socialCardsDir, join(outDir, 'og'), { recursive: true });
  }

  if (!existsSync(join(outDir, 'favicon.svg')) && existsSync(faviconPath)) {
    await cp(faviconPath, join(outDir, 'favicon.svg'));
  }
  const wordmarkLight = join(repoRoot, 'web', 'src', 'assets', 'brand', 'omc-wordmark-light.svg');
  const wordmarkDark = join(repoRoot, 'web', 'src', 'assets', 'brand', 'omc-wordmark-dark.svg');
  if (!existsSync(join(outDir, 'wordmark-light.svg')) && existsSync(wordmarkLight)) {
    await cp(wordmarkLight, join(outDir, 'wordmark-light.svg'));
  }
  if (!existsSync(join(outDir, 'wordmark-dark.svg')) && existsSync(wordmarkDark)) {
    await cp(wordmarkDark, join(outDir, 'wordmark-dark.svg'));
  }
  if (existsSync(headersPath)) {
    await cp(headersPath, join(outDir, '_headers'));
  }

  const apiRefResult = await stageApiReference({
    repoRoot,
    outDir: join(outDir, 'api-reference'),
    specPath,
    templatePath,
    faviconPath,
    scalarPath,
  });

  if (includeDocs) {
    await cp(docsSourceDir, join(outDir, 'docs'), { recursive: true });
  }

  await writeFile(join(outDir, 'sitemap.xml'), buildSitemap({ landingPages, includeDocs }));
  if (!existsSync(join(outDir, 'robots.txt'))) {
    await writeFile(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /demo/\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
  }

  if (includeDemo) {
    await stageDemo({
      sourceDirectory: consoleSourceDir,
      stageDirectory: join(outDir, 'demo'),
      basePath: demoBasePath,
      includeHeaders: false,
    });
  }

  return {
    outDir,
    scalarFile: apiRefResult.scalarFile,
    hasDocs: includeDocs,
    hasDemo: includeDemo,
  };
}

function parseArgs(argv) {
  let apiReferenceOnly = false;
  let skipDocs = false;
  let skipDemo = false;
  let fromBuiltDocs = false;
  let outDir;
  let landingDir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--api-reference-only') {
      apiReferenceOnly = true;
    } else if (arg === '--skip-docs') {
      skipDocs = true;
    } else if (arg === '--skip-demo') {
      skipDemo = true;
    } else if (arg === '--from-built-docs') {
      fromBuiltDocs = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a directory path');
      outDir = resolve(process.cwd(), value);
      i += 1;
    } else if (arg === '--landing-dir') {
      const value = argv[i + 1];
      if (!value) throw new Error('--landing-dir requires a directory path');
      landingDir = resolve(process.cwd(), value);
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return { apiReferenceOnly, skipDocs, skipDemo, fromBuiltDocs, outDir, landingDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { apiReferenceOnly, skipDocs, skipDemo, fromBuiltDocs, outDir, landingDir } = parseArgs(process.argv.slice(2));
    if (apiReferenceOnly) {
      const result = await stageApiReference({ outDir: outDir ?? DEFAULT_API_REFERENCE_OUTPUT });
      console.log(`staged standalone API reference (${result.scalarFile}) at ${result.outDir}`);
    } else {
      if (!skipDocs && !fromBuiltDocs) {
        await buildDocs({ repoRoot: root });
      }
      if (!skipDemo) {
        await ensureDemoDataset(root);
      }
      const result = await stageSite({
        ...(outDir ? { outDir } : {}),
        ...(landingDir ? { landingDir } : {}),
        includeDocs: !skipDocs,
        includeDemo: !skipDemo,
        resolveLatestRelease: true,
      });
      const modules = [
        result.scalarFile,
        ...(result.hasDocs ? ['/docs'] : []),
        ...(result.hasDemo ? ['/demo'] : []),
      ];
      console.log(`staged public site (${modules.join(', ')}) at ${result.outDir}`);
    }
  } catch (error) {
    console.error(`build-site: ${error.message}`);
    process.exitCode = 1;
  }
}
