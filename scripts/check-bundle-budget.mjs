import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'web', 'dist', 'assets');

if (!fs.existsSync(distDir)) {
  console.error('web/dist/assets does not exist; run pnpm build first');
  process.exit(1);
}

const files = fs.readdirSync(distDir);
const mainEntry = files.find((f) => f.startsWith('index-') && f.endsWith('.js'));
if (!mainEntry) {
  console.error('Main entry chunk not found in web/dist/assets');
  process.exit(1);
}

const mainEntrySize = fs.statSync(path.join(distDir, mainEntry)).size;
const sizeKB = mainEntrySize / 1024;
console.log(`Main entry chunk ${mainEntry}: ${sizeKB.toFixed(2)} kB`);

// Budget: main entry chunk must not exceed 250 kB (baseline after splitting was ~95 kB)
const MAX_ENTRY_KB = 250;
if (sizeKB > MAX_ENTRY_KB) {
  console.error(`FAIL: Main entry chunk exceeds budget: ${sizeKB.toFixed(2)} kB > ${MAX_ENTRY_KB} kB`);
  process.exit(1);
}

console.log(`PASS: Main entry chunk is within ${MAX_ENTRY_KB} kB budget (${sizeKB.toFixed(2)} kB)`);
