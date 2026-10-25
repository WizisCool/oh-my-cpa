import type { MessageKey } from '../../i18n/catalog';
import { PRIMARY_CREDENTIAL_PROVIDERS } from '../../types/credentialProviders';
import type { QuotaWindow } from '../../types/quota';
import { orderQuotaWindows, quotaWindowGroupKey, quotaWindowKindOf } from '../quota/quotaWindowSelection';
import type { OAuthWorkspaceRecord } from './oauthWorkspaceLogic';

/**
 * The credential list as one table per provider.
 *
 * Credentials of one provider share one quota shape - every Antigravity account reports the same
 * model groups, every Codex account the same plan windows - while different providers share almost
 * nothing. So the shape belongs in a section's header, once, and each credential is one row whose
 * quota cells hold only a reading. Columns are derived from what the section's credentials
 * actually report rather than declared per provider, which is what keeps a new model group, an
 * upstream provider the console has never named, or a plugin's quota readable without a release.
 */

export type QuotaPeriod = 'five_hour' | 'daily' | 'weekly' | 'monthly';

export interface QuotaColumn {
  key: string;
  /** A named period, or undefined when the provider's own window label names the column. */
  period?: QuotaPeriod;
  /** The provider's label for a column whose period has no name. */
  label?: string;
}

export interface QuotaFamilyHeader {
  key: string;
  scope: QuotaWindow['scope'];
  /** The group's or model's own name; the plan and the code-review allowance are named by the console. */
  label?: string;
  columns: QuotaColumn[];
}

export interface CredentialSection {
  provider: string;
  records: OAuthWorkspaceRecord[];
  visibleRecords: OAuthWorkspaceRecord[];
  families: QuotaFamilyHeader[];
}

export interface QuotaColumnSort {
  key: string;
  direction: 'asc' | 'desc';
}

const PERIOD_RANK: Record<QuotaPeriod, number> = { five_hour: 0, daily: 1, weekly: 2, monthly: 3 };

function periodOf(window: QuotaWindow): QuotaPeriod | undefined {
  const kind = quotaWindowKindOf(window);
  return kind === 'five_hour' || kind === 'daily' || kind === 'weekly' || kind === 'monthly' ? kind : undefined;
}

/** "Gemini Models · Weekly Limit" is the group "Gemini"; "Gemini 4 Argon" keeps its whole name. */
function groupLabel(window: QuotaWindow): string {
  const group = window.label.split(' · ')[0].trim();
  return group.replace(/\s+models$/i, '') || group;
}

/** "Sonnet 每周用量" and "GPT-5-Codex-Spark 5小时配额" name their model before the period phrase. */
function modelLabel(window: QuotaWindow): string {
  const name = window.label.replace(/\s+\S*(?:配额|用量|限额|限制|limit|usage)\S*$/i, '').trim();
  return name || window.model || window.label;
}

function familyLabel(window: QuotaWindow): string | undefined {
  if (window.scope === 'group') return groupLabel(window);
  if (window.scope === 'model') return modelLabel(window);
  return undefined;
}

/** What a column says when its period has no name: the window's label without its group prefix. */
function columnLabel(window: QuotaWindow): string {
  const parts = window.label.split(' · ');
  return (parts.length > 1 ? parts.slice(1).join(' · ') : window.label).trim();
}

/**
 * Each window of one credential, keyed by the column it belongs in.
 *
 * A window takes its family's column for its period. When a credential reports a second window
 * for a period its family already filled - Claude's third-party-apps weekly limit beside the plan's
 * weekly limit - the later one is keyed by its id, so it becomes a column of its own rather than
 * overwriting the first. Windows with no nameable period are always keyed by id.
 */
export function quotaCellsOf(windows: QuotaWindow[] | undefined): Map<string, QuotaWindow> {
  const cells = new Map<string, QuotaWindow>();
  const seenIds = new Set<string>();
  for (const window of orderQuotaWindows(windows ?? [])) {
    const family = quotaWindowGroupKey(window);
    // A provider can repeat a bucket; two readings of one window id are one window, the first kept.
    const identity = `${family}|${window.id}`;
    if (window.id && seenIds.has(identity)) continue;
    seenIds.add(identity);
    const period = periodOf(window);
    const periodKey = period ? `${family}|${period}` : undefined;
    const key = periodKey && !cells.has(periodKey) ? periodKey : `${family}|id:${window.id}`;
    if (!cells.has(key)) cells.set(key, window);
  }
  return cells;
}

/** The section's families in the order its credentials report them, each with its columns. */
export function quotaFamiliesOf(records: OAuthWorkspaceRecord[]): QuotaFamilyHeader[] {
  const families = new Map<string, QuotaFamilyHeader & { order: Map<string, number> }>();
  for (const record of records) {
    for (const [key, window] of quotaCellsOf(record.quota?.windows)) {
      const familyKey = key.slice(0, key.lastIndexOf('|'));
      let family = families.get(familyKey);
      if (!family) {
        family = { key: familyKey, scope: window.scope, label: familyLabel(window), columns: [], order: new Map() };
        families.set(familyKey, family);
      }
      if (family.order.has(key)) continue;
      family.order.set(key, family.order.size);
      const period = key.includes('|id:') ? undefined : periodOf(window);
      family.columns.push(period ? { key, period } : { key, label: columnLabel(window) });
    }
  }
  return [...families.values()].map(({ order, ...family }) => ({
    ...family,
    columns: [...family.columns].sort((left, right) => (
      (left.period ? PERIOD_RANK[left.period] : 9) - (right.period ? PERIOD_RANK[right.period] : 9)
        || order.get(left.key)! - order.get(right.key)!
    )),
  }));
}

/**
 * Where a provider's section sits: the pinned providers in the console's fixed order, then every
 * other provider - an upstream one the console has not named, or a plugin's - alphabetically. The
 * order never depends on counts or health, so a section does not move while the operator works.
 */
export function sectionRank(provider: string): number {
  const pinned = PRIMARY_CREDENTIAL_PROVIDERS.indexOf(provider);
  return pinned >= 0 ? pinned : PRIMARY_CREDENTIAL_PROVIDERS.length;
}

export function compareSections(left: string, right: string): number {
  return sectionRank(left) - sectionRank(right) || left.localeCompare(right);
}

/** Section order stays fixed; an active quota sort orders the provider's full filtered records. */
export function orderBySection(records: OAuthWorkspaceRecord[], columnSorts: Readonly<Partial<Record<string, QuotaColumnSort>>> = {}): OAuthWorkspaceRecord[] {
  const sections = new Map<string, OAuthWorkspaceRecord[]>();
  for (const record of records) {
    const rows = sections.get(record.displayProvider) ?? [];
    rows.push(record);
    sections.set(record.displayProvider, rows);
  }
  return [...sections.entries()]
    .sort(([left], [right]) => compareSections(left, right))
    .flatMap(([provider, rows]) => {
      const sort = columnSorts[provider];
      return sort ? sortByQuotaColumn(rows, sort.key, sort.direction) : rows;
    });
}

/**
 * The sections a page shows. Rows are the page's records; columns come from every visible record
 * of the provider, so paging through a section never adds or drops a column.
 */
export function buildCredentialSections(pageRecords: OAuthWorkspaceRecord[], visibleRecords: OAuthWorkspaceRecord[]): CredentialSection[] {
  const sections = new Map<string, OAuthWorkspaceRecord[]>();
  for (const record of pageRecords) {
    const rows = sections.get(record.displayProvider) ?? [];
    rows.push(record);
    sections.set(record.displayProvider, rows);
  }
  return [...sections.entries()]
    .sort(([left], [right]) => compareSections(left, right))
    .map(([provider, records]) => {
      const providerRecords = visibleRecords.filter((record) => record.displayProvider === provider);
      return { provider, records, visibleRecords: providerRecords, families: quotaFamiliesOf(providerRecords) };
    });
}

/** A column's reading for sorting: missing readings sort last whichever way the column is sorted. */
export function sortByQuotaColumn(records: OAuthWorkspaceRecord[], columnKey: string, direction: 'asc' | 'desc'): OAuthWorkspaceRecord[] {
  const valueOf = (record: OAuthWorkspaceRecord) => quotaCellsOf(record.quota?.windows).get(columnKey)?.remaining_percent;
  return [...records].sort((left, right) => {
    const a = valueOf(left);
    const b = valueOf(right);
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    return direction === 'asc' ? a - b : b - a;
  });
}

export interface CredentialStatus {
  tone: 'success' | 'warn' | 'danger' | 'accent' | 'neutral';
  labelKey: MessageKey;
  /** The reading is out of date or failed, and a fresh read is the operator's fix. */
  canRefreshFix: boolean;
  /** The provider rejected the sign-in; signing in again is the fix. */
  needsReauth: boolean;
}

/**
 * One state per credential, read from both the credential and its quota.
 *
 * The switch beside it already says whether the credential is on, so "enabled" is not a state worth
 * a word: a healthy credential reads "Normal", and every other label names the one thing that stops
 * it serving, most blocking first. A credential the operator turned off reads as off whatever its
 * last quota reading said, because that reading is not being acted on.
 */
export function credentialStatusOf(record: OAuthWorkspaceRecord, isDisabled: boolean, isProblem: boolean): CredentialStatus {
  const status = (tone: CredentialStatus['tone'], labelKey: MessageKey, extra: Partial<CredentialStatus> = {}): CredentialStatus => (
    { tone, labelKey, canRefreshFix: false, needsReauth: false, ...extra }
  );
  if (record.file.runtime_only) return status('neutral', 'af.runtime_only_badge');
  if (isDisabled) return status('neutral', 'af.disabled');
  switch (record.quotaCondition) {
    case 'reauth': return status('danger', 'omc.status_reauth', { needsReauth: true });
    case 'cooldown': return status('danger', 'quota.status_cooldown');
    case 'exhausted': return status('danger', 'quota.status_exceeded');
    default: break;
  }
  if (isProblem) return status('warn', 'af.status_problem');
  switch (record.quotaCondition) {
    case 'warning': return status('warn', 'quota.status_warning');
    case 'error': return status('warn', 'omc.status_read_failed', { canRefreshFix: true });
    case 'stale': return status('neutral', 'quota.status_stale', { canRefreshFix: true });
    case 'loading': return status('accent', 'common.loading');
    default: return status('success', 'quota.status_normal');
  }
}
