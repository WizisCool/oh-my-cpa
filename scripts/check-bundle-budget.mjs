import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'web', 'dist');
const assetsDir = path.join(distDir, 'assets');
const iconDir = path.join(distDir, 'lobe-icons');

if (!fs.existsSync(assetsDir)) {
  console.error('web/dist/assets does not exist; run pnpm build first');
  process.exit(1);
}

const entries = fs.readdirSync(assetsDir).map((name) => ({
  name,
  bytes: fs.statSync(path.join(assetsDir, name)).size,
}));

function sizeOf(predicate) {
  return entries.filter((entry) => predicate(entry.name)).reduce((sum, entry) => sum + entry.bytes, 0);
}

function totalDirectorySize(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    total += entry.isDirectory() ? totalDirectorySize(absolute) : fs.statSync(absolute).size;
  }
  return total;
}

const totalJSBytes = sizeOf((name) => name.endsWith('.js'));
const iconBytes = totalDirectorySize(iconDir);
const totalDistBytes = totalDirectorySize(distDir);

const budgets = [
  { label: 'main entry', pattern: /^index-.*\.js$/, maxKB: 180, required: true },
  { label: 'Lobe icon JS', pattern: /^LobeIcon-.*\.js$/, maxKB: 96, required: true },
  { label: 'vendor antd', pattern: /^vendor-antd-.*\.js$/, maxKB: 1250, required: true },
  { label: 'vendor charts', pattern: /^vendor-charts-.*\.js$/, maxKB: 1600, required: true },
  { label: 'YAML source editor', pattern: /^YamlSourceEditor-.*\.js$/, maxKB: 3200, required: true },
];

let failed = false;
for (const budget of budgets) {
  const matched = entries.filter((entry) => budget.pattern.test(entry.name));
  const bytes = matched.reduce((sum, entry) => sum + entry.bytes, 0);
  const sizeKB = bytes / 1024;
  if (matched.length === 0 && budget.required) {
    console.error(`FAIL: ${budget.label} chunk was not emitted`);
    failed = true;
    continue;
  }
  const status = sizeKB <= budget.maxKB ? 'PASS' : 'FAIL';
  console.log(`${status}: ${budget.label} ${sizeKB.toFixed(2)} kB <= ${budget.maxKB} kB`);
  if (status === 'FAIL') failed = true;
}

const aggregateBudgets = [
  { label: 'total JavaScript', bytes: totalJSBytes, maxKB: 7800 },
  { label: 'generated Lobe SVG assets', bytes: iconBytes, maxKB: 1200 },
  { label: 'total web/dist', bytes: totalDistBytes, maxKB: 9300 },
];
for (const budget of aggregateBudgets) {
  const sizeKB = budget.bytes / 1024;
  const passed = sizeKB <= budget.maxKB;
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${budget.label} ${sizeKB.toFixed(2)} kB <= ${budget.maxKB} kB`);
  if (!passed) failed = true;
}

if (failed) process.exit(1);
