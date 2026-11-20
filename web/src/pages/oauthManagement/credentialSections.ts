import { applyKeyOrder } from '../../types/displayOrder';
import type { MessageKey } from '../../i18n/catalog';
import { PRIMARY_CREDENTIAL_PROVIDERS } from '../../types/credentialProviders';
import {
  formatQuotaDuration,
  inferQuotaWindowKind,
  packQuotaLines,
  quotaCellsOf,
  quotaDetailWindowFullName,
  quotaDetailWindowName,
  quotaLinesFromCells,
  quotaReadingLabels,
  quotaReadingName,
  type QuotaLine,
  type QuotaLineCell,
  type QuotaPeriod,
  type QuotaSlot,
} from '../quota/quotaWindowNaming';
import type { OAuthWorkspaceRecord } from './oauthWorkspaceLogic';

export {
  formatQuotaDuration,
  inferQuotaWindowKind,
  packQuotaLines,
  quotaCellsOf,
  quotaDetailWindowFullName,
  quotaDetailWindowName,
  quotaReadingLabels,
  quotaReadingName,
  type QuotaLine,
  type QuotaLineCell,
  type QuotaPeriod,
  type QuotaSlot,
};

/**
 * The credential list as one table per provider, with two fixed quota columns.
 *
 * Whatever a provider calls its limits, nearly every one refills either within a day (the
 * five-hour window) or over a week, and those two are what an operator scans a fleet by. So every
 * section has the same two columns - the short limit and the long one - and each credential is one
 * row. A credential with more limits than that - Antigravity's model groups (Gemini, Claude and
 * GPT, Gemini 4 Argon), Claude's per-model weekly limits beside its plan - gives each further
 * family a line of its own inside the row, in the same two columns, and every reading carries its
 * own name. A line with a single limit draws it across both columns, so a weekly-only plan reads
 * as one long bar rather than an empty five-hour cell beside a short one.
 *
 * Lines are derived from what each credential reports rather than declared per provider, which is
 * what keeps a new model group, an upstream provider the console has never named, or a plugin's
 * quota readable without a release.
 */

export interface CredentialSection {
  provider: string;
  records: OAuthWorkspaceRecord[];
  visibleRecords: OAuthWorkspaceRecord[];
}

export interface QuotaColumnSort {
  key: string;
  direction: 'asc' | 'desc';
}

/**
 * A credential's limits as lines, the plan first and then each family in the order the provider
 * reports them. A family's first short and first long limit share its line; a further limit in a
 * column its family already filled - Claude's third-party-apps weekly limit beside the plan's
 * weekly one - and a limit with no known period each get a line of their own, named by the limit.
 */
export function quotaLinesOf(record: OAuthWorkspaceRecord): QuotaLine[] {
  return quotaLinesFromCells(quotaCellsOf(record.quota?.windows));
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

/**
 * The providers a set of records has, each once, in the console's fixed section order. This is the
 * list an operator's section arrangement is applied to: rearranging providers rather than the page on
 * screen is what keeps a section on the same side of every page boundary.
 */
export function providersInSectionOrder(records: readonly OAuthWorkspaceRecord[]): string[] {
  return [...new Set(records.map((record) => record.displayProvider))].sort(compareSections);
}

/** The sections in the operator's arrangement, every provider it does not name in the fixed order. */
function orderSections(
  sections: [string, OAuthWorkspaceRecord[]][],
  sectionOrder: readonly string[] | undefined,
): [string, OAuthWorkspaceRecord[]][] {
  const fixed = [...sections].sort(([left], [right]) => compareSections(left, right));
  return applyKeyOrder(fixed, ([provider]) => provider, sectionOrder);
}

/** The lines a credential draws, as one comparable key; empty without a reading. */
function listedFamiliesOf(record: OAuthWorkspaceRecord): string[] {
  return quotaLinesOf(record).map((line) => line.key).sort();
}

/**
 * A stable partition of one provider's credentials by plan shape: the credentials that report the
 * most families first, the ones with no reading yet last, and the chosen order kept inside each.
 * The richer plan leads because its row has no empty cell to explain.
 */
function clusterByShape(records: OAuthWorkspaceRecord[]): OAuthWorkspaceRecord[] {
  const signatures = new Map(records.map((record) => {
    const families = listedFamiliesOf(record);
    return [record.key, { count: families.length, signature: families.join('\n') }];
  }));
  return [...records].sort((left, right) => {
    const a = signatures.get(left.key)!;
    const b = signatures.get(right.key)!;
    return b.count - a.count || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);
  });
}

/**
 * Section order stays fixed unless the operator arranged the sections, in which case the whole list
 * follows that arrangement. Inside a section an active quota sort orders the provider's full filtered
 * records; otherwise its credentials are grouped by plan shape in the chosen order, and the custom
 * order, when given, puts the credentials the operator arranged first in their order.
 */
export function orderBySection(
  records: OAuthWorkspaceRecord[],
  columnSorts: Readonly<Partial<Record<string, QuotaColumnSort>>> = {},
  customOrder?: Readonly<Record<string, readonly string[]>>,
  sectionOrder?: readonly string[],
): OAuthWorkspaceRecord[] {
  const sections = new Map<string, OAuthWorkspaceRecord[]>();
  for (const record of records) {
    const rows = sections.get(record.displayProvider) ?? [];
    rows.push(record);
    sections.set(record.displayProvider, rows);
  }
  return orderSections([...sections.entries()], sectionOrder)
    .flatMap(([provider, rows]) => {
      const sort = columnSorts[provider];
      if (sort) return sortByQuotaColumn(rows, sort.direction);
      const clustered = clusterByShape(rows);
      return customOrder ? applyKeyOrder(clustered, credentialOrderKey, customOrder[provider]) : clustered;
    });
}

/** What the custom order stores for a credential: its file name, which is how CPA names it. */
export function credentialOrderKey(record: OAuthWorkspaceRecord): string {
  return record.file.name;
}

/**
 * The groups a page shows, in the same provider order the pages were cut in: each with the page's
 * records of the provider and every one of its records the filters let through, which a group's
 * selection and keyboard reordering reach across pages.
 */
export function buildCredentialSections(
  pageRecords: OAuthWorkspaceRecord[],
  visibleRecords: OAuthWorkspaceRecord[],
  sectionOrder?: readonly string[],
): CredentialSection[] {
  const sections = new Map<string, OAuthWorkspaceRecord[]>();
  for (const record of pageRecords) {
    const rows = sections.get(record.displayProvider) ?? [];
    rows.push(record);
    sections.set(record.displayProvider, rows);
  }
  return orderSections([...sections.entries()], sectionOrder)
    .map(([provider, records]) => ({
      provider,
      records,
      visibleRecords: visibleRecords.filter((record) => record.displayProvider === provider),
    }));
}

/**
 * The quota header's sort: by the share left in each credential's tightest listed limit, which is
 * the one that stops it first. Credentials without a reading sort last whichever way it runs.
 */
export function sortByQuotaColumn(records: OAuthWorkspaceRecord[], direction: 'asc' | 'desc'): OAuthWorkspaceRecord[] {
  // Each record's line model is built once, not twice per comparison.
  const values = new Map(records.map((record) => {
    const shares = quotaLinesOf(record).flatMap((line) => line.cells)
      .map(({ window }) => window.remaining_percent ?? (window.used_percent != null ? 100 - window.used_percent : undefined))
      .filter((share): share is number => share != null);
    return [record, shares.length > 0 ? Math.min(...shares) : undefined] as const;
  }));
  return [...records].sort((left, right) => {
    const a = values.get(left);
    const b = values.get(right);
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
  if (record.file.requires_sign_in) return status('warn', 'recovery.sign_in_required', { needsReauth: true });
  switch (record.quotaCondition) {
    case 'reauth': return status('danger', 'omc.status_reauth', { needsReauth: true });
    case 'cooldown': return status('danger', 'quota.status_cooldown');
    case 'exhausted': return status('danger', 'quota.status_exceeded');
    default: break;
  }
  if (isProblem) return status('warn', 'af.status_problem');
  switch (record.quotaCondition) {
    case 'error': return status('warn', 'omc.status_read_failed', { canRefreshFix: true });
    case 'stale': return status('neutral', 'quota.status_stale', { canRefreshFix: true });
    case 'loading': return status('accent', 'common.loading');
    default: return status('success', 'quota.status_normal');
  }
}
