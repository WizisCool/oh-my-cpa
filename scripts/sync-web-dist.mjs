import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'web', 'dist');
const target = resolve(root, 'internal', 'web', 'dist');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows can transiently lock freshly-built files (AV/indexer), so retry
// the delete/copy steps a few times before giving up.
async function withRetry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (i >= attempts) throw new Error(`${label} failed after ${attempts} attempts: ${err.message}`);
      await sleep(150 * i);
    }
  }
}

/** Every file under `dir`, as paths relative to it. */
async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, base)));
    else files.push(relative(base, absolute));
  }
  return files;
}

/**
 * The embedded distribution is synced in place rather than replaced.
 *
 * `pnpm build` and the Go gates run concurrently in `verify:full`, and the Go
 * package embeds this directory: deleting it and copying a fresh one in leaves a
 * window in which a concurrent compile sees a missing, half-written or
 * half-deleted bundle. That is a latent failure — it depends on whether the
 * compile happens to read the directory during the window — and the fix is to
 * remove the window rather than to serialise two independent gates.
 *
 * So files are overwritten in place and only then pruned. Every intermediate state
 * a concurrent reader can observe is consistent with *some* complete build:
 *
 *   - Vite emits content-hashed asset names, so an overwrite only ever adds files
 *     that the incoming `index.html` already references; the previous build's
 *     assets are still on disk while it happens.
 *   - `index.html` is written last, so a reader never sees an entry document
 *     pointing at an asset that has not landed yet.
 *   - Pruning removes only files the new build does not have, and it runs after
 *     `index.html` already points at the new set.
 *
 * The cost is that a file the new build no longer emits survives until the prune,
 * which is why the prune is not optional: without it the embedded binary would keep
 * growing with every retired asset hash.
 */
/**
 * Prunes everything under `dir` that is not in `keep`, where `keep` holds paths
 * relative to the target root.
 *
 * It recurses rather than only cleaning the top level because that is where retired
 * assets actually live: Vite emits content-hashed names *inside* `assets/`, so a
 * top-level-only prune would keep every hash ever built and the embedded binary
 * would grow without bound.
 */
async function pruneStale(dir, keep, base) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const relativePath = relative(base, absolute).split('\\').join('/');
    if (entry.isDirectory()) {
      // A directory is kept when some incoming file lives under it, and removed
      // wholesale once nothing does.
      const isUsed = [...keep].some((kept) => kept.startsWith(`${relativePath}/`));
      if (isUsed) {
        await pruneStale(absolute, keep, base);
        continue;
      }
      await withRetry(`remove stale ${relativePath}`, () =>
        rm(absolute, { recursive: true, force: true }),
      );
      continue;
    }
    if (keep.has(relativePath)) continue;
    await withRetry(`remove stale ${relativePath}`, () => rm(absolute, { force: true }));
  }
}

await withRetry('create dist dir', () => mkdir(target, { recursive: true }));

// Assets first, then the entry document. `cp` on a directory walks in an
// unspecified order, so the entry document is copied on its own afterwards.
const sourceFiles = (await listFiles(source)).map((file) => file.split('\\').join('/'));
const assetsSource = join(source, 'assets');
const hasAssets = await stat(assetsSource).then(() => true).catch(() => false);
if (hasAssets) {
  await withRetry('copy dist assets', () => cp(assetsSource, join(target, 'assets'), { recursive: true }));
}
for (const file of sourceFiles) {
  if (file === 'index.html' || file.startsWith('assets/')) continue;
  await withRetry(`copy ${file}`, () => cp(join(source, file), join(target, file), { recursive: false }));
}

// The entry document last: it is what names the assets, so nothing may reference
// a file that is not on disk yet.
await withRetry('copy index.html', () => cp(join(source, 'index.html'), join(target, 'index.html')));

// Prune what the new build does not have: retired asset hashes, and directories
// that no longer carry anything the entry document references.
await pruneStale(target, new Set(['index.html', ...sourceFiles]), target);

console.log(`synced ${source} -> ${target}`);
