import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

await withRetry('remove old dist', () => rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }));
await withRetry('create dist dir', () => mkdir(target, { recursive: true }));
await withRetry('copy dist', () => cp(source, target, { recursive: true }));
console.log(`synced ${source} -> ${target}`);
