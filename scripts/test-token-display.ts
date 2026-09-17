import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_CHART_VIEW,
  DEFAULT_TOKEN_NUMBER_STYLE,
  MODEL_CHART_VIEWS,
  TOKEN_NUMBER_STYLES,
  formatCost,
  formatTokenRate,
  formatTokens,
  formatTokensFull,
  parseModelChartView,
  parseTokenNumberStyle,
  resolveCountFlowReadout,
  resolveTokenFlowReadout,
  resolveTokenRateFlowReadout,
  resolveTokenNumberStyle,
} from '../web/src/types/tokenDisplay.ts';
import { formatCacheRate, resolveCacheRateReadout } from '../web/src/theme/cacheScale.ts';
import { LANGUAGES, isChineseLanguage, languageLocale } from '../web/src/i18n/language.ts';
import type { RollingReadout } from '../web/src/types/rollingNumber.ts';
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
// unit word. It is the one style that means the same thing in every console, which
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

// 万 and 亿 are words, so a Chinese scale in a non-Chinese console would mix two
// languages in one reading. A stored `zh` therefore resolves to the compact form
// whenever the console is not Chinese...
assert.equal(resolveTokenNumberStyle('zh', 'en'), 'en-compact');
assert.equal(resolveTokenNumberStyle('zh', 'zh'), 'zh');
assert.equal(resolveTokenNumberStyle('zh', 'zh-Hant'), 'zh');
assert.equal(resolveTokenNumberStyle('zh', 'ms'), 'en-compact');
// ...while the language-neutral styles pass through untouched in every console.
assert.equal(resolveTokenNumberStyle('en-compact', 'en'), 'en-compact');
assert.equal(resolveTokenNumberStyle('en-compact', 'zh'), 'en-compact');
assert.equal(resolveTokenNumberStyle('en-compact', 'zh-Hant'), 'en-compact');
assert.equal(resolveTokenNumberStyle('en-compact', 'ms'), 'en-compact');
assert.equal(resolveTokenNumberStyle('full', 'en'), 'full');
assert.equal(resolveTokenNumberStyle('full', 'zh'), 'full');
assert.equal(resolveTokenNumberStyle('full', 'zh-Hant'), 'full');
assert.equal(resolveTokenNumberStyle('full', 'ms'), 'full');

// The language registry is the single source every switcher reads, and both Chinese
// scripts carry the language-specific unit rule.
assert.deepEqual(
  LANGUAGES.map((language) => language.id),
  ['zh', 'zh-Hant', 'en', 'ms'],
);
assert.equal(isChineseLanguage('zh'), true);
assert.equal(isChineseLanguage('zh-Hant'), true);
assert.equal(isChineseLanguage('en'), false);
assert.equal(isChineseLanguage('ms'), false);
assert.equal(languageLocale('zh-Hant'), 'zh-Hant');
assert.equal(languageLocale('ms'), 'ms-MY');

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

// ── the animated readouts ──────────────────────────────────────────────────────

/**
 * Renders a readout the way the animation runtime does.
 *
 * The runtime builds an `Intl.NumberFormat` from the readout's locale and format and
 * paints its parts with the prefix and suffix beside them, so this reproduces the
 * contract the tile depends on rather than the tile's own implementation.
 */
function renderReadout(readout: RollingReadout | undefined): string {
  if (!readout) return '—';
  return `${readout.prefix ?? ''}${new Intl.NumberFormat('en', readout.format).format(readout.number)}${readout.suffix}`;
}

// The animated tile and the printed string must be the same reading, and the readout
// derives its number from the formatter's *own* parts for exactly that reason. The
// failure this guards against is the one a second rounding rule would hide: a scaled
// number re-formatted back across a unit boundary - 999,999 printing as `1000K`
// where the formatter says `1M`.
//
// A spread of real magnitudes is checked rather than the handful of examples above,
// because those boundaries are where the two paths can disagree and no one would
// think to try them by hand.
const TOKEN_SPREAD = [0, 1, 999, 1_000, 9_999, 10_000, 300_000, 999_999, 1_200_000,
  99_999_999, 120_000_000, 1_200_000_000, 1_200_000_000_000];
for (let power = 1; power <= 1_000_000_000_000; power *= 10) {
  TOKEN_SPREAD.push(power - 1, power, power + 1);
}
let seed = 20260917;
for (let sample = 0; sample < 400; sample += 1) {
  seed = (seed * 48_271) % 2_147_483_647;
  TOKEN_SPREAD.push(seed % 10_000_000_000_000);
}
for (const style of TOKEN_NUMBER_STYLES) {
  for (const tokens of TOKEN_SPREAD) {
    assert.equal(
      renderReadout(resolveTokenFlowReadout(tokens, style)),
      formatTokens(tokens, style),
      `${style} tile reading for ${tokens}`,
    );
  }
}

// The unit word is what tells a surface the reading changed *scale*, so it has to be
// the unit the formatter actually printed - the same `.suffix` the freeze watches.
assert.equal(resolveTokenFlowReadout(300_000, 'en-compact')?.suffix, 'K');
assert.equal(resolveTokenFlowReadout(1_200_000_000, 'en-compact')?.suffix, 'B');
assert.equal(resolveTokenFlowReadout(300_000, 'zh')?.suffix, '万');
assert.equal(resolveTokenFlowReadout(120_000_000, 'zh')?.suffix, '亿');
assert.equal(resolveTokenFlowReadout(9_999, 'zh')?.suffix, '');
assert.equal(resolveTokenFlowReadout(1_234_567, 'full')?.suffix, '');
// The unit word travels beside the number, so the number is already scaled.
assert.equal(resolveTokenFlowReadout(1_200_000_000, 'en-compact')?.number, 1.2);
assert.equal(resolveTokenFlowReadout(120_000_000, 'zh')?.number, 1.2);
// A count the console cannot read is not a zero, in the animated form either.
assert.equal(resolveTokenFlowReadout(NaN, 'zh'), undefined);
assert.equal(resolveTokenFlowReadout(Infinity, 'en-compact'), undefined);
assert.equal(resolveCountFlowReadout(null), undefined);
assert.equal(resolveCountFlowReadout(undefined), undefined);
assert.equal(resolveTokenRateFlowReadout(null), undefined);

// The same claim for the plain counts and the token rate: the tile animates the value
// the caption, the tooltip and the trend already print.
for (const count of [0, 1, 999, 1_000, 1_234_567, 12_345_678_901]) {
  assert.equal(renderReadout(resolveCountFlowReadout(count)), formatTokensFull(count));
}
for (const rate of [0, 7, 999, 1_000, 12_345, 999_999, 1_200_000]) {
  assert.equal(renderReadout(resolveTokenRateFlowReadout(rate)), formatTokenRate(rate));
}
assert.equal(formatTokenRate(12_345), '12.35K');
assert.equal(formatTokenRate(NaN), '—');

// The cache tile reads off the same tenths the badge and the colour scale use, so the
// percentage sign is a suffix and the fraction digits follow the printed form's rule:
// an exact zero keeps no decimal, every other rate keeps its tenth.
for (const rate of [null, undefined, NaN, -5, 0, 0.04, 0.4, 40, 40.05, 40.5, 99.9, 100, 120]) {
  assert.equal(
    renderReadout(resolveCacheRateReadout(rate)),
    formatCacheRate(rate),
    `cache tile reading for ${String(rate)}`,
  );
}
assert.equal(resolveCacheRateReadout(40)?.format.minimumFractionDigits, 1);
assert.equal(resolveCacheRateReadout(0)?.format.minimumFractionDigits, 0);

console.log('token display: all assertions passed');
