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
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
 *
 * Only HTML is rewritten. The JavaScript and CSS are left exactly as the product
 * builds them, because anything that edited them would make this a second frontend -
 * and the demonstration's value is that it is the same one.
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

async function main() {
  if (!existsSync(SOURCE)) {
    throw new Error(`no built console at ${SOURCE}; run pnpm build first`);
  }

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await cp(SOURCE, STAGE, { recursive: true });

  const index = join(STAGE, 'index.html');
  const original = await readFile(index, 'utf8');
  await writeFile(index, rewriteHtml(original));

  console.log(`staged the demonstration console at ${STAGE}`);
}

try {
  await main();
} catch (error) {
  console.error(`build-demo: ${error.message}`);
  process.exitCode = 1;
}
