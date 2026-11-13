#!/usr/bin/env node
/**
 * Assembles the static public site, `/demo` console assets, and/or standalone `/api-docs` bundle.
 *
 * Host-agnostic by design:
 * - `pnpm build:api-docs` (`--docs-only`) emits a self-contained static directory
 *   (`index.html`, `scalar.<hash>.js`, `swagger.json`, `favicon.svg`) that can be copied
 *   directly into any future landing-site framework (`public/api-docs/`), Nginx/Caddy,
 *   GitHub Pages, or Cloudflare Workers Assets.
 * - `pnpm build:site` composes the replaceable landing root (`deploy/site/landing/` or
 *   `--landing-dir <dir>`), `/api-docs/`, `/demo/` (from the built SPA via `stageDemo`),
 *   and `_headers` into `tmp/site/dist/`.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDemo } from './build-demo.mjs';
import { ensureDemoDataset } from './generate-demo-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export const DEFAULT_SITE_OUTPUT = join(root, 'tmp', 'site', 'dist');
export const DEFAULT_DOCS_OUTPUT = join(root, 'tmp', 'api-docs');

function resolveScalarStandalone(repoRoot) {
  const direct = join(repoRoot, 'node_modules', '@scalar', 'api-reference', 'dist', 'browser', 'standalone.js');
  if (existsSync(direct)) return direct;
  const entry = require.resolve('@scalar/api-reference');
  return join(dirname(entry), 'browser', 'standalone.js');
}

export async function stageApiDocs({
  repoRoot = root,
  outDir = DEFAULT_DOCS_OUTPUT,
  specPath = join(repoRoot, 'docs', 'openapi', 'swagger.json'),
  templatePath = join(repoRoot, 'deploy', 'site', 'api-docs', 'index.html'),
  faviconPath = join(repoRoot, 'web', 'public', 'favicon.svg'),
  scalarPath = resolveScalarStandalone(repoRoot),
} = {}) {
  for (const [label, file] of [
    ['OpenAPI spec', specPath],
    ['API docs HTML template', templatePath],
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
    throw new Error(`API docs template ${templatePath} does not reference __SCALAR_BUNDLE__`);
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

export async function stageSite({
  repoRoot = root,
  outDir = DEFAULT_SITE_OUTPUT,
  landingDir = join(repoRoot, 'deploy', 'site', 'landing'),
  headersPath = join(repoRoot, 'deploy', 'site', '_headers'),
  faviconPath = join(repoRoot, 'web', 'public', 'favicon.svg'),
  specPath = join(repoRoot, 'docs', 'openapi', 'swagger.json'),
  templatePath = join(repoRoot, 'deploy', 'site', 'api-docs', 'index.html'),
  scalarPath = resolveScalarStandalone(repoRoot),
  includeDemo = true,
  consoleSourceDir = join(repoRoot, 'internal', 'web', 'dist'),
  demoBasePath = '/demo',
} = {}) {
  if (!existsSync(landingDir)) {
    throw new Error(`missing landing directory at ${landingDir}`);
  }
  if (existsSync(join(landingDir, 'api-docs'))) {
    throw new Error(`landing directory ${landingDir} must not contain api-docs/ (owned by /api-docs module)`);
  }
  if (includeDemo && existsSync(join(landingDir, 'demo'))) {
    throw new Error(`landing directory ${landingDir} must not contain demo/ (owned by /demo module)`);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(landingDir, outDir, { recursive: true });

  if (!existsSync(join(outDir, 'favicon.svg')) && existsSync(faviconPath)) {
    await cp(faviconPath, join(outDir, 'favicon.svg'));
  }
  if (existsSync(headersPath)) {
    await cp(headersPath, join(outDir, '_headers'));
  }

  const docsResult = await stageApiDocs({
    repoRoot,
    outDir: join(outDir, 'api-docs'),
    specPath,
    templatePath,
    faviconPath,
    scalarPath,
  });

  if (includeDemo) {
    await stageDemo({
      sourceDirectory: consoleSourceDir,
      stageDirectory: join(outDir, 'demo'),
      basePath: demoBasePath,
      includeHeaders: false,
    });
  }

  return { outDir, scalarFile: docsResult.scalarFile, hasDemo: includeDemo };
}

function parseArgs(argv) {
  let docsOnly = false;
  let skipDemo = false;
  let outDir;
  let landingDir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--docs-only') {
      docsOnly = true;
    } else if (arg === '--skip-demo') {
      skipDemo = true;
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
  return { docsOnly, skipDemo, outDir, landingDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { docsOnly, skipDemo, outDir, landingDir } = parseArgs(process.argv.slice(2));
    if (docsOnly) {
      const result = await stageApiDocs({ outDir: outDir ?? DEFAULT_DOCS_OUTPUT });
      console.log(`staged standalone API docs (${result.scalarFile}) at ${result.outDir}`);
    } else {
      if (!skipDemo) {
        await ensureDemoDataset(root);
      }
      const result = await stageSite({
        ...(outDir ? { outDir } : {}),
        ...(landingDir ? { landingDir } : {}),
        includeDemo: !skipDemo,
      });
      console.log(`staged public site (${result.scalarFile}${result.hasDemo ? ', /demo' : ''}) at ${result.outDir}`);
    }
  } catch (error) {
    console.error(`build-site: ${error.message}`);
    process.exitCode = 1;
  }
}
