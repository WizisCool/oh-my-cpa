/**
 * Re-basing the captured history onto the viewer's clock.
 *
 * The dataset is captured against one instant, and a demonstration that served those
 * timestamps unchanged would empty itself out: the console asks for "the last 24
 * hours", the captured answer describes a window that ended when the dataset was
 * generated, and within a day the newest chart is flat. So every response is moved
 * forward by a single delta as it is served.
 *
 * One delta for the whole response, rather than per field, is what keeps the panels
 * consistent with each other. A dashboard's window bounds, its bucket timestamps, its
 * tail's `as_of_ms` and the event rows a request list shows all describe the same span;
 * moving them independently would let a bucket start after the window it belongs to.
 */

/**
 * An instant, recognised by the naming convention this codebase already uses.
 *
 * Every timestamp field is spelled `*_at_ms`, so the rule covers a field that does not
 * exist yet - which matters more than it looks: the alternative is a list that a future
 * field can be added without, and a missed instant is not a missing value but a panel
 * drawing the capture date as though it were now.
 *
 * Durations are deliberately not matched: `latency_ms`, `ttft_ms` and `bucket_ms` are
 * also `_ms`, and shifting one would corrupt a measurement while leaving it plausible.
 */
const INSTANT_BY_NAME = /(?:^|_)at_ms$/;

/**
 * Instants whose names predate the convention, listed so the rule above can stay simple.
 */
const INSTANT_NAMED = new Set([
  't',
  'to_ms',
  'as_of_ms',
  'timestamp_ms',
  'latest_after',
  'from',
  'to',
  // Reported in seconds rather than milliseconds, detected by magnitude.
  'modified',
]);

/**
 * Instants written as text, in RFC 3339.
 */
const INSTANT_TEXT_NAMED = new Set([
  'exported_at',
  'time',
  'last_capture_at',
  'last_run_at',
]);

/**
 * Fields whose strings are prose that embeds instants, so they are rewritten in place.
 */
const PROSE_NAMED = new Set(['lines']);

/**
 * A complete RFC 3339 instant, and nothing else.
 *
 * This must be a full match. `Date.parse` is far too willing - it reads
 * `claude-haiku-4-5` as the 4th of May and `gpt-5` as a date in 2001 - so a rebase
 * driven by it silently rewrote a model name into a timestamp. The demonstration
 * rendered a catalogue of models named after dates until this was a pattern that
 * anchors at both ends.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 instant inside a rendered log line. */
const RFC3339_IN_PROSE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

const THOUSAND = 1000;
// Epoch milliseconds are around 1.7e12 today and epoch seconds around 1.7e9, so the
// two are three orders of magnitude apart and one threshold separates them safely.
const MILLIS_THRESHOLD = 1e11;

/** Parses a string only when it is entirely an instant. */
function parseInstant(text) {
  if (!RFC3339.test(text)) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Moves one instant held as a number, preserving the unit it was written in. */
function shiftNumber(value, deltaMs) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (Math.abs(value) < MILLIS_THRESHOLD) return value + deltaMs / THOUSAND;
  return value + deltaMs;
}

/** Moves one instant written as text, leaving anything else exactly as it was. */
function shiftText(value, deltaMs) {
  const parsed = parseInstant(value);
  if (parsed === undefined) return value;
  return new Date(parsed + deltaMs).toISOString();
}

/** Rewrites the instants embedded in a log line. */
function shiftProse(value, deltaMs) {
  if (typeof value !== 'string') return value;
  return value.replace(RFC3339_IN_PROSE, (match) => {
    const parsed = parseInstant(match);
    return parsed === undefined ? match : new Date(parsed + deltaMs).toISOString();
  });
}

/**
 * Re-bases one decoded response onto the viewer's clock.
 *
 * Arrays are walked and scalars are returned unchanged, so a nested structure is
 * covered without the caller describing it. A string is only ever moved when it is
 * entirely an instant, or when it sits under a field that is known to hold prose
 * containing instants.
 */
export function rebase(value, deltaMs) {
  if (Array.isArray(value)) {
    return value.map((item) => rebase(item, deltaMs));
  }
  if (value !== null && typeof value === 'object') {
    const moved = {};
    for (const [name, item] of Object.entries(value)) {
      if (INSTANT_BY_NAME.test(name) || INSTANT_NAMED.has(name)) {
        moved[name] = shiftNumber(item, deltaMs);
      } else if (INSTANT_TEXT_NAMED.has(name)) {
        moved[name] = shiftText(item, deltaMs);
      } else if (PROSE_NAMED.has(name)) {
        moved[name] = Array.isArray(item)
          ? item.map((line) => shiftProse(line, deltaMs))
          : shiftProse(item, deltaMs);
      } else {
        moved[name] = rebase(item, deltaMs);
      }
    }
    return moved;
  }
  return value;
}
