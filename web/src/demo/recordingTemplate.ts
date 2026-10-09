import type { RecordingLanguage } from './pacing';

/**
 * Resolves a recording's template into the document one replay shows.
 *
 * A recording is taken once and replayed for as long as the demonstration runs, so nothing in it
 * may be a fixed date: "the last 7 days" has to end at the moment a visitor asks. Its strings
 * carry placeholders measured from that moment, and its sentences are written once per language.
 *
 *   {{ms:-168}}   the instant 168 hours before the anchor, in epoch milliseconds
 *   {{iso:-7}}    the UTC calendar day 7 days before the anchor, as YYYY-MM-DD
 *   {{md:-7}}     that day as a reader writes it, without the year
 *   {{ymd:-7}}    the same with the year
 *   {{hm}}        the anchor's UTC time of day
 *
 * A string that is exactly one `{{ms:…}}` placeholder becomes a number, because the fields that
 * hold instants are numbers on the wire. An object with exactly the keys `zh` and `en` is a
 * sentence in both languages and resolves to the one being read.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ENGLISH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WHOLE_INSTANT = /^\{\{ms:(-?\d+)\}\}$/;
const PLACEHOLDER = /\{\{(ms|iso|md|ymd|hm)(?::(-?\d+))?\}\}/g;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDay(instant: number, style: 'iso' | 'md' | 'ymd', language: RecordingLanguage): string {
  const date = new Date(instant);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if (style === 'iso') return `${year}-${pad(month + 1)}-${pad(day)}`;
  if (language === 'zh') return style === 'md' ? `${month + 1} 月 ${day} 日` : `${year} 年 ${month + 1} 月 ${day} 日`;
  return style === 'md' ? `${ENGLISH_MONTHS[month]} ${day}` : `${ENGLISH_MONTHS[month]} ${day}, ${year}`;
}

function resolveText(text: string, anchorMS: number, language: RecordingLanguage): string {
  return text.replace(PLACEHOLDER, (_match, kind: string, offset: string | undefined) => {
    const amount = Number(offset ?? 0);
    if (kind === 'ms') return String(anchorMS + amount * HOUR_MS);
    if (kind === 'hm') {
      const date = new Date(anchorMS);
      return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    }
    return formatDay(anchorMS + amount * DAY_MS, kind as 'iso' | 'md' | 'ymd', language);
  });
}

function isLocalized(value: object): value is Record<RecordingLanguage, unknown> {
  const keys = Object.keys(value);
  return keys.length === 2 && 'zh' in value && 'en' in value;
}

export function resolveRecording<T>(template: unknown, anchorMS: number, language: RecordingLanguage): T {
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const instant = WHOLE_INSTANT.exec(value);
      return instant ? anchorMS + Number(instant[1]) * HOUR_MS : resolveText(value, anchorMS, language);
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value === 'object' && value !== null) {
      if (isLocalized(value)) return resolve(value[language]);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    }
    return value;
  };
  return resolve(template) as T;
}
