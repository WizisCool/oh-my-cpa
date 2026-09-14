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

/** The stored preference values. `en-compact` is the default. */
export const TOKEN_NUMBER_STYLES = ['en-compact', 'zh'] as const;
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

function formatZh(tokens: number): string {
  if (tokens < 10_000) return String(Math.round(tokens));
  for (const step of ZH_STEPS) {
    if (tokens < step.limit) continue;
    const scaled = tokens / step.divisor;
    // One decimal, trailing zeros trimmed: 300万, 1.2亿, not 300.0万.
    const rounded = Math.round(scaled * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${text}${step.suffix}`;
  }
  // Unreachable: the loop covers every value >= 10_000.
  return String(Math.round(tokens));
}

/**
 * formatTokens renders a token count in the chosen unit style.
 *
 * Non-finite input renders as an em dash, the console's shared "no reading"
 * mark, because a NaN in a tile is a data fault rather than a number to round.
 */
export function formatTokens(tokens: number, style: TokenNumberStyle): string {
  if (!Number.isFinite(tokens)) return '—';
  if (style === 'zh') return formatZh(tokens);
  return COMPACT_EN.format(tokens);
}

const FULL = new Intl.NumberFormat('en');

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
