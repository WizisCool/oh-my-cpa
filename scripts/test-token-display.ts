import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_CHART_VIEW,
  DEFAULT_TOKEN_NUMBER_STYLE,
  MODEL_CHART_VIEWS,
  TOKEN_NUMBER_STYLES,
  formatCost,
  formatTokens,
  formatTokensFull,
  parseModelChartView,
  parseTokenNumberStyle,
  resolveTokenNumberStyle,
} from '../web/src/types/tokenDisplay.ts';
import {
  formatModelShare,
  formatModelTokens,
  withGroupBy,
} from '../web/src/types/dashboardModels.ts';

// ── the unit styles ────────────────────────────────────────────────────────────

// The international compact form: engineering shorthand, one decimal, no trailing zero.
assert.equal(formatTokens(0, 'en-compact'), '0');
assert.equal(formatTokens(999, 'en-compact'), '999');
assert.equal(formatTokens(1_000, 'en-compact'), '1K');
assert.equal(formatTokens(300_000, 'en-compact'), '300K');
assert.equal(formatTokens(1_500_000, 'en-compact'), '1.5M');
assert.equal(formatTokens(1_200_000_000, 'en-compact'), '1.2B');
assert.equal(formatTokens(1_200_000_000_000, 'en-compact'), '1.2T');

// The Chinese scale: 万 from ten thousand, 亿 from a hundred million, one decimal, trimmed.
assert.equal(formatTokens(9_999, 'zh'), '9999');
assert.equal(formatTokens(10_000, 'zh'), '1万');
assert.equal(formatTokens(300_000, 'zh'), '30万');
assert.equal(formatTokens(3_000_000, 'zh'), '300万');
assert.equal(formatTokens(120_000_000, 'zh'), '1.2亿');
assert.equal(formatTokens(1_200_000_000, 'zh'), '12亿');
// Just under a step stays in the lower unit: the boundary is where the rounding lives.
assert.equal(formatTokens(99_999_999, 'zh'), '10000万');
// Non-finite is the console's shared "no reading" mark, in both styles.
assert.equal(formatTokens(NaN, 'en-compact'), '—');
assert.equal(formatTokens(Infinity, 'zh'), '—');

// The `full` style is the same reading as the exact form: grouped digits with no
// unit word. It is the one style that means the same thing in both consoles, which
// is why it is offered to an English reader as the alternative to an abbreviation.
assert.equal(formatTokens(1234567, 'full'), '1,234,567');
assert.equal(formatTokens(0, 'full'), '0');
assert.equal(formatTokens(999, 'full'), '999');
assert.equal(formatTokens(NaN, 'full'), '\u2014');
assert.equal(formatTokens(1234567, 'full'), formatTokensFull(1234567));

// The full form is exact with separators, in every style: it is what tooltips
// and accessible names print, so rounding would present an approximation as fact.
assert.equal(formatTokensFull(1234567), '1,234,567');
assert.equal(formatTokensFull(0), '0');
assert.equal(formatTokensFull(NaN), '—');

// ── the language guard ────────────────────────────────────────────────────────

// 万 and 亿 are words, so a Chinese scale in an English console would mix two
// languages in one reading. A stored `zh` therefore resolves to the compact form
// whenever the console is not Chinese...
assert.equal(resolveTokenNumberStyle('zh', 'en'), 'en-compact');
assert.equal(resolveTokenNumberStyle('zh', 'zh'), 'zh');
// ...while the language-neutral styles pass through untouched, in both consoles.
assert.equal(resolveTokenNumberStyle('en-compact', 'en'), 'en-compact');
assert.equal(resolveTokenNumberStyle('en-compact', 'zh'), 'en-compact');
assert.equal(resolveTokenNumberStyle('full', 'en'), 'full');
assert.equal(resolveTokenNumberStyle('full', 'zh'), 'full');

// ── parsing stored preferences ─────────────────────────────────────────────────

// Stored values are input, not state: valid values survive, everything else
// falls back rather than reaching a formatter with a style it does not implement.
assert.equal(parseTokenNumberStyle('zh'), 'zh');
assert.equal(parseTokenNumberStyle('en-compact'), 'en-compact');
// A value stored before the third style existed still parses, and an invented one
// still falls back rather than reaching a formatter it does not implement.
assert.equal(parseTokenNumberStyle('full'), 'full');
assert.equal(parseTokenNumberStyle('k/m/b'), undefined);
assert.equal(parseTokenNumberStyle('bogus'), undefined);
assert.equal(parseTokenNumberStyle(42), undefined);
assert.equal(parseTokenNumberStyle(null), undefined);

assert.equal(parseModelChartView('call'), 'call');
assert.equal(parseModelChartView('model'), 'model');
assert.equal(parseModelChartView('calls'), undefined);
assert.equal(parseModelChartView(undefined), undefined);

assert.deepEqual([...TOKEN_NUMBER_STYLES], ['en-compact', 'zh', 'full']);
assert.deepEqual([...MODEL_CHART_VIEWS], ['call', 'model']);
assert.equal(DEFAULT_TOKEN_NUMBER_STYLE, 'en-compact');
assert.equal(DEFAULT_MODEL_CHART_VIEW, 'call');

// ── costs ──────────────────────────────────────────────────────────────────────

// Four decimals: request costs are commonly fractions of a cent, and two decimals
// would collapse a thousand small calls into "$0.00".
assert.equal(formatCost(0.000012), '$0.0000');
assert.equal(formatCost(0.5), '$0.5000');
assert.equal(formatCost(null), '—');
assert.equal(formatCost(undefined), '—');
assert.equal(formatCost(NaN), '—');

// ── the model panels' own derivations ──────────────────────────────────────────

// Shares keep a decimal under ten percent and report under-one rather than zero.
assert.equal(formatModelShare(500, 1000), '50%');
assert.equal(formatModelShare(45, 1000), '4.5%');
assert.equal(formatModelShare(0.4, 1000), '<0.1%');
assert.equal(formatModelShare(0, 0), '—');

// The panel formatter forwards to the shared layer: the default keeps the
// international form for callers with no preference in hand.
assert.equal(formatModelTokens(1_200_000_000), '1.2B');
assert.equal(formatModelTokens(1_200_000_000, 'zh'), '12亿');

// The grouping view rides in the query, because a ranking read in one grouping
// cannot be reused for the other. `model` is the endpoint's own default, so the
// original URL shape is untouched.
assert.equal(withGroupBy('preset=7d', 'call'), 'preset=7d&group_by=call');
assert.equal(withGroupBy('preset=7d', 'model'), 'preset=7d');
assert.equal(withGroupBy('', 'call'), 'group_by=call');
assert.equal(withGroupBy('', 'model'), '');

console.log('token display: all assertions passed');
