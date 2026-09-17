/**
 * One layer for every user-facing token number in the console.
 *
 * Token values arrive from the API as exact integers and every surface - the
 * dashboard tiles, both model panels, the request list and the event drawer -
 * renders them through this module, so one switch changes every readout at
 * once and two surfaces can never disagree about how big "1.2B" is.
 *
 * **Two unit styles, because the operator's language is a fact about the
 * reader, not about the data.** `en-compact` is the international engineering
 * shorthand (300M, 1.2B); `zh` is the numeric scale Chinese financial and
 * technical reading actually uses (300万, 1.2亿). Both round the same way - one
 * decimal, trailing zeros trimmed - so the choice changes the words, not the
 * precision.
 *
 * The layer also owns the *full* form: tooltips and accessible names print the
 * exact count with separators, because a rounded value scanned in a chart is
 * fine while the same rounding in a tooltip would be a wrong number presented
 * as exact.
 */

import type { RollingReadout } from './rollingNumber';

/**
 * The stored preference values. `en-compact` is the default.
 *
 * The Chinese scale is a *language*, not just a notation: 亿 and 万 are words, so
 * it is meaningful only beside Chinese copy. `full` is language-neutral - grouped
 * digits with no unit word - which is why it is the one style that reads the same
 * in both consoles.
 */
export const TOKEN_NUMBER_STYLES = ['en-compact', 'zh', 'full'] as const;
export type TokenNumberStyle = (typeof TOKEN_NUMBER_STYLES)[number];

export const DEFAULT_TOKEN_NUMBER_STYLE: TokenNumberStyle = 'en-compact';

/** The stored preference values for the model panels' grouping view. */
export const MODEL_CHART_VIEWS = ['call', 'model'] as const;
export type ModelChartView = (typeof MODEL_CHART_VIEWS)[number];

export const DEFAULT_MODEL_CHART_VIEW: ModelChartView = 'call';

/**
 * parseTokenNumberStyle validates a stored preference.
 *
 * The value comes back from a JSON document the browser wrote, so it is input,
 * not state: anything unknown falls back to the default instead of rendering
 * in a style the formatter does not implement.
 */
export function parseTokenNumberStyle(raw: unknown): TokenNumberStyle | undefined {
  return typeof raw === 'string' && (TOKEN_NUMBER_STYLES as readonly string[]).includes(raw)
    ? (raw as TokenNumberStyle)
    : undefined;
}

/**
 * parseModelChartView validates a stored view preference the same way.
 *
 * `call` is the default: a call point is what the operator named and what a
 * client actually requests, and it is the view whose groups match the
 * deployment's own vocabulary rather than the upstream catalogue's.
 */
export function parseModelChartView(raw: unknown): ModelChartView | undefined {
  return typeof raw === 'string' && (MODEL_CHART_VIEWS as readonly string[]).includes(raw)
    ? (raw as ModelChartView)
    : undefined;
}

const COMPACT_EN = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * The abbreviation the dashboard's tokens-per-minute tile prints.
 *
 * TPM is a rate rather than a volume, so it does not follow the console's unit
 * style and keeps two decimals instead of one.
 */
const COMPACT_RATE = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

/**
 * The Chinese scale's steps, largest first. A value is divided by the largest
 * step it reaches, which keeps every readout to one unit word: 1.2万 rather
 * than 1.2万3千, because the latter is a reconstruction, not a reading.
 *
 * One step below 万 the reading continues in bare digits: a value like 999
 * gains nothing from "0.09万", and "999" is what the compact form already
 * prints.
 */
const ZH_STEPS: Array<{ limit: number; divisor: number; suffix: string }> = [
  { limit: 100_000_000, divisor: 100_000_000, suffix: '亿' },
  { limit: 10_000, divisor: 10_000, suffix: '万' },
];

/**
 * zhParts splits a token count into the number and the unit word the Chinese scale prints.
 *
 * `formatZh` and the animated readout both read the split, so a tile cannot round
 * differently from the text it stands in for.
 */
function zhParts(tokens: number): { number: number; suffix: string } {
  if (tokens < 10_000) return { number: Math.round(tokens), suffix: '' };
  for (const step of ZH_STEPS) {
    if (tokens < step.limit) continue;
    // One decimal, trailing zeros trimmed: 300万, 1.2亿, not 300.0万.
    return { number: Math.round((tokens / step.divisor) * 10) / 10, suffix: step.suffix };
  }
  // Unreachable: the loop covers every value >= 10_000.
  return { number: Math.round(tokens), suffix: '' };
}

function formatZh(tokens: number): string {
  const { number, suffix } = zhParts(tokens);
  return Number.isInteger(number) ? `${number}${suffix}` : `${number.toFixed(1)}${suffix}`;
}

const FULL = new Intl.NumberFormat('en');

/**
 * resolveTokenNumberStyle picks the style a surface actually renders in.
 *
 * A stored `zh` resolves back to the compact form whenever the reading language is
 * not Chinese, because an English console printing `12亿` beside an English legend
 * would mix two languages in one reading - the same defect `docs/design.md`
 * forbids for copy, applied to the one number format that carries a language.
 *
 * The *stored* value is deliberately left alone: it is the operator's choice, and
 * switching the console back to Chinese must restore it rather than silently
 * rewriting what they picked. Only the reading changes.
 *
 * `full` is language-neutral, so it renders as itself in both consoles.
 */
export function resolveTokenNumberStyle(style: TokenNumberStyle, lang: 'zh' | 'en'): TokenNumberStyle {
  if (style === 'zh' && lang !== 'zh') return DEFAULT_TOKEN_NUMBER_STYLE;
  return style;
}

/**
 * formatTokens renders a token count in the chosen unit style.
 *
 * Non-finite input renders as an em dash, the console's shared "no reading"
 * mark, because a NaN in a tile is a data fault rather than a number to round.
 */
export function formatTokens(tokens: number, style: TokenNumberStyle): string {
  if (!Number.isFinite(tokens)) return '—';
  if (style === 'full') return FULL.format(tokens);
  if (style === 'zh') return formatZh(tokens);
  return COMPACT_EN.format(tokens);
}

/**
 * formatTokensFull renders the exact count with digit separators, for tooltips
 * and accessible names where rounding would present an approximate value as
 * the exact one.
 */
export function formatTokensFull(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—';
  return FULL.format(tokens);
}

/**
 * splitFormatted reassembles a formatter's own output as a number plus its unit word.
 *
 * The abbreviation decisions - when to switch unit, how far to round - live in the
 * formatter, and reading them back out of `formatToParts` means a rolling readout
 * animates the digits the formatter chose rather than digits it re-derived.
 */
function splitFormatted(formatter: Intl.NumberFormat, value: number): { number: number; suffix: string } {
  let digits = '';
  let suffix = '';
  for (const part of formatter.formatToParts(value)) {
    if (part.type === 'integer' || part.type === 'fraction') digits += part.value;
    else if (part.type === 'decimal') digits += '.';
    else if (part.type === 'compact') suffix += part.value;
  }
  return { number: Number(digits), suffix };
}

/**
 * resolveCountFlowReadout is the animated form of a plain count - requests, requests
 * per minute - which the console prints as exact grouped digits.
 *
 * A count is not abbreviated and has no unit word, so the readout carries none: the
 * earlier reading and the next one are always the same scale. A missing count has no
 * reading at all, which is the same em dash the printed form uses.
 */
export function resolveCountFlowReadout(value: number | null | undefined): RollingReadout | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return { ...splitFormatted(FULL, value), format: { maximumFractionDigits: 3 } };
}

/**
 * resolveTokenFlowReadout is `formatTokens` as an animated readout.
 *
 * The unit word travels beside the number rather than inside it because two of the
 * three styles change it mid-scale - `en-compact` and `zh` both print a different
 * unit at a different magnitude, and that swap is what tells a surface the reading
 * changed scale rather than size.
 */
export function resolveTokenFlowReadout(tokens: number, style: TokenNumberStyle): RollingReadout | undefined {
  if (!Number.isFinite(tokens)) return undefined;
  if (style === 'full') return resolveCountFlowReadout(tokens);
  if (style === 'zh') {
    // Below 万 the printed form continues in bare digits, so grouping stays off
    // with it: "9999" is the reading, not "9,999".
    return { ...zhParts(tokens), format: { useGrouping: false, maximumFractionDigits: 1 } };
  }
  return { ...splitFormatted(COMPACT_EN, tokens), format: { maximumFractionDigits: 1 } };
}

/**
 * resolveTokenRateFlowReadout is the animated form of a token *rate* - tokens per minute.
 *
 * A rate keeps the compact style in every console language: the unit-word styles
 * describe a total, and `12万` beside a per-minute label would read as a quantity of
 * minutes rather than a rate.
 */
export function resolveTokenRateFlowReadout(value: number | null | undefined): RollingReadout | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return { ...splitFormatted(COMPACT_RATE, value), format: { maximumFractionDigits: 2 } };
}

/**
 * formatTokenRate renders a token rate for a surface that cannot animate - a trend
 * tooltip - in the same compact style the rate's tile prints.
 */
export function formatTokenRate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return COMPACT_RATE.format(value);
}

/**
 * formatCost renders a USD amount for a list readout.
 *
 * Four decimals, because request costs are commonly fractions of a cent and
 * two decimals would collapse a thousand small calls into "$0.00" - a row that
 * reads as free is a different claim from one that reads as cheap.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(4)}`;
}
