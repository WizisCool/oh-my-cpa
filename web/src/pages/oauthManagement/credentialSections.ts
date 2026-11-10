import { applyKeyOrder } from '../../types/displayOrder';
import type { MessageKey } from '../../i18n/catalog';
import { PRIMARY_CREDENTIAL_PROVIDERS } from '../../types/credentialProviders';
import type { QuotaWindow } from '../../types/quota';
import { orderQuotaWindows, quotaWindowGroupKey, quotaWindowKindOf } from '../quota/quotaWindowSelection';
import type { OAuthWorkspaceRecord } from './oauthWorkspaceLogic';

/**
 * The credential list as one table per provider, with two fixed quota columns.
 *
 * Whatever a provider calls its limits, nearly every one refills either within a day (the
 * five-hour window) or over a week, and those two are what an operator scans a fleet by. So every
 * section has the same two columns - the short limit and the long one - and each credential is one
 * row. A credential with more limits than that - Antigravity's Gemini 4 Argon beside its Gemini
 * group, Claude's per-model weekly limits beside its plan - gives each further family a line of its
 * own inside the row, in the same two columns, and every reading carries its own name. A line with a single
 * limit draws it across both columns, so a weekly-only plan reads as one long bar rather than an
 * empty five-hour cell beside a short one.
 *
 * Lines are derived from what each credential reports rather than declared per provider, which is
 * what keeps a new model group, an upstream provider the console has never named, or a plugin's
 * quota readable without a release.
 */
export type QuotaPeriod = 'five_hour' | 'daily' | 'weekly' | 'monthly';

/** Which of the two fixed columns a limit belongs in. */
export type QuotaSlot = 'short' | 'long';

export interface QuotaLineCell {
  /** The reading's identity within the credential, "family|period" or "family|id:…". */
  key: string;
  window: QuotaWindow;
  /** Undefined for a limit whose period is unknown; such a limit has a line of its own. */
  slot?: QuotaSlot;
  /** The line's only limit, drawn across both columns. */
  spans: boolean;
}

/** One family of a credential's limits: its short limit and its long one, side by side. */
export interface QuotaLine {
  key: string;
  scope: QuotaWindow['scope'];
  /** The group's, model's or allowance's own name; the plan and the code-review allowance are named by the console. */
  label?: string;
  cells: QuotaLineCell[];
}

export interface CredentialSection {
  provider: string;
  records: OAuthWorkspaceRecord[];
  visibleRecords: OAuthWorkspaceRecord[];
}

export interface QuotaColumnSort {
  key: string;
  direction: 'asc' | 'desc';
}

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

/** The family part of a cell key: "group:Gemini Models|five_hour" belongs to "group:Gemini Models". */
function familyKeyOfCell(cellKey: string): string {
  return cellKey.slice(0, cellKey.lastIndexOf('|'));
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

/**
 * Whether a quota family belongs in the credential list table.
 * Antigravity's "Claude and GPT" group quota is excluded from the list view so that
 * Gemini and Gemini 4 Argon can comfortably tile the available space without column squeeze;
 * the full breakdown remains viewable in the credential drawer's Quota tab.
 */
export function isListQuotaFamilyExcluded(provider: string | undefined, label: string | undefined): boolean {
  if (provider === 'antigravity' && label && /^claude and gpt(?:\s+models)?$/i.test(label.trim())) {
    return true;
  }
  return false;
}

/** The readings of one credential that the list table draws. */
function listedCellsOf(record: OAuthWorkspaceRecord, provider = record.displayProvider): [string, QuotaWindow][] {
  return [...quotaCellsOf(record.quota?.windows)].filter(([, window]) => !isListQuotaFamilyExcluded(provider, familyLabel(window)));
}

/** A limit that refills within a day is the short one; anything longer is the long one. */
function slotOf(window: QuotaWindow): QuotaSlot | undefined {
  const period = periodOf(window);
  if (period === 'five_hour' || period === 'daily') return 'short';
  if (period === 'weekly' || period === 'monthly') return 'long';
  if (window.period_hours != null) return window.period_hours <= 24 ? 'short' : 'long';
  return undefined;
}

/**
 * A credential's limits as lines, the plan first and then each family in the order the provider
 * reports them. A family's first short and first long limit share its line; a further limit in a
 * column its family already filled - Claude's third-party-apps weekly limit beside the plan's
 * weekly one - and a limit with no known period each get a line of their own, named by the limit.
 */
export function quotaLinesOf(record: OAuthWorkspaceRecord, provider = record.displayProvider): QuotaLine[] {
  const families = new Map<string, { line: QuotaLine; short?: QuotaLineCell; long?: QuotaLineCell; extras: QuotaLine[] }>();
  for (const [key, window] of listedCellsOf(record, provider)) {
    const familyKey = familyKeyOfCell(key);
    let family = families.get(familyKey);
    if (!family) {
      family = { line: { key: familyKey, scope: window.scope, label: familyLabel(window), cells: [] }, extras: [] };
      families.set(familyKey, family);
    }
    const slot = slotOf(window);
    if (slot && !family[slot]) {
      family[slot] = { key, window, slot, spans: false };
    } else {
      const label = slot ? modelLabel(window) : columnLabel(window);
      family.extras.push({ key, scope: window.scope, label, cells: [{ key, window, slot, spans: true }] });
    }
  }
  const lines: QuotaLine[] = [];
  for (const { line, short, long, extras } of families.values()) {
    const cells = [short, long].filter((cell): cell is QuotaLineCell => cell !== undefined);
    if (cells.length === 1) cells[0] = { ...cells[0], spans: true };
    if (cells.length > 0) lines.push({ ...line, cells });
    lines.push(...extras);
  }
  // The plan leads: it is the credential's own limit and what the column headers name.
  return lines.sort((left, right) => Number(right.scope === 'standard') - Number(left.scope === 'standard'));
}

/**
 * The readings a row draws, in order, each placed in a column or across both. The first line keeps
 * its columns - its short limit under "5 hours", its long one under "Weekly" - because that is the
 * line the headers and the sort describe. Further lines name every reading, so their single limits
 * are paired two to a line instead of each taking a full one; a family with two limits keeps its
 * own line, and a single limit left over draws across both columns.
 */
export function packQuotaLines(lines: QuotaLine[]): { line: QuotaLine; cell: QuotaLineCell }[] {
  const placed: { line: QuotaLine; cell: QuotaLineCell }[] = [];
  let pending: { line: QuotaLine; cell: QuotaLineCell } | undefined;
  const flush = () => {
    if (pending) placed.push({ ...pending, cell: { ...pending.cell, spans: true } });
    pending = undefined;
  };
  lines.forEach((line, index) => {
    if (index === 0 || line.cells.length > 1) {
      flush();
      for (const cell of line.cells) placed.push({ line, cell });
      return;
    }
    const [cell] = line.cells;
    if (!pending) {
      pending = { line, cell };
      return;
    }
    placed.push({ ...pending, cell: { ...pending.cell, slot: 'short', spans: false } });
    placed.push({ line, cell: { ...cell, slot: 'long', spans: false } });
    pending = undefined;
  });
  flush();
  return placed;
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
