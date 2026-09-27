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

export type AuditOutcome = 'all' | 'succeeded' | 'failed';

export interface AuditFilters {
  /** Action categories (the action's first segment); empty keeps every category. */
  categories: string[];
  outcome: AuditOutcome;
  search: string;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = { categories: [], outcome: 'all', search: '' };

/** One page of the timeline. The server caps it at 200; fifty fills a screen twice. */
export const AUDIT_PAGE_SIZE = 50;

export function auditSearchParams(filters: AuditFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.categories.length > 0) search.set('category', filters.categories.join(','));
  if (filters.outcome !== 'all') search.set('outcome', filters.outcome);
  const needle = filters.search.trim();
  if (needle) search.set('q', needle);
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
