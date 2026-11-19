import type { MessageKey, TFunc } from '../../i18n/catalog';
import type { QuotaWindow } from '../../types/quota';
import { quotaWindowLabel } from './quotaFormat';
import { orderQuotaWindows, quotaWindowGroupKey, quotaWindowKindOf, quotaWindowParts } from './quotaWindowSelection';

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
  /** Distinguishes separate allowances that share a group and period. */
  allowanceName?: string;
}

/** One family of a credential's limits: its short limit and its long one, side by side. */
export interface QuotaLine {
  key: string;
  scope: QuotaWindow['scope'];
  /** The group's, model's or allowance's own name; the plan and the code-review allowance are named by the console. */
  label?: string;
  cells: QuotaLineCell[];
}

const PERIOD_KEYS: Record<QuotaPeriod, MessageKey> = {
  five_hour: 'quota.slot_five_hour', daily: 'quota.slot_daily', weekly: 'quota.slot_weekly', monthly: 'quota.slot_monthly',
};

function knownStandardAllowanceFamily(window: Pick<QuotaWindow, 'id' | 'label'>, t: TFunc): string | undefined {
  if (window.id === 'seven_day_oauth_apps') return t('omc.quota_family_oauth_apps');
  if (window.id === 'seven_day_cowork') return 'Cowork';
  return undefined;
}

/**
 * Infers a window's period kind from its id and upstream label when a compact endpoint (such as
 * warmup catalog windows) omits `kind` and `period_hours`.
 */
export function inferQuotaWindowKind(id: string | undefined, label: string): QuotaWindow['kind'] {
  const lowerId = (id ?? '').toLowerCase();
  const lowerLabel = label.toLowerCase();
  if (lowerId === 'xai_credit_usage' || lowerLabel.includes('credit usage') || label.includes('额度总使用率')) return 'credit_usage';
  if (lowerId === 'five_hour' || lowerId.endsWith('_5h') || /\b5[- ]?hours?\b|\b5h\b/.test(lowerLabel) || label.includes('5小时')) return 'five_hour';
  if (lowerId.includes('daily') || /\bdaily\b|\b24h\b/.test(lowerLabel) || /每日|每天/.test(label)) return 'daily';
  if (lowerId === 'weekly' || lowerId === 'seven_day' || lowerId.endsWith('_week') || lowerId.endsWith('_7d') || /\bweekly\b|\b7d\b/.test(lowerLabel) || label.includes('每周')) return 'weekly';
  if (lowerId.includes('monthly') || lowerId.endsWith('_month') || lowerId.endsWith('_30d') || /\bmonthly\b|\b30d\b/.test(lowerLabel) || label.includes('每月')) return 'monthly';
  return undefined;
}

/**
 * Rounds an exact positive duration in hours for display: sub-hour custom windows retain two decimal
 * places (`0.05h`, `0.25h`), while >= 1h durations absorb minor upstream clock jitter (`28860s -> 8h`).
 */
export function roundQuotaPeriodHours(hours: number): number {
  return hours >= 1 ? Math.round(hours * 10) / 10 : Math.round(hours * 100) / 100 || hours;
}

/**
 * Formats an arbitrary positive window duration in hours into the active console locale,
 * keeping exact whole-day periods concise (`7d` / `2d`) and sub-day/custom spans in hours (`8h`).
 */
export function formatQuotaDuration(hours: number | undefined, t: TFunc): string | undefined {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return undefined;
  const rounded = roundQuotaPeriodHours(hours);
  if (rounded >= 24 && rounded % 24 === 0) return t('quota.duration_days', { n: rounded / 24 });
  return t('quota.duration_hours', { n: rounded });
}

function legacySlotFallbackName(window: Pick<QuotaWindow, 'id' | 'label' | 'period_hours'>, t: TFunc): string | undefined {
  if (window.period_hours != null && window.period_hours > 0) return undefined;
  const label = window.label.trim();
  if (label === '5小时用量上限 (5-Hour)') return t('quota.window_five_hour');
  if (label === '每周用量上限 (Weekly)') return t('quota.window_weekly');
  return undefined;
}

function customPeriodText(window: QuotaWindow, t: TFunc): string | undefined {
  return formatQuotaDuration(window.period_hours, t);
}

function periodOf(window: QuotaWindow): QuotaPeriod | undefined {
  const kind = quotaWindowKindOf(window);
  if (kind === 'five_hour' || kind === 'daily' || kind === 'weekly' || kind === 'monthly') return kind;
  if (window.period_hours == null) {
    const inferred = inferQuotaWindowKind(window.id, window.label);
    if (inferred === 'five_hour' || inferred === 'daily' || inferred === 'weekly' || inferred === 'monthly') return inferred;
  }
  return undefined;
}

/** The group "Gemini Models" reads as "Gemini"; "Gemini 4 Argon" keeps its whole name. */
function groupLabel(window: QuotaWindow): string {
  const group = quotaWindowParts(window).group ?? window.label;
  return group.replace(/\s+models$/i, '') || group;
}

/** "Sonnet 每周用量" and "GPT-5-Codex-Spark 5小时配额" name their model before the period phrase. */
function modelLabel(window: QuotaWindow): string {
  const name = window.label
    .replace(/\s+\S*(?:配额|用量|限额|限制|limit|usage)\S*$/i, '')
    .replace(/\s+(?:5\s*小时|每日|每天|每周|每月|\d+(?:\.\d+)?\s*(?:分钟|小时|天|hours?|days?|d|h|m)|5-?hour|daily|weekly|monthly)\s*$/i, '')
    .trim();
  return name || window.model || window.label;
}

export function quotaFamilyLabel(window: QuotaWindow): string | undefined {
  if (window.scope === 'group') return groupLabel(window);
  if (window.scope === 'model') return modelLabel(window);
  return undefined;
}

/** What a column says when its period has no name: the window's own name without its group. */
function columnLabel(window: QuotaWindow): string {
  return quotaWindowParts(window).name;
}

/** The family part of a cell key: "group:Gemini Models|five_hour" belongs to "group:Gemini Models". */
function familyKeyOfCell(cellKey: string): string {
  return cellKey.slice(0, cellKey.lastIndexOf('|'));
}

function slotOf(window: QuotaWindow): QuotaSlot | undefined {
  const period = periodOf(window);
  if (period === 'five_hour' || period === 'daily') return 'short';
  if (period === 'weekly' || period === 'monthly') return 'long';
  if (window.period_hours != null) return window.period_hours <= 24 ? 'short' : 'long';
  return undefined;
}

function lineTitle(line: QuotaLine, cell: QuotaLineCell, t: TFunc): string {
  if (line.scope === 'model') return modelLabel(cell.window);
  if (line.label) return line.label;
  return t(line.scope === 'code_review' ? 'omc.quota_family_code_review' : 'omc.quota_family_plan');
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
 * Groups pre-filtered quota cells into display lines, placing the credential's own plan first and
 * pairing short/long windows per family while keeping extra/untyped windows on their own lines.
 */
export function quotaLinesFromCells(entries: Iterable<[string, QuotaWindow]>): QuotaLine[] {
  const families = new Map<string, { line: QuotaLine; short?: QuotaLineCell; long?: QuotaLineCell; extras: QuotaLine[] }>();
  const groupPeriods = new Map<string, QuotaLineCell[]>();
  for (const [key, window] of entries) {
    const familyKey = familyKeyOfCell(key);
    let family = families.get(familyKey);
    if (!family) {
      family = { line: { key: familyKey, scope: window.scope, label: quotaFamilyLabel(window), cells: [] }, extras: [] };
      families.set(familyKey, family);
    }
    const slot = slotOf(window);
    const cell: QuotaLineCell = { key, window, slot, spans: false };
    const period = periodOf(window);
    if (window.scope === 'group' && period) {
      const periodKey = `${familyKey}|${period}`;
      const siblings = groupPeriods.get(periodKey) ?? [];
      siblings.push(cell);
      groupPeriods.set(periodKey, siblings);
    }
    if (slot && !family[slot]) {
      family[slot] = cell;
    } else {
      const label = window.scope === 'group' ? groupLabel(window) : slot ? modelLabel(window) : columnLabel(window);
      cell.spans = true;
      family.extras.push({ key, scope: window.scope, label, cells: [cell] });
    }
  }
  for (const siblings of groupPeriods.values()) {
    if (siblings.length > 1) {
      for (const cell of siblings) cell.allowanceName = columnLabel(cell.window);
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

/** The plan's limits are named by their period; any other by its period and name, or its name alone. */
export function quotaReadingName(line: QuotaLine, cell: QuotaLineCell, t: TFunc): string {
  if (cell.window.id === 'xai_credit_usage' || quotaWindowKindOf(cell.window) === 'credit_usage') {
    return t('quota.window_credit_usage');
  }
  const kind = periodOf(cell.window);
  const period = kind ? t(PERIOD_KEYS[kind]) : undefined;
  const knownAllowance = knownStandardAllowanceFamily(cell.window, t);
  if (knownAllowance) {
    return period ? t('omc.quota_reading_name', { family: knownAllowance, period }) : knownAllowance;
  }
  if (line.scope === 'standard' && !line.label) {
    return period ?? customPeriodText(cell.window, t) ?? legacySlotFallbackName(cell.window, t) ?? cell.window.label;
  }
  const family = line.scope === 'group' ? groupLabel(cell.window) : lineTitle(line, cell, t);
  const periodText = period ?? (line.scope === 'model' || line.scope === 'code_review' ? customPeriodText(cell.window, t) : undefined);
  const name = periodText
    ? t('omc.quota_reading_name', { family, period: periodText })
    : (line.scope === 'model' || line.scope === 'code_review' ? cell.window.label : family);
  const allowance = line.scope === 'group' ? cell.allowanceName ?? (!period ? columnLabel(cell.window) : undefined) : undefined;
  return allowance && allowance !== family ? t('omc.quota_allowance_name', { name, allowance }) : name;
}

/**
 * Resolves localized reading names for every window in a credential using the shared line/cell
 * model without page-specific credential list exclusions.
 */
export function quotaReadingLabels(windows: readonly QuotaWindow[], t: TFunc): Map<string, string> {
  const labels = new Map<string, string>();
  const lines = quotaLinesFromCells(quotaCellsOf([...windows]));
  for (const line of lines) {
    for (const cell of line.cells) {
      if (cell.window.id && !labels.has(cell.window.id)) {
        labels.set(cell.window.id, quotaReadingName(line, cell, t));
      }
    }
  }
  return labels;
}

function groupAllowanceDiscriminator(window: QuotaWindow, siblings: readonly QuotaWindow[] | undefined): string | undefined {
  if (window.scope !== 'group' || !siblings?.length) return undefined;
  const period = periodOf(window);
  if (!period) return undefined;
  const group = quotaWindowParts(window).group;
  const hasSamePeriodSibling = siblings.some(
    (other) => other !== window
      && other.scope === 'group'
      && (!other.id || !window.id || other.id !== window.id)
      && quotaWindowParts(other).group === group
      && periodOf(other) === period,
  );
  if (!hasSamePeriodSibling) return undefined;
  const allowance = columnLabel(window);
  return allowance && allowance !== groupLabel(window) ? allowance : undefined;
}

/**
 * Localized name for a window in detail surfaces (Credential Drawer cards, Capacity dialog, Warmup
 * window picker, Dashboard tooltip): keeps full window-limit phrasing for standard/grouped windows
 * while translating model-scoped, code-review, and secondary allowances identically to the list.
 */
export function quotaDetailWindowName(window: QuotaWindow, t: TFunc, siblings?: readonly QuotaWindow[]): string {
  const kind = quotaWindowKindOf(window);
  if (window.scope === 'group') {
    const base = quotaWindowLabel(kind, columnLabel(window), t);
    const allowance = groupAllowanceDiscriminator(window, siblings);
    return allowance ? t('omc.quota_allowance_name', { name: base, allowance }) : base;
  }
  if (window.id === 'xai_credit_usage' || kind === 'credit_usage') {
    return quotaWindowLabel('credit_usage', window.label, t);
  }
  const knownAllowance = knownStandardAllowanceFamily(window, t);
  if (knownAllowance || window.scope === 'model' || window.scope === 'code_review') {
    const periodKind = periodOf(window);
    const period = periodKind ? t(PERIOD_KEYS[periodKind]) : customPeriodText(window, t);
    if (!period) {
      return knownAllowance ?? window.label;
    }
    const family = knownAllowance ?? (window.scope === 'code_review' ? t('omc.quota_family_code_review') : modelLabel(window));
    return t('omc.quota_reading_name', { family, period });
  }
  const periodKind = periodOf(window);
  if (periodKind) return quotaWindowLabel(periodKind, window.label, t);
  return customPeriodText(window, t) ?? legacySlotFallbackName(window, t) ?? quotaWindowLabel(kind, window.label, t);
}

/** Full localized name for tooltips and accessible labels: group name plus localized window name. */
export function quotaDetailWindowFullName(window: QuotaWindow, t: TFunc, siblings?: readonly QuotaWindow[]): string {
  const detail = quotaDetailWindowName(window, t, siblings);
  if (window.scope !== 'group') return detail;
  const group = quotaWindowParts(window).group;
  return group ? `${group} ${detail}` : detail;
}
