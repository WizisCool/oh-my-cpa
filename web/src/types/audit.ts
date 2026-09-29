/** Shapes and pure helpers for the operator audit trail. */

export interface AuditEvent {
  id: number;
  occurred_at_ms: number;
  action: string;
  target_type: string;
  target_id: string;
  result: string;
  request_id: string;
  source_summary: string;
  details?: Record<string, unknown>;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Cursor for the next (older) page; absent on the last page. */
  nextCursor?: string;
}

export type AuditOutcome = 'all' | 'succeeded' | 'failed' | 'unfinished';

export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['all', 'succeeded', 'failed', 'unfinished'];

/** How far back the trail reads. `all` is the whole trail, which is append-only and never pruned. */
export type AuditRange = '24h' | '7d' | '30d' | 'all';

export const AUDIT_RANGES: Readonly<Record<AuditRange, number | undefined>> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  all: undefined,
};

export interface AuditFilters {
  /** Action categories (the action's first segment); empty keeps every category. */
  categories: string[];
  outcome: AuditOutcome;
  search: string;
  range: AuditRange;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = { categories: [], outcome: 'all', search: '', range: 'all' };

/** One page of the timeline. The server caps it at 200; fifty fills a screen twice. */
export const AUDIT_PAGE_SIZE = 50;

/**
 * The query the server reads. The window's start is resolved when the request is made,
 * so a relative range keeps meaning "the last 24 hours" on every refresh.
 */
export function auditSearchParams(filters: AuditFilters, now = Date.now()): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.categories.length > 0) search.set('category', filters.categories.join(','));
  if (filters.outcome !== 'all') search.set('outcome', filters.outcome);
  const needle = filters.search.trim();
  if (needle) search.set('q', needle);
  const span = AUDIT_RANGES[filters.range];
  if (span !== undefined) search.set('since_ms', String(Math.max(0, now - span)));
  return search;
}

/**
 * The console's categories, each the set of action prefixes it covers.
 *
 * A category is what an operator asks about ("who touched the keys"), which is not always
 * one action prefix: OAuth sign-ins and credential file edits are the same credentials.
 */
export const AUDIT_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  access: ['auth'],
  keys: ['api_key', 'client_key'],
  providers: ['provider'],
  credentials: ['auth_file', 'oauth', 'oauth_model_alias'],
  quota: ['quota'],
  config: ['config'],
  pricing: ['pricing'],
  plugins: ['plugin'],
  agent: ['capability'],
  system: ['system', 'logs', 'request_log', 'audit'],
};

export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

export function categoryOf(action: string): string | undefined {
  const prefix = action.split('.')[0];
  return Object.keys(AUDIT_CATEGORIES).find((category) => AUDIT_CATEGORIES[category].includes(prefix));
}

export type AuditTone = 'success' | 'warn' | 'danger' | 'accent' | 'neutral';

const RESULT_TONES: Record<string, AuditTone> = {
  success: 'success',
  checked: 'success',
  cached: 'success',
  admitted: 'accent',
  attempt: 'warn',
  prepared: 'accent',
  decision: 'neutral',
  failure: 'danger',
  error: 'danger',
  rejected: 'danger',
  denied: 'danger',
  uncertain: 'warn',
  partial: 'warn',
};

export function resultTone(result: string): AuditTone {
  return RESULT_TONES[result] ?? 'neutral';
}

/** Target ids that name a collection or a fixed singleton rather than a thing. */
const GENERIC_TARGETS = new Set([
  'list',
  'operator',
  'export',
  'config_source_yaml',
  'config_changes',
  'release_feed',
  'redacted_bundle',
  'management_logs',
]);
const OPAQUE_HEX = /^[0-9a-f]{24,}$/i;

/**
 * The part of a target worth printing in a sentence, or undefined.
 *
 * Keyed fingerprints and operation hashes identify a row for the machine, not for a
 * reader, so they are shortened or dropped; the full value stays in the detail view.
 */
export function readableTarget(event: AuditEvent): string | undefined {
  const target = event.target_id.trim();
  if (!target || GENERIC_TARGETS.has(target)) return undefined;
  if (event.target_type === 'capability_operation' || target.startsWith('client_key_alias:')) return undefined;
  if (OPAQUE_HEX.test(target)) return `${target.slice(0, 8)}…`;
  return target;
}

export interface AuditSource {
  ip?: string;
  userAgent?: string;
}

/** Splits the server's `ip=… ua=…` summary; the user agent is the rest of the line. */
export function parseAuditSource(summary: string): AuditSource {
  const source: AuditSource = {};
  const ip = summary.match(/(?:^|\s)ip=(\S+)/);
  if (ip) source.ip = ip[1];
  const ua = summary.match(/(?:^|\s)ua=(.+)$/);
  if (ua) source.userAgent = ua[1].trim();
  return source;
}

/** Renders one detail value for the detail view: scalars as text, structures as JSON. */
export function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object')) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Local calendar day of an instant, as a stable grouping key. */
export function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The console category whose prefixes are exactly the filter's, if any. */
export function selectedCategory(filters: AuditFilters): string | undefined {
  return Object.keys(AUDIT_CATEGORIES).find(
    (name) => AUDIT_CATEGORIES[name].join(',') === filters.categories.join(','),
  );
}

/**
 * readAuditFilters reads the audit page's filters from its URL, so a link (or Back) can
 * point at a filtered trail. The category is the console's name for it (`keys`), not the
 * prefixes it covers, and anything unrecognised falls back to the default rather than
 * becoming a filter that matches nothing.
 */
export function readAuditFilters(params: URLSearchParams): AuditFilters {
  const category = params.get('category') ?? '';
  const outcome = params.get('outcome') as AuditOutcome | null;
  const range = params.get('range') as AuditRange | null;
  return {
    categories: Object.prototype.hasOwnProperty.call(AUDIT_CATEGORIES, category) ? [...AUDIT_CATEGORIES[category]] : [],
    outcome: outcome && AUDIT_OUTCOMES.includes(outcome) ? outcome : DEFAULT_AUDIT_FILTERS.outcome,
    search: (params.get('q') ?? '').trim(),
    range: range && Object.prototype.hasOwnProperty.call(AUDIT_RANGES, range) ? range : DEFAULT_AUDIT_FILTERS.range,
  };
}

/** The inverse of readAuditFilters; a default value is left out of the URL. */
export function writeAuditFilters(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  const category = selectedCategory(filters);
  if (category) params.set('category', category);
  if (filters.outcome !== DEFAULT_AUDIT_FILTERS.outcome) params.set('outcome', filters.outcome);
  const needle = filters.search.trim();
  if (needle) params.set('q', needle);
  if (filters.range !== DEFAULT_AUDIT_FILTERS.range) params.set('range', filters.range);
  return params;
}

/** One cell of the server's summary: rows of one action prefix in one outcome class. */
export interface AuditBucket {
  prefix: string;
  outcome: 'succeeded' | 'failed' | 'unfinished' | 'other';
  count: number;
}

export interface AuditFacets {
  /** Rows per outcome, under the selected category. `all` includes the `other` class. */
  outcomes: Record<AuditOutcome, number>;
  /** Rows per console category, under the selected outcome. */
  categories: Record<string, number>;
  /** Rows in the window across every category and outcome. */
  total: number;
}

/**
 * auditFacets derives both filters' counts from the one summary matrix. Each facet holds
 * the other facet's selection and ignores its own, so a count always says what choosing
 * that option would return.
 */
export function auditFacets(buckets: readonly AuditBucket[], filters: AuditFilters): AuditFacets {
  const outcomes: Record<AuditOutcome, number> = { all: 0, succeeded: 0, failed: 0, unfinished: 0 };
  const categories: Record<string, number> = Object.fromEntries(Object.keys(AUDIT_CATEGORIES).map((name) => [name, 0]));
  let total = 0;
  for (const bucket of buckets) {
    total += bucket.count;
    const inCategory = filters.categories.length === 0 || filters.categories.includes(bucket.prefix);
    if (inCategory) {
      outcomes.all += bucket.count;
      if (bucket.outcome !== 'other') outcomes[bucket.outcome] += bucket.count;
    }
    const inOutcome = filters.outcome === 'all' || filters.outcome === bucket.outcome;
    const category = categoryOf(bucket.prefix);
    if (inOutcome && category) categories[category] += bucket.count;
  }
  return { outcomes, categories, total };
}
