/**
 * The motion budget, enforced.
 *
 * docs/design.md §7 states one budget three times - its token table, the Ant Design motion tokens in
 * `themeConfig.ts`, and the `--motion-*` variables in `index.css` - and the stylesheet had drifted
 * from the other two (100ms/150ms against a documented 50ms/100ms) for long enough that call sites
 * written as `var(--motion-fast, 50ms)` were paying double the budget they named. `test-theme-presets`
 * pins the variables to the tokens; this checker pins the *call sites* to the variables.
 *
 * Four rules, all of them objective:
 *
 *   1. **Every duration is a token**, in a `transition` or an `animation` and in their longhands, and
 *      the token has to be one a stylesheet actually defines - `var(--motion-fastt)` resolves to
 *      nothing at run time, so the declaration would silently lose its duration. No `var(--motion-*)`
 *      carries a fallback either: a fallback is never applied, and the one that read `50ms` beside a
 *      variable holding `100ms` is exactly how this drift stayed invisible. The exceptions are
 *      indeterminate progress cycles, whose period is not a state transition and has no token.
 *   2. **No transition on a layout property**, and no `transition: all`, which is every property
 *      including the layout ones. §7 rule 1's list; the exceptions are disclosures and the bar whose
 *      width positions its own label. An exception is keyed by file, selector and property, and it
 *      must carry a reason - an unexplained exception is how a budget disappears.
 *   3. **Every keyframe animation has a reduced-motion counterpart.** §7's override is a promise, and
 *      a keyframe cannot be reached by a media query written after the fact: the counterpart has to
 *      exist next to the motion. Scope note: transitions are not checked here, because the console
 *      kills them per-rule where the motion is intrusive (the heatmap mark scales, so its colour fade
 *      would smear) and a blanket requirement would flag every 50ms hover.
 *   4. **A hover may transition colour only within the fast token.** §7 rule 7 was written as a ban
 *      after Ant Design's 0.3s drag; the console's own hovers are 50ms, which is three frames, and
 *      banning them would rewrite hover behaviour on every page for no measurable gain. See ADR 0009.
 *
 * Limitations, stated rather than implied: this reads `.css` and inline `transition:` strings in
 * `.tsx`, so a duration assembled at runtime is invisible to it, and it matches selectors textually -
 * a base rule is associated with its `:hover` counterpart by name alone, so a hover written as a
 * different selector (through `:not()`, or a different descendant chain) is not recognised as one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Properties that trigger layout, per §7 rule 1. Any of these in a transition needs an exception. */
const LAYOUT_PROPERTIES = [
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding',
  'padding-top',
  'padding-bottom',
  'top',
  'bottom',
  'left',
  'right',
  'inset',
  'inset-inline-start',
  'inset-inline-end',
  'grid-template-rows',
  'grid-template-columns',
  'flex-basis',
  'font-size',
];

/**
 * The exceptions, each with the reason it is one.
 *
 * `duration` waives rule 1 (an indeterminate bar's period is not a state transition); `layout` waives
 * rule 2 (a disclosure cannot be composited). Both are asserted to be *used*, so the table cannot rot
 * into a list of things nobody remembers reading.
 */
const EXCEPTIONS = [
  {
    kind: 'duration',
    file: 'index.css',
    selector: '.data-progress::after',
    property: 'animation',
    why: 'The indeterminate background-refresh bar loops for as long as the request takes; 900ms is its period, not a transition, and §7 handles it by freezing it under reduced motion rather than by shortening it.',
  },
  {
    kind: 'duration',
    file: 'index.css',
    selector: '.heatmap-progress::after',
    property: 'animation',
    why: 'Same treatment as the app-wide progress bar, for the heatmap panel\u2019s own re-read.',
  },
  {
    kind: 'layout',
    file: 'index.css',
    selector: '.settings-tls-body',
    property: 'grid-template-rows',
    why: 'A disclosure. Expanding and collapsing an accordion reflows by definition, and the grid 0fr/1fr technique is the least costly form of it; the alternative is an accordion that snaps open, which reads as broken.',
  },
  {
    kind: 'layout',
    file: 'index.css',
    selector: '.config-dirty-bar-portal',
    property: 'inset-inline-start',
    why: 'The floating save bar is centred in the content column, and collapsing the sider resizes that column. Encoding the shift as a transform would mean recomputing a delta outside CSS; here the custom property already carries it.',
  },
  {
    kind: 'layout',
    file: 'pages/UsageEventsPage.css',
    selector: '.request-collapsible-header',
    property: 'max-height',
    why: 'A disclosure, and a large one: this block is the request page\u2019s own header and its whole filter toolbar, folded away so a reader can scroll it out of the way. Its `margin` rides along in the same declaration for the same reason.',
  },
  {
    kind: 'layout',
    file: 'pages/UsageEventsPage.css',
    selector: '.request-collapsible-header',
    property: 'margin',
    why: 'Part of the same disclosure: collapsing the header to zero height still leaves its box gap, and the negative margin is what takes that back.',
  },
  {
    kind: 'layout',
    file: 'pages/pricing/PricingLeaderboard.module.css',
    selector: '.bar-fill',
    property: 'width',
    why: 'The request count and model name are siblings that sit immediately after the bar, so the bar\u2019s width *is* the layout that positions its own label. Sweeping it with a transform would move the painted bar while the number it labels jumped to its final place.',
  },
];

/** Strip comments so prose about a duration is never read as one. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The non-zero time values in one string, as written.
 *
 * `.?\d+` rather than `\d*\.?\d+`: both match `.15s`, but only the first reports it as `.15s`
 * instead of `15s`, and a failure message that misquotes the value it rejected sends the reader
 * looking for a declaration that is not there.
 */
const durationsIn = (value) =>
  [...value.matchAll(/(?<![\w.])(?:\.\d+|\d+(?:\.\d+)?)(?:ms|s)\b/g)]
    .map((match) => match[0])
    .filter((raw) => !/^0(?:ms|s)$/.test(raw));

/** Splits a declaration value into its comma-separated parts, ignoring separators inside `()`. */
function parts(value) {
  let depth = 0;
  const out = [];
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * The property a shorthand part animates: its first bare identifier.
 *
 * A part that opens with a function is not a property at all. `transition: var(--motion-fast) ease`
 * omits the property, and CSS reads that as `all` - so returning `var` here (which the obvious regex
 * does, because `var` looks like an identifier) would hand the `all` and layout checks a property
 * they then skip. It returns empty, and the caller treats empty as `all`.
 */
const propertyOf = (part) => (/^[a-z-]+\s*\(/.test(part) ? '' : /^([a-z-]+)\b/.exec(part)?.[1] ?? '');

/** The individual selectors of a comma-separated prelude. */
const selectorList = (selector) => selector.split(',').map((entry) => entry.trim()).filter(Boolean);

/**
 * Parses a stylesheet into leaf rules and keyframe blocks.
 *
 * A hand-rolled brace matcher rather than a CSS parser: the input is one repository's stylesheets, and
 * what this needs - the selector, the declarations, and whether the rule sits inside a reduced-motion
 * media query - follows from the brace and semicolon structure. Comments are removed first so a `}`
 * inside prose cannot end a rule.
 */
function parseStylesheet(css) {
  const source = stripComments(css);
  const rules = [];
  const keyframes = [];
  const stack = [];
  let start = 0;

  const declarations = (body) => {
    const found = [];
    for (const line of body.split(';')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      found.push({ property: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
    }
    return found;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      const selector = source.slice(start, index).trim();
      stack.push(selector);
      start = index + 1;
    } else if (char === '}') {
      const body = source.slice(start, index);
      const selector = stack.pop() ?? '';
      const media = stack.filter((entry) => entry.startsWith('@media')).join(' ');
      const frame = stack.find((entry) => entry.startsWith('@keyframes'));
      if (frame) {
        // Inside a keyframe block: these declarations say what the motion animates.
        keyframes.push({ selector, media, declarations: declarations(body), frame });
      } else if (selector && !selector.startsWith('@')) {
        rules.push({ selector, media, declarations: declarations(body) });
      }
      start = index + 1;
    } else if (char === ';' && stack.length === 0) {
      start = index + 1;
    }
  }
  return { rules, keyframes };
}

/** Every stylesheet under `web/src`, and every component that carries an inline transition. */
function collectSources(srcDir) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.css') || entry.name.endsWith('.tsx')) files.push(absolute);
    }
  };
  walk(srcDir);
  return files.sort();
}

/**
 * Runs the checker over one source tree.
 *
 * `projectRoot` is a parameter rather than the module's own `..` so the self-test can run the real
 * rules against a fixture tree: a checker whose only input is the live repository can be tested by
 * mutating the repository, which is not a test.
 */
export function runCheck({ projectRoot = root, exceptions = EXCEPTIONS, output = console } = {}) {
const srcDir = path.join(projectRoot, 'web', 'src');
const violations = [];
const usedExceptions = new Set();

const record = (message, file, selector, property) => {
  violations.push({ file, selector, property, message });
};

const exceptionFor = (kind, file, selector, property) =>
  exceptions.find(
    (exception) =>
      exception.kind === kind &&
      exception.file === file &&
      exception.selector === selector &&
      exception.property === property,
  );

/**
 * The motion tokens a usage may name, read from the stylesheets instead of hard-coded here.
 *
 * A `var(--motion-fastt)` resolves to nothing at run time, so the declaration silently loses its
 * duration; a list maintained in this file would accept the typo, and would also go stale every time
 * a token is added. Reading the definitions means the checker and the stylesheet cannot disagree
 * about which tokens exist.
 */
const tokenNamesIn = (text) => [...text.matchAll(/(--motion-[a-z-]+)\s*:/g)].map((match) => match[1]);

const used = (kind, file, selector, property) => {
  const exception = exceptionFor(kind, file, selector, property);
  if (exception) usedExceptions.add(exception);
  return Boolean(exception);
};

/**
 * Checks one transition declaration against rules 1, 2 and 4.
 *
 * `selector` is what the rules are keyed by, which for an inline style is the component rather than a
 * CSS selector: an exception is never granted to an inline style, so there is nothing to key.
 */
function checkTransition({ file, selector, property, value, isHover, tokens }) {
  const bare = value.replace(/var\([^)]*\)/g, '');
  for (const raw of durationsIn(bare)) {
    if (!used('duration', file, selector, property)) {
      record(`uses the raw duration ${raw}`, file, selector, property);
    }
  }
  for (const [, token] of value.matchAll(/(--motion-[a-z-]+)/g)) {
    if (!tokens.has(token)) record(`names \`${token}\`, which no stylesheet defines`, file, selector, property);
  }
  if (/var\(--motion-[a-z-]+,/.test(value)) {
    record('names a var(--motion-*) fallback, which is never applied and hides the real value', file, selector, property);
  }
  if (property === 'all' || property === '') {
    record('transitions `all`, which includes the layout properties rule 1 forbids', file, selector, property || '(none)');
  } else if (LAYOUT_PROPERTIES.includes(property) && !used('layout', file, selector, property)) {
    record(`transitions the layout property \`${property}\``, file, selector, property);
  }
  if (isHover && property === 'all') {
    record('a hover transitions every property', file, selector, property);
  }
}

const sources = collectSources(srcDir).map((absolute) => ({
  absolute,
  file: path.relative(srcDir, absolute).split(path.sep).join('/'),
  text: fs.readFileSync(absolute, 'utf8'),
}));

// Every file is read before any rule runs, because a token is defined in one stylesheet and used in
// another: `index.css` owns the `:root` block every page's transitions read.
const tokens = new Set(sources.filter((source) => source.absolute.endsWith('.css')).flatMap((source) => tokenNamesIn(source.text)));

for (const { absolute, file, text } of sources) {

  // A component's inline style is a stylesheet this checker cannot parse, so the declarations are
  // lifted out of the string literals and judged by the same rules.
  if (absolute.endsWith('.tsx')) {
    for (const match of text.matchAll(/transition:\s*'([^']*)'|transition:\s*"([^"]*)"/g)) {
      const value = match[1] ?? match[2] ?? '';
      for (const part of parts(value)) {
        checkTransition({ file, selector: '(inline style)', property: propertyOf(part), value: part, isHover: false, tokens });
      }
    }
    continue;
  }

  const { rules, keyframes } = parseStylesheet(text);
  // A base rule whose selector has a `:hover` counterpart is a hover's transition: the declaration and
  // the state it serves are almost never in the same block, and reading only the block with `:hover`
  // in it let `.card { transition: border-color var(--motion-base) }` pass rule 4 untouched.
  const hoverSelectors = new Set(
    rules.filter((rule) => /:hover\b/.test(rule.selector)).flatMap((rule) => selectorList(rule.selector)),
  );
  // Individual selectors rather than whole preludes: a reduce block and the rule it answers are
  // routinely written as multi-line selector lists, and comparing the preludes as strings makes the
  // match depend on their formatting.
  const reducedKills = new Set(
    rules
      .filter((rule) => rule.media.includes('prefers-reduced-motion'))
      .filter((rule) => /^none\b/.test(rule.declarations.find((entry) => entry.property === 'animation')?.value ?? ''))
      .flatMap((rule) => selectorList(rule.selector)),
  );

  for (const rule of rules) {
    const isReducedBlock = rule.media.includes('prefers-reduced-motion');
    const transition = rule.declarations.find(
      (entry) => entry.property === 'transition' || entry.property === 'transition-duration',
    );
    if (transition && !isReducedBlock) {
      const isHover =
        /:hover\b/.test(rule.selector) ||
        selectorList(rule.selector).some((entry) => hoverSelectors.has(`${entry}:hover`));
      for (const part of parts(transition.value)) {
        checkTransition({ file, selector: rule.selector, property: propertyOf(part), value: part, isHover, tokens });
      }
      // Rule 4, second half: a hover's colour parts must name the fast token rather than merely
      // staying under it - a bare `50ms` is a number no document owns.
      if (isHover) {
        for (const part of parts(transition.value)) {
          const property = propertyOf(part);
          if (!/^(color|background|background-color|border-color|box-shadow|opacity)$/.test(property)) continue;
          if (!/var\(--motion-fast\)/.test(part)) {
            record(`a hover transitions \`${property}\` outside the fast token`, file, rule.selector, property);
          }
        }
      }
    }

    // The shorthand and its longhands are one concern: a duration under `animation-duration` is the
    // same raw number as one inside the shorthand, and a rule that names an animation longhand
    // animates whatever the shorthand is doing. Reading only the shorthand let both forms through.
    const animation = rule.declarations.find((entry) => entry.property === 'animation');
    const animationDuration = rule.declarations.find((entry) => entry.property === 'animation-duration');
    const animationName = rule.declarations.find((entry) => entry.property === 'animation-name');
    if (!isReducedBlock) {
      for (const declaration of [animation, animationDuration]) {
        if (!declaration || /^none\b/.test(declaration.value)) continue;
        for (const [, token] of declaration.value.matchAll(/(--motion-[a-z-]+)/g)) {
          if (!tokens.has(token)) {
            record(`names \`${token}\`, which no stylesheet defines`, file, rule.selector, declaration.property);
          }
        }
        if (/var\(--motion-[a-z-]+,/.test(declaration.value)) {
          record('names a var(--motion-*) fallback, which is never applied and hides the real value', file, rule.selector, declaration.property);
        }
        for (const raw of durationsIn(declaration.value.replace(/var\([^)]*\)/g, ''))) {
          if (!used('duration', file, rule.selector, 'animation')) {
            record(`animation uses the raw duration ${raw}`, file, rule.selector, declaration.property);
          }
        }
      }
      const animates = [animation, animationDuration, animationName].some(
        (declaration) => declaration && !/^none\b/.test(declaration.value),
      );
      const killed = selectorList(rule.selector).every((entry) => reducedKills.has(entry));
      if (animates && !killed) {
        record('animates with no `prefers-reduced-motion` counterpart', file, rule.selector, 'animation');
      }
    }
  }

  // Rule 2 reaches into keyframes too: a keyframe that animates a layout property reflows on every
  // frame of its motion, wherever the transform it was meant to be lives.
  for (const frame of keyframes) {
    for (const declaration of frame.declarations) {
      if (!LAYOUT_PROPERTIES.includes(declaration.property)) continue;
      record(`animates the layout property \`${declaration.property}\` in ${frame.frame}`, file, frame.selector, declaration.property);
    }
  }
}

// An exception nobody uses is a claim the stylesheet no longer makes, and leaving it in place is how a
// budget turns into a list of things that were once true.
for (const exception of exceptions) {
  if (usedExceptions.has(exception)) continue;
  violations.push({
    file: exception.file,
    selector: exception.selector,
    property: exception.property,
    message: `the \`${exception.kind}\` exception is no longer used`,
  });
}

const filesScanned = sources.length;
if (filesScanned === 0) {
  output.error('FAIL: no stylesheet or component was scanned; the checker is looking in the wrong place');
  return { filesScanned, violations: [{ file: '(none)', selector: '(none)', property: '(none)', message: 'no sources scanned' }] };
}

for (const violation of violations) {
  output.error(`FAIL: ${violation.file} — ${violation.message}\n      at ${violation.selector} { ${violation.property} }`);
}
if (violations.length === 0) {
  output.log(`Sources checked: ${filesScanned} (stylesheets and inline transition strings)`);
  output.log(`Motion exceptions in use: ${usedExceptions.size} of ${exceptions.length}`);
  output.log('Every duration is a token, no transition animates layout, and every keyframe honours reduced motion.');
} else {
  output.error(`\n${violations.length} motion violation(s) across ${filesScanned} files.`);
  output.error('Every duration must be a --motion-* token, and every layout exception must be listed in EXCEPTIONS with a reason.');
}

return { filesScanned, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { violations } = runCheck();
  process.exit(violations.length > 0 ? 1 : 0);
}