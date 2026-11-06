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
 * 2. **Relative URLs resolve against the site root.** Vite emits `./` references so the
 *    bundle works under any sub-path, and the console builds more of them at runtime (the
 *    provider marks are `${BASE_URL}lobe-icons/...`). The Go server makes them all resolve
 *    by writing `<base href>` into the page; without it a visitor on `/usage/events` would
 *    resolve them against that route and get the SPA fallback instead of the file. The
 *    build writes the same tag rather than rewriting the paths it can find in the bundle:
 *    a URL assembled at runtime has no literal to find, which is how the provider icons
 *    once went missing from the request list.
 *
 * 3. **The build is copied rather than built.** The demonstration serves the same
 *    console as the product - that is the point of it - so this reads the existing
 *    `internal/web/dist` instead of running its own build, and `--from-built` lets a
 *    verification pass reuse one production build instead of racing it.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
  // The demonstration's own build version, so a page that names the running build does not
  // fall back to the source default and claim to be a release it is not.
  version: 'v0.1.0-demo',
};

/** The marker the Go server writes, which this replaces. */
const CONFIG_MARKER = '__OMCPA_CONFIG__';

/**
 * Rewrites a built HTML file for a static host.
 */
export function rewriteHtml(html) {
  let output = html;

  // The same tag the Go server writes for a root base path (`internal/api/handler.go`).
  if (output.includes('<base ')) throw new Error('the built index.html already carries a <base> tag');
  output = output.replace('<head>', '<head>\n    <base href="/">');

  const script = `<script>window.${CONFIG_MARKER} = ${JSON.stringify(RUNTIME_CONFIG)};</script>`;
  if (!output.includes(CONFIG_MARKER)) {
    throw new Error('the built index.html has no runtime configuration to replace');
  }
  // The whole conditional block the product ships is replaced rather than appended to:
  // two assignments would leave the order of `demo` undefined, and the console reads it
  // in the first frame.
  output = output.replace(/<script>[\s\S]*?__OMCPA_CONFIG__[\s\S]*?<\/script>/, script);

  if (!output.includes('<base href="/">')) {
    throw new Error('the built index.html has no <head> to carry the base URL');
  }
  if (!output.includes('"demo":true') && !output.includes('"demo": true')) {
    throw new Error('the injected runtime configuration does not mark the page as a demonstration');
  }
  return output;
}

export async function stageDemo({ sourceDirectory = SOURCE, stageDirectory = STAGE } = {}) {
  // The directory exists in every checkout, held by its tracked `.gitkeep`; only an
  // entry document says a build is there.
  if (!existsSync(join(sourceDirectory, 'index.html'))) {
    throw new Error(`no built console at ${sourceDirectory}; run pnpm build first`);
  }

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });
  await cp(sourceDirectory, stageDirectory, { recursive: true, filter: (source) => basename(source) !== '.gitkeep' });

  // The header rules live beside this deployment's config rather than in the built
  // console, because they describe how this host should serve the console rather than
  // anything about the console itself.
  await cp(join(root, 'deploy', 'cloudflare', '_headers'), join(stageDirectory, '_headers'));

  const index = join(stageDirectory, 'index.html');
  const original = await readFile(index, 'utf8');
  await writeFile(index, rewriteHtml(original));

  return { stageDirectory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { stageDirectory } = await stageDemo();
    console.log(`staged the demonstration console at ${stageDirectory}`);
  } catch (error) {
    console.error(`build-demo: ${error.message}`);
    process.exitCode = 1;
  }
}
