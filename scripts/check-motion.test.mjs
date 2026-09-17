/**
 * Self-test for the motion-budget checker.
 *
 * The property that matters most is the one every checker in this repository is pinned for: it must
 * never pass because it looked at nothing. Each rule is therefore exercised positively *and*
 * negatively on a fixture tree - the fixture has to fail for the right reason - because a rule that
 * silently stops matching is indistinguishable from a stylesheet that satisfies it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCheck } from './check-motion.mjs';

/** Builds a throwaway project whose `web/src` holds the given files. */
function fixture(t, files) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-motion-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const sourceDirectory = path.join(projectRoot, 'web', 'src');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const absolute = path.join(sourceDirectory, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
  return projectRoot;
}

const silent = { log() {}, error() {} };

/**
 * The messages a fixture produces.
 *
 * The exceptions table is empty by default: it is the *repository's* list of waivers, so a fixture
 * that uses none of them would otherwise report all of them as stale, and every rule below would be
 * buried under messages about the real tree. The staleness rule is exercised on its own, below.
 */
const problems = (root, exceptions = []) =>
  runCheck({ projectRoot: root, exceptions, output: silent }).violations.map((entry) => entry.message);

test('a clean stylesheet produces no violations and scans its files', (t) => {
  const projectRoot = fixture(t, {
    'panel.css': `.panel { transition: transform var(--motion-fast) var(--ease-standard); }\n`,
  });
  const result = runCheck({ projectRoot, exceptions: [], output: silent });
  assert.deepEqual(result.violations, []);
  assert.equal(result.filesScanned, 1);
});

test('an empty tree fails rather than passing vacuously', (t) => {
  // The failure this guards is a checker that found nothing to read and reported success: a green
  // gate that verified no stylesheet at all.
  const projectRoot = fixture(t, {});
  const result = runCheck({ projectRoot, exceptions: [], output: silent });
  assert.equal(result.filesScanned, 0);
  assert.equal(result.violations.length, 1);
});

test('a raw duration is rejected, and the token form is accepted', (t) => {
  const raw = fixture(t, { 'panel.css': `.panel { transition: transform 180ms ease; }\n` });
  assert.match(problems(raw)[0] ?? '', /raw duration 180ms/);
  const tokenised = fixture(t, { 'panel.css': `.panel { transition: transform var(--motion-fast) ease; }\n` });
  assert.deepEqual(problems(tokenised), []);
});

test('a token fallback is rejected, because it is never applied', (t) => {
  // This is the shape the drift hid in: `var(--motion-fast, 50ms)` beside a variable that held
  // 100ms read as a 50ms declaration and paid 100ms.
  const projectRoot = fixture(t, { 'panel.css': `.panel { transition: transform var(--motion-fast, 50ms); }\n` });
  assert.match(problems(projectRoot)[0] ?? '', /fallback, which is never applied/);
});

test('a layout property needs an exception, and an unregistered one is rejected', (t) => {
  const projectRoot = fixture(t, { 'panel.css': `.panel { transition: max-height var(--motion-base); }\n` });
  assert.match(problems(projectRoot)[0] ?? '', /transitions the layout property `max-height`/);
});

test('`all` is rejected, because it includes the layout properties', (t) => {
  const projectRoot = fixture(t, { 'panel.css': `.panel { transition: all var(--motion-fast); }\n` });
  assert.match(problems(projectRoot)[0] ?? '', /transitions `all`/);
});

test('a keyframe animation without a reduced-motion counterpart is rejected', (t) => {
  const unguarded = fixture(t, {
    'panel.css': `.rise { animation: rise var(--motion-base) forwards; }\n@keyframes rise { from { opacity: 0; } to { opacity: 1; } }\n`,
  });
  assert.match(problems(unguarded).join('\n'), /no `prefers-reduced-motion` counterpart/);

  const guarded = fixture(t, {
    'panel.css': `.rise { animation: rise var(--motion-base) forwards; }\n@keyframes rise { from { opacity: 0; } to { opacity: 1; } }\n@media (prefers-reduced-motion: reduce) { .rise { animation: none; } }\n`,
  });
  assert.deepEqual(problems(guarded), []);
});

test('a keyframe that animates a layout property is rejected', (t) => {
  const projectRoot = fixture(t, {
    'panel.css': `.rise { animation: rise var(--motion-base) forwards; }\n@keyframes rise { from { height: 0; } to { height: 10px; } }\n@media (prefers-reduced-motion: reduce) { .rise { animation: none; } }\n`,
  });
  assert.match(problems(projectRoot).join('\n'), /animates the layout property `height`/);
});

test('a hover colour outside the fast token is rejected', (t) => {
  const slow = fixture(t, { 'panel.css': `.panel:hover { transition: color var(--motion-base); }\n` });
  assert.match(problems(slow)[0] ?? '', /outside the fast token/);
  const fast = fixture(t, { 'panel.css': `.panel:hover { transition: color var(--motion-fast); }\n` });
  assert.deepEqual(problems(fast), []);
});

test('an inline transition in a component is read by the same rules', (t) => {
  const projectRoot = fixture(t, {
    'Panel.tsx': `export const Panel = () => <div style={{ transition: 'border-color 0.15s ease' }} />;\n`,
  });
  assert.match(problems(projectRoot)[0] ?? '', /raw duration 0.15s/);
});

test('an exception the stylesheet no longer uses is reported', (t) => {
  const stale = {
    kind: 'layout',
    file: 'panel.css',
    selector: '.panel',
    property: 'width',
    why: 'a fixture waiver, so the staleness rule has something to find',
  };
  const projectRoot = fixture(t, { 'panel.css': `.panel { color: red; }\n` });
  assert.match(problems(projectRoot, [stale]).join('\n'), /exception is no longer used/);

  // ...and the same waiver stops being reported the moment a rule uses it.
  const used = fixture(t, { 'panel.css': `.panel { transition: width var(--motion-base); }\n` });
  assert.deepEqual(problems(used, [stale]), []);
});

test('the repository itself is clean', () => {
  // The one assertion that cannot be made about a fixture: the tree this ships with satisfies its own
  // budget. A rule change that breaks the stylesheet is a failure here, where the reason is legible.
  const result = runCheck({ output: silent });
  assert.deepEqual(result.violations.map((entry) => `${entry.file} ${entry.message}`), []);
  assert.ok(result.filesScanned > 50, `scanned ${result.filesScanned} files; the tree should be far larger than a fixture`);
});