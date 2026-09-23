#!/usr/bin/env node
/**
 * Stages the built console for the Cloudflare demonstration.
 *
 * Three things have to happen to a self-hosted build before a static host can serve it
 * as a demonstration, and each is here because leaving it to the host would be wrong:
 *
 * 1. **The runtime configuration is injected.** The console learns it is a
 *    demonstration from `window.__OMCPA_CONFIG__`, which the Go server writes into the
 *    page. There is no Go server here, so the build writes it - with the root base
 *    path, because the demonstration is served from the site root rather than under
 *    `/omc`.
 *
 * 2. **Asset URLs are made root-relative.** Vite emits `./assets/...` so the bundle
 *    works from any sub-path, which is right for a self-hosted install that may sit
 *    under `/omc` but wrong here: a visitor who reloads `/usage/events` would resolve
 *    `./assets/...` against that path and get the SPA fallback instead of the chunk.
 *
 * 3. **The build is copied rather than built.** The demonstration serves the same
 *    console as the product - that is the point of it - so this reads the existing
 *    `internal/web/dist` instead of running its own build, and `--from-built` lets a
 *    verification pass reuse one production build instead of racing it.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The built console the product embeds, and the staging area the Worker serves. */
const SOURCE = join(root, 'internal', 'web', 'dist');
const STAGE = join(root, 'tmp', 'cloudflare-demo', 'assets');

/**
 * The runtime configuration the demonstration's page carries.
 *
 * `demo: true` is the flag the console reads to render its own notices and to explain
 * a refused write before the request is made. `basePath` is empty because the
 * demonstration is the whole site, and `apiBaseUrl` is absolute for the same reason.
 */
const RUNTIME_CONFIG = {
  basePath: '',
  apiBaseUrl: '/api/v1',
  mediaBaseUrl: '/media',
  appName: 'Oh My CPA',
  demo: true,
};

/** The marker the Go server writes, which this replaces. */
const CONFIG_MARKER = '__OMCPA_CONFIG__';

/**
 * Rewrites a built HTML file for a static host.
 */
function rewriteHtml(html) {
  let output = html;

  // The asset references Vite emits are relative to the document, which breaks on a
  // deep link once the document is served from the site root. They are made absolute
  // here so a reload of any console route loads the app rather than the fallback.
  output = output.replaceAll('href="./', 'href="/');
  output = output.replaceAll('src="./', 'src="/');

  const script = `<script>window.${CONFIG_MARKER} = ${JSON.stringify(RUNTIME_CONFIG)};</script>`;
  if (!output.includes(CONFIG_MARKER)) {
    throw new Error('the built index.html has no runtime configuration to replace');
  }
  // The whole conditional block the product ships is replaced rather than appended to:
  // two assignments would leave the order of `demo` undefined, and the console reads it
  // in the first frame.
  output = output.replace(/<script>[\s\S]*?__OMCPA_CONFIG__[\s\S]*?<\/script>/, script);

  if (!output.includes('"demo":true') && !output.includes('"demo": true')) {
    throw new Error('the injected runtime configuration does not mark the page as a demonstration');
  }
  return output;
}

/**
 * The relative references Vite bakes into the built modules and stylesheets.
 *
 * They are relative for the same reason the HTML's are - a self-hosted install may sit
 * under `/omc`, so `./` resolves correctly there - and they break in exactly the same way
 * on a deep link served from the site root. The demonstration therefore has to rewrite
 * them too, and this was learned the hard way: rewriting only the HTML left the provider
 * icons broken in the request list, because the icon path is a template literal inside a
 * JavaScript chunk (`./lobe-icons/${name}-color.svg`), which resolves against the current
 * route. The console's own theme fonts are referenced the same way from its CSS.
 *
 * The rewrite is a literal replacement of the leading `./` rather than a parser pass,
 * because what it is fixing is a path convention rather than a syntax: every occurrence
 * in the built output refers to something served from the site root, and there is no
 * construct in these files where `./` means a directory the browser is already in.
 */
const RELATIVE_REFERENCES = [
  { pattern: /\.\/lobe-icons\//g, replacement: '/lobe-icons/' },
  { pattern: /\.\/([A-Za-z0-9_-]+\.woff2)/g, replacement: '/assets/$1' },
];

/** Rewrites the leading `./` in a built module or stylesheet. */
function rewriteModuleReferences(source) {
  let output = source;
  for (const { pattern, replacement } of RELATIVE_REFERENCES) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Applies the module rewrite to every staged JavaScript and CSS file.
 *
 * The walk is over the staged directory rather than a list of file names, because the
 * names are content-hashed: a list would go stale on the next build and would fail by
 * silently skipping the file it named.
 */
async function rewriteStagedModules(stage) {
  const assets = join(stage, 'assets');
  let rewritten = 0;
  for (const name of await readdir(assets)) {
    if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
    const path = join(assets, name);
    const source = await readFile(path, 'utf8');
    const output = rewriteModuleReferences(source);
    if (output === source) continue;
    await writeFile(path, output);
    rewritten += 1;
  }
  return rewritten;
}

async function main() {
  if (!existsSync(SOURCE)) {
    throw new Error(`no built console at ${SOURCE}; run pnpm build first`);
  }

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await cp(SOURCE, STAGE, { recursive: true });

  // The header rules live beside this deployment's config rather than in the built
  // console, because they describe how this host should serve the console rather than
  // anything about the console itself.
  await cp(join(root, 'deploy', 'cloudflare', '_headers'), join(STAGE, '_headers'));

  const index = join(STAGE, 'index.html');
  const original = await readFile(index, 'utf8');
  await writeFile(index, rewriteHtml(original));

  const rewritten = await rewriteStagedModules(STAGE);
  if (rewritten === 0) {
    // A build with no relative references would mean this rewrite is dead code, which is
    // worth knowing rather than assuming: it would mean the convention changed upstream.
    throw new Error('no staged module referenced an asset relatively; is this rewrite still needed?');
  }

  console.log(`staged the demonstration console at ${STAGE} (${rewritten} module(s) rewritten)`);
}

try {
  await main();
} catch (error) {
  console.error(`build-demo: ${error.message}`);
  process.exitCode = 1;
}
