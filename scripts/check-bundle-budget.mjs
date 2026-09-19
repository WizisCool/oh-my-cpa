import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bundle budgets, re-baselined for the phone adaptation (2026-09-19).
 *
 * Measured against the base commit and this one, in kB:
 *
 * | Budget | base | now |
 * | --- | --- | --- |
 * | main entry | 180.45 | 181.95 |
 * | total JavaScript | 7865.47 | 7872.82 |
 * | total web/dist | 9344.82 | 9354.94 |
 *
 * The entries not listed did not move at all. The cost is the adaptation itself - two viewport hooks,
 * the overlay/history pair, the shared phone row with the column derivation behind it, and the wiring
 * for seven list surfaces - which is 7.35 kB of JavaScript for a change to how every list renders.
 *
 * **What was re-baselined is the margin, not this change.** Total JavaScript had 9.53 kB of headroom
 * *before* this work (7865.47 of 7875), and the re-baseline recorded at the end of this comment left it
 * 22.14 kB. The commits in between spent that on ordinary drift, which is the failure this file's own
 * principle predicts: a margin that is a fraction of a percent cannot absorb one modest feature, so it
 * stops being a gate and becomes a number the next person raises. A gate nobody can satisfy without
 * editing the gate is not measuring anything.
 *
 * The limits below restore a margin a feature can use, rather than matching what was last produced:
 *
 *   - `main entry` 186 -> 190. The first paint is the one budget that should stay tight, so it grows
 *     least: 4.4% of headroom, against 3.4% before.
 *   - `total JavaScript` 7875 -> 8000, +1.6%. About one mid-sized chunk - enough that an ordinary
 *     feature lands without a debate, and small enough that what this budget exists to catch, a whole
 *     library pulled into a chunk, still fails it.
 *   - `total web/dist` 9375 -> 9600. 1600 kB for everything that is not JavaScript, against 1482 kB
 *     present, so the stylesheets, fonts and icons carry their own margin rather than sharing the
 *     JavaScript one.
 *
 * The per-chunk budgets below are deliberately untouched: none of them is near its limit, and raising a
 * limit that is not binding removes a check rather than relaxing one.
 *
 * ## The theme-modes re-baseline (2026-09-18), kept for the record
 *
 * | Budget | before | after |
 * | --- | --- | --- |
 * | main entry | 174.32 | 179.94 |
 * | vendor antd | 1097.99 | 1159.17 |
 * | total JavaScript | 7777.71 | 7852.86 |
 * | total web/dist | 9255.46 | 9332.11 |
 *
 * The cost was two deliberate additions: Ant Design's colour picker, which the palette editor needs and
 * which lands in the `vendor-antd` chunk (+61 kB), and the palette derivation itself, which runs at
 * startup to paint the resolved palette and so sits in the entry (+5.6 kB). The entry's first version of
 * that change had the settings page imported eagerly, which put the colour picker in the first paint at
 * 185.55 kB; the page is lazy now, like every other route.
 */

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
  { label: 'main entry', pattern: /^index-.*\.js$/, maxKB: 190, required: true },
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
  { label: 'total JavaScript', bytes: totalJSBytes, maxKB: 8000 },
  { label: 'generated Lobe SVG assets', bytes: iconBytes, maxKB: 1200 },
  { label: 'total web/dist', bytes: totalDistBytes, maxKB: 9600 },
];
for (const budget of aggregateBudgets) {
  const sizeKB = budget.bytes / 1024;
  const passed = sizeKB <= budget.maxKB;
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${budget.label} ${sizeKB.toFixed(2)} kB <= ${budget.maxKB} kB`);
  if (!passed) failed = true;
}

if (failed) process.exit(1);
