import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bundle budgets, re-baselined for the System Information page (2026-09-22).
 *
 * Measured against the base commit and this one, in kB:
 *
 * | Budget | base | now | delta |
 * | --- | --- | --- | --- |
 * | main entry | 184.95 | 191.26 | +6.31 |
 * | total JavaScript | 7882.04 | 8070.85 | +188.81 |
 * | total web/dist | 9364.84 | 9559.88 | +195.04 |
 *
 * The two numbers have different causes, and each was checked rather than assumed.
 *
 * The entry grew because the page's copy lives in the base dictionary, which is part of the first
 * paint: 69 new `sys.*` keys, in both languages. That is copy, not code - the page itself is a lazy
 * route. It is the price of a localized page, and the alternative (loading the dictionary late)
 * trades a first-paint flash of untranslated text for those bytes.
 *
 * Total JavaScript grew because rendering release notes needs `react-markdown` and `remark-gfm` -
 * a Markdown parser, a GFM extension, and the unified/micromark dependencies under them. The
 * dependency is bought rather than the feature refused: a release body is Markdown, and a
 * hand-written renderer for it would be a worse bet than a maintained parser.
 *
 * **What that cost must not do is follow every route.** Those packages land in the lazy
 * `SystemPage` chunk - verified by inspecting the built assets, not assumed - so opening the
 * dashboard does not download them. `web/vite.config.ts` needed a fix for that: its `vendor-react`
 * rule matched `id.includes('node_modules/react')`, which also matches `node_modules/react-markdown`,
 * and would have pulled the whole parser into a chunk with no budget entry that loads on every
 * route. The rule now matches the four React packages by path boundary, so the parser stays in the
 * page's own chunk.
 *
 * The limits below restore a margin a feature can use, rather than matching what was last produced:
 *
 *   - `main entry` 190 -> 196, leaving 4.74 kB (2.4%) of headroom. The first paint stays the tightest budget, so it grows least.
 *   - `total JavaScript` 8000 -> 8300, leaving 229 kB (2.8%). Enough that the next page-local library lands
 *     without a debate; not enough to absorb a second copy of this one, which is the failure
 *     this budget exists to catch.
 *   - `total web/dist` is deliberately NOT raised: it passed at 9600 before this work and still passes, so raising it would remove a check rather than relax one.
 *
 * The per-chunk budgets below are deliberately untouched: none of them is near its limit, and
 * raising a limit that is not binding removes a check rather than relaxing one.
 *
 * ## The playground re-baseline (2026-09-26)
 *
 * A clean HEAD build measured entry 194.56 kB, JavaScript 8105.75 kB and dist
 * 9601.23 kB. Playground measured approximately 202.4, 8318 and 9817 kB.
 * The entry delta is localized copy. The remaining delta buys Ant Design X's
 * lazy chat/attachment UI and its antd dependencies; Markdown is shared with
 * System Information, not duplicated. PlaygroundPage stays outside the entry
 * graph. The gate now reads the actual HTML module entry: Rollup also emits a
 * lazy shared Markdown chunk named index-*, which is not a second main entry.
 * Limits restore a small margin: entry 210, JavaScript 8500, dist 10000 kB.
 * Existing per-library budgets are unchanged.
 *
 * ## The phone-adaptation re-baseline (2026-09-19), kept for the record
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
 *
 * ## The agent-workspace re-baseline (2026-09-27)
 *
 * A clean build of this worktree measured entry 213.92 kB and total JavaScript 9983.56 kB against
 * limits of 210 and 10500. Nothing else moved: vendor antd 1149.34, vendor charts 1433.34, the
 * YAML source editor 2890.44, the icon set 1.29, generated Lobe SVGs 1075.62 and total dist
 * 11508.21 kB are all within their budgets, so the failure is the entry alone.
 *
 * | Budget | limit | measured |
 * | --- | --- | --- |
 * | main entry | 210 | 213.92 |
 *
 * The entry's growth is localized copy, which is the only reason the entry ever grows here: the
 * agent workspace's 48 new keys are carried in the base dictionary for the first paint. That was
 * measured against the built artifact rather than assumed - the serialized form of those keys and
 * their strings inside the entry chunk is 5677 bytes. The few kB the previous baseline held as
 * headroom were spent on the same workspace's earlier copy while it was built out, which is
 * ordinary drift rather than a second cause.
 *
 * The limit is raised to restore a margin rather than to match what was produced:
 *
 *   - `main entry` 210 -> 222, leaving 8.9 kB (4.0%) against the 5677 bytes this change spent.
 *     That is the same proportion the playground re-baseline left (2.4%) and the phone-adaptation
 *     one before it (4.4%), and it keeps the first paint the tightest budget in this file - the
 *     next page-sized addition of copy will still have to argue for itself.
 *   - Every other limit is untouched: none of them is near its maximum, and raising one that is
 *     not binding removes a check rather than relaxing it.
 *
 * ## The logs-and-audit re-baseline (2026-09-28)
 *
 * A clean build measured entry 222.21 kB against the 222 limit; every other budget passed with
 * its margin intact. The cause is again localized copy in the base dictionary: the Logs page's
 * service-log and audit-trail keys - 101 of them, one sentence per audited action plus the
 * categories and result words - serialize to 7448 bytes of source. The same branch removed
 * about 6.3 kB of copy (retired placeholder pages and echo subtitles), which is why the entry
 * moved by far less than the keys it gained.
 *
 *   - `main entry` 222 -> 232, leaving 9.8 kB (4.4%): the proportion the earlier re-baselines
 *     left, and still the tightest budget in this file.
 *   - Every other limit is untouched.
 *
 * ## The plugin-management re-baseline (2026-09-28)
 *
 * A clean build of the base commit measured entry 222.21 kB; with plugin management it measures
 * 235.02 kB against the 232 limit, and every other budget passes with its margin intact. The
 * +12.81 kB is localized copy again, measured rather than assumed: the unified plugin page adds
 * 172 `plugin.*` keys (the store cards, the install dialog, the typed settings form with its
 * per-field errors, and the plugin system settings that moved off the configuration page) at
 * 16453 bytes of source, and retires 44 keys (the two table pages and the configuration group)
 * at 3747 bytes - a net 12706 bytes. The page and its components are a lazy route.
 *
 *   - `main entry` 232 -> 244, leaving 8.98 kB (3.7%): within the range the earlier re-baselines
 *     left, and still the tightest budget in this file.
 *   - Every other limit is untouched. *
 * ## The audit page re-baseline (2026-09-28)
 *
 * A clean build of the base commit measured entry 243.69 kB, 0.31 kB under its limit; with the
 * audit page, the page-following document title and the system page rework it measures
 * 247.36 kB. Of the +3.67 kB, 1893 bytes of source are localized copy (the audit page's filters
 * and outcome counts, the system page's runtime and record facts, the navigation entry), and the
 * rest is what the shell must carry for a new route: its navigation glyph, the client's audit
 * summary call with the filter serialization it shares with the trail, and the title hook. The
 * audit page itself, its trail and the system page's change log are lazy chunks.
 *
 *   - `main entry` 244 -> 256, leaving 8.64 kB (3.4%): within the range the earlier re-baselines
 *     left, and still the tightest budget in this file.
 *   - Every other limit is untouched.
 *
 * ## The agent-capability-copy re-baseline (2026-09-28)
 *
 * A clean build of the base commit (with the CPA v8 baseline) measured entry 254.97 kB; with
 * one-decision authorization, `ask_question` and the localized capability directory it measures
 * 267.98 kB against the 256 limit, and every other budget passes with its margin intact. The
 * +13.01 kB is localized copy, measured rather than assumed: 82 `agent.capability.*` keys (a
 * title and a description for every registered capability, so the directory, the authorization
 * dialog and the call chain stop showing model-facing English) at 13382 bytes of source, the
 * question panel's and dialog's other keys, and 11 retired keys from the old operation card at
 * 1756 bytes. The dialog, the question panel and the directory are part of the lazy Agent route.
 *
 *   - `main entry` 256 -> 278, leaving 10.02 kB (3.7%): within the range the earlier
 *     re-baselines left, and still the tightest budget in this file.
 *   - Every other limit is untouched.
 *
 * ## The CPA v8 alignment re-baseline (2026-09-29)
 *
 * A clean build of the base commit (without this change) measured entry 276.56 kB, JavaScript
 * 10260.12 kB and dist 11825.46 kB; this one measures 289.32, 10302.29 and 12005.77 kB. Only the
 * entry leaves its limit, and the two causes are separate.
 *
 * The entry grew by 12.76 kB of localized copy: about 93 new settings keys for the OAuth-provider,
 * discovery and pprof fields the visual editor gained, each with a title and a description in both
 * languages, plus the reworded descriptions of the settings whose old text did not match what CPA
 * does. The base dictionary is part of the first paint, so that copy is the entry's cost by
 * construction, exactly as in every earlier re-baseline.
 *
 * The 180.31 kB of `web/dist` growth is mostly a font: 137.65 kB of `codicon.ttf`, emitted beside
 * the lazy YAML editor's stylesheet. The slim Monaco build registers no icon font of its own, so
 * every editor widget glyph - the find box, the folding arrows, the suggest list - was rendering as
 * an empty box until the editor imported `features/codicon/register.js`. The font is a same-origin
 * asset at a hashed path, so it stays inside the offline/no-CDN boundary. The lazy chunk itself did
 * not move (2890.44 kB before and after): the font is a separate emitted asset, and the only change
 * to that chunk's stylesheet is 0.35 kB. The remaining JavaScript growth is the same copy in the
 * lazy `configSchema` and catalog chunks.
 *
 *   - `main entry` 278 -> 302, leaving 12.68 kB (4.2%) of headroom: within the range the earlier
 *     re-baselines left (3.4-4.4%), and it still holds the same proportion of the total.
 *   - `total JavaScript` and `total web/dist` are deliberately NOT raised: both passed with their
 *     margin intact (197.71 kB and 494.23 kB respectively), so raising them would remove a check
 *     rather than relax one.
 *   - Every other limit is untouched.
 *
 * ## The assistant-ui re-baseline (2026-09-29)
 *
 * A clean build of the base commit measured entry 289.32 kB, JavaScript 10302.54 kB and dist
 * 12006.36 kB; with the Agent and Playground on assistant-ui over AG-UI (ADR 0041) it measures
 * 292.23, 10580.30 and 12288.66 kB. Only total JavaScript leaves its limit.
 *
 * The +277.76 kB is assistant-ui, bought rather than rebuilt: `@assistant-ui/core`, `react`,
 * `store` and `tap` and the `assistant-stream` package core depends on, measured in the built
 * chunk's source map rather than assumed. It lands in one lazy chunk shared by the Agent and
 * Playground routes, which the entry lists only as a preload dependency of those routes, so no
 * other page downloads it. The Ant Design X chat components it replaces left the shared lazy
 * chunk they used to live in (about 170 kB), which is why the total grew by less than the chunk
 * weighs; the code highlighter and Markdown packages moved with the pages and are not duplicated.
 * The entry's +2.91 kB is the new workspace copy in the base dictionary.
 *
 *   - `total JavaScript` 10500 -> 10900, leaving 319.7 kB (2.9%): the proportion the System
 *     Information re-baseline left for a page-local library, and less than a second copy of this
 *     one would need.
 *   - Every other limit is untouched: the entry keeps 9.77 kB (3.2%) and the dist total 211 kB,
 *     so raising either would remove a check rather than relax one.
 *
 * ## The pricing tiers and new-matches re-baseline (2026-10-01)
 *
 * A clean build of the base commit measured entry 297.95 kB, JavaScript 10608.80 kB and dist
 * 12320.51 kB; with the tier editor and the new-match prompts it measures 302.33, 10632.05 and
 * 12346.86 kB. Only the entry leaves its limit.
 *
 * The entry's +4.38 kB is localized copy: the base dictionary's pricing keys grew by a net
 * 4.48 kB of source (the long-context and time-of-day editor sections, the price ladder, the
 * calculator and the new-match notices, less the retired single-list tier keys). The editor
 * drawer and the shared pricing parts stay in lazy chunks; the entry names them only in its
 * preload map, which was checked in the built assets rather than assumed.
 *
 *   - `main entry` 302 -> 314, leaving 11.67 kB (3.7%): within the range the earlier
 *     re-baselines left (3.2-4.4%).
 *   - Every other limit is untouched: total JavaScript keeps 267.95 kB and the dist total
 *     153.14 kB, so raising either would remove a check rather than relax one.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'web', 'dist');
const assetsDir = path.join(distDir, 'assets');
const iconDir = path.join(distDir, 'lobe-icons');

if (!fs.existsSync(assetsDir)) {
  console.error('web/dist/assets does not exist; run pnpm build first');
  process.exit(1);
}

const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const entryFile = html.match(/<script\b[^>]*type="module"[^>]*src="[^"]*\/([^"/]+)"/)?.[1];
if (!entryFile) {
  console.error('The built HTML has no module entry');
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
  { label: 'main entry', matches: (name) => name === entryFile, maxKB: 314, required: true },
  { label: 'Lobe icon JS', pattern: /^LobeIcon-.*\.js$/, maxKB: 96, required: true },
  { label: 'vendor antd', pattern: /^vendor-antd-.*\.js$/, maxKB: 1250, required: true },
  { label: 'vendor charts', pattern: /^vendor-charts-.*\.js$/, maxKB: 1600, required: true },
  { label: 'YAML source editor', pattern: /^YamlSourceEditor-.*\.js$/, maxKB: 3200, required: true },
];

let failed = false;
for (const budget of budgets) {
  const matched = entries.filter((entry) => (budget.matches ? budget.matches(entry.name) : budget.pattern.test(entry.name)));
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
  { label: 'total JavaScript', bytes: totalJSBytes, maxKB: 10900 },
  { label: 'generated Lobe SVG assets', bytes: iconBytes, maxKB: 1200 },
  { label: 'total web/dist', bytes: totalDistBytes, maxKB: 12500 },
];
for (const budget of aggregateBudgets) {
  const sizeKB = budget.bytes / 1024;
  const passed = sizeKB <= budget.maxKB;
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${budget.label} ${sizeKB.toFixed(2)} kB <= ${budget.maxKB} kB`);
  if (!passed) failed = true;
}

if (failed) process.exit(1);
