#!/usr/bin/env node
/**
 * check-style-tokens keeps type sizes and corner radii on the scales `docs/design.md` §3 and §4 name.
 *
 * Both scales were stated in prose long before they were variables, and the stylesheets answered with
 * twenty-two font sizes - half-pixel steps among them - and three spellings of one radius. A size
 * written as a number is invisible to the next person choosing one, so they choose a new number.
 *
 * Three rules, all objective:
 *
 *   1. **A font size on the scale is written as its token.** `font-size: 12px` is `var(--text-sm)`.
 *      A fractional pixel size is refused outright: it is a step between two tokens, which is a
 *      scale of its own. Sizes that are neither - a display numeral, an icon - are literals, because
 *      they belong to one surface and the scale has no step for them.
 *   2. **A corner radius of 2, 3 or 4 pixels is written as its token.** The console has two small
 *      radii; three pixels is a third one.
 *   3. **A `--text-*` or `--radius-*` reference names a variable a stylesheet defines, and carries
 *      no fallback.** An undefined variable makes the whole declaration invalid at computed-value
 *      time, which is how five `var(--radius-xs)` call sites drew square corners unnoticed; a
 *      fallback is the place a second value hides once the variable changes.
 *
 * Limitation, stated rather than implied: this reads `.css` only. A size assembled in a component's
 * inline style is not seen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pixel sizes the type scale owns, so a literal of the same size is a missed token. */
const TEXT_SCALE = { 10: '2xs', 11: 'xs', 12: 'sm', 13: 'md', 14: 'base', 16: 'lg', 22: 'xl' };
const RADIUS_SCALE = { 2: 'xs', 3: 'xs', 4: 'sm' };

function walkStylesheets(directory, found = []) {
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkStylesheets(absolute, found);
    else if (entry.name.endsWith('.css')) found.push(absolute);
  }
  return found;
}

function stripComments(source) {
  // Newlines survive so a reported line still points at the declaration.
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

export function findViolations(source, definedTokens) {
  const violations = [];
  // Scanned whole rather than line by line: a value on the line after its property is still one
  // declaration, and `\s*` has to be able to cross that break to see it.
  const text = stripComments(source);
  const lineAt = (offset) => text.slice(0, offset).split('\n').length;
  for (const match of text.matchAll(/(?<![-\w])font-size:\s*([0-9]*\.?[0-9]+)px/g)) {
    const size = Number(match[1]);
    const line = lineAt(match.index);
    if (!Number.isInteger(size)) {
      violations.push({ line, message: `\`font-size: ${match[1]}px\` sits between two steps of the type scale; use a \`--text-*\` token` });
    } else if (TEXT_SCALE[size]) {
      violations.push({ line, message: `\`font-size: ${size}px\` is \`var(--text-${TEXT_SCALE[size]})\`` });
    }
  }
  for (const match of text.matchAll(/border(?:-[a-z]+)*-radius:\s*([^;}]+)/g)) {
    const line = lineAt(match.index);
    for (const part of match[1].trim().split(/\s+/)) {
      const literal = /^([0-9]+)px$/.exec(part);
      if (literal && RADIUS_SCALE[literal[1]]) {
        violations.push({ line, message: `a ${literal[1]}px corner is \`var(--radius-${RADIUS_SCALE[literal[1]]})\`` });
      }
    }
  }
  for (const match of text.matchAll(/var\(\s*(--(?:text|radius)-[a-z0-9-]+)\s*(,)?/g)) {
    const line = lineAt(match.index);
    if (match[2]) {
      violations.push({ line, message: `\`${match[1]}\` carries a fallback, which is where a second value hides` });
    } else if (!definedTokens.has(match[1])) {
      violations.push({ line, message: `\`${match[1]}\` is not defined by any stylesheet, so the declaration is dropped` });
    }
  }
  return violations;
}

export function runCheck({ projectRoot = DEFAULT_ROOT, output = console } = {}) {
  const sourceRoot = path.join(projectRoot, 'web', 'src');
  const files = walkStylesheets(sourceRoot);
  const sources = files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const definedTokens = new Set();
  for (const { source } of sources) {
    for (const match of stripComments(source).matchAll(/(--(?:text|radius)-[a-z0-9-]+)\s*:/g)) definedTokens.add(match[1]);
  }
  const failures = [];
  for (const { file, source } of sources) {
    for (const violation of findViolations(source, definedTokens)) {
      failures.push({ file: path.relative(projectRoot, file), ...violation });
    }
  }
  if (files.length === 0) {
    failures.push({ file: '(none)', line: 0, message: 'no stylesheets scanned' });
  }
  for (const failure of failures) output.error(`FAIL: ${failure.file}:${failure.line} — ${failure.message}`);
  if (failures.length === 0) {
    output.log(`Stylesheets checked: ${files.length}`);
    output.log('Every scale-sized font and small radius is a token, and every token reference resolves.');
  } else {
    output.error(`\n${failures.length} style-token violation(s) across ${files.length} stylesheets.`);
  }
  return { filesScanned: files.length, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runCheck().failures.length > 0 ? 1 : 0);
}
