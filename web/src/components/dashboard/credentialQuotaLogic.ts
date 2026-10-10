import type { ManagementAuthFile } from '../../types/managementAuthFile';
import type { QuotaItem, QuotaWindow } from '../../types/quota';

/*
 * This module reads the two management responses directly and shares no code with the credential
 * workspace. Keeping the dashboard's reading of the wire types to itself means the workspace can
 * change how it selects, labels or acts on quota without moving this panel.
 */

/**
 * What a credential can do for the next request, most urgent first.
 *
 * The first four cannot serve at all, and they are ordered by who has to act: a sign-in only the
 * operator can repeat, then the two that recover on their own clock, then a failure with no
 * recovery time to offer. `low` still serves and is the one worth knowing about before it stops.
 */
export type CredentialQuotaState = 'reauth' | 'cooldown' | 'exhausted' | 'problem' | 'low' | 'healthy' | 'unread';

const STATE_ORDER: CredentialQuotaState[] = ['reauth', 'cooldown', 'exhausted', 'problem', 'low', 'healthy', 'unread'];
const BLOCKED_STATES = new Set<CredentialQuotaState>(['reauth', 'cooldown', 'exhausted', 'problem']);

/** The remaining shares at which a window stops reading as plentiful, and then as nearly spent. */
export const QUOTA_AMPLE_PERCENT = 70;
export const QUOTA_LOW_PERCENT = 25;

export type QuotaWindowPeriod = 'five_hour' | 'daily' | 'weekly' | 'monthly';

/** The share a window has left, 0-100, derived from usage when only that is published. */
export function quotaWindowRemaining(window: QuotaWindow): number | undefined {
  const remaining = window.remaining_percent ?? (window.used_percent != null ? 100 - window.used_percent : undefined);
  return remaining == null ? undefined : Math.round(Math.max(0, Math.min(100, remaining)));
}

/**
 * Which period a window meters. Providers that send no `kind` still send the hours it covers,
 * which is the language-independent fact a short label can be chosen from.
 */
export function quotaWindowPeriod(window: QuotaWindow): QuotaWindowPeriod | undefined {
  if (window.kind === 'five_hour' || window.kind === 'daily' || window.kind === 'weekly' || window.kind === 'monthly') return window.kind;
  const hours = window.period_hours;
  if (hours == null) return undefined;
  if (Math.abs(hours - 5) < 1) return 'five_hour';
  if (Math.abs(hours - 24) < 1) return 'daily';
  if (Math.abs(hours - 168) < 1) return 'weekly';
  if (hours >= 24 * 28 && hours <= 24 * 31) return 'monthly';
  return undefined;
}

const PERIOD_ORDER: (QuotaWindowPeriod | undefined)[] = ['five_hour', 'daily', 'weekly', 'monthly', undefined];

/**
 * The two windows a row has room for: the credential's own plan when it publishes one, otherwise
 * the first family the provider reports, shortest period first. Per-model and side allowances
 * belong to the workspace's detail view.
 */
function pickRowWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const first = windows.find((window) => window.scope === 'standard') ?? windows[0];
  if (!first) return [];
  const familyOf = (window: QuotaWindow) => (
    window.scope === 'group' ? `group:${window.label.split(' · ')[0]}` : window.scope === 'model' ? `model:${window.model || window.label}` : window.scope
  );
  const seenIds = new Set<string>();
  return windows
    .filter((window) => familyOf(window) === familyOf(first))
    .filter((window) => {
      if (!window.id) return true;
      if (seenIds.has(window.id)) return false;
      seenIds.add(window.id);
      return true;
    })
    .sort((left, right) => PERIOD_ORDER.indexOf(quotaWindowPeriod(left)) - PERIOD_ORDER.indexOf(quotaWindowPeriod(right)))
    .slice(0, 2);
}

function isDisabled(file: ManagementAuthFile): boolean {
  return file.disabled === true || file.status?.trim().toLowerCase() === 'disabled';
}

function isUnavailable(file: ManagementAuthFile): boolean {
  return file.unavailable === true || file.status?.trim().toLowerCase() === 'error';
}

export interface CredentialQuotaRow {
  key: string;
  fileName: string;
  /** The account when the credential names one, otherwise its file name. */
  primary: string;
  provider: string;
  state: CredentialQuotaState;
  /** The credential's own model family, shortest limit first; at most two. */
  windows: QuotaWindow[];
  /** The tightest of `windows`, which is the limit that stops the credential first. */
  bindingWindow?: QuotaWindow;
  remainingPercent?: number;
  /** When a blocked credential serves again, where the gateway or the provider stated it. */
  recoverAtMS?: number;
  /** The gateway's own words for a problem, for the reader who wants the cause. */
  detail?: string;
}

export interface CredentialQuotaBoard {
  /** Every enabled credential, most urgent first. */
  rows: CredentialQuotaRow[];
  servingCount: number;
  blockedCount: number;
  disabledCount: number;
}

export function isCredentialQuotaBlocked(state: CredentialQuotaState): boolean {
  return BLOCKED_STATES.has(state);
}

function resolveState(file: ManagementAuthFile, item: QuotaItem | undefined, remainingPercent: number | undefined): CredentialQuotaState {
  if (item?.recommendation?.action === 'reauth' || item?.recommendation?.status === 'needs_reauth') return 'reauth';
  if (item?.active_cooldown?.is_active || item?.status === 'cooldown') return 'cooldown';
  if (item?.status === 'exhausted' || remainingPercent === 0) return 'exhausted';
  if (isUnavailable(file) || item?.status === 'error') return 'problem';
  if (remainingPercent == null) return 'unread';
  return remainingPercent < QUOTA_LOW_PERCENT ? 'low' : 'healthy';
}

/**
 * An exhausted credential serves again once every spent window has reset, so its recovery is the
 * latest of those resets rather than the soonest.
 */
function resolveRecovery(state: CredentialQuotaState, item: QuotaItem | undefined, windows: QuotaWindow[]): number | undefined {
  if (state === 'cooldown') return item?.active_cooldown?.recover_at_ms ?? item?.next_recover_at_ms;
  if (state !== 'exhausted') return undefined;
  const resets = windows
    .filter((window) => quotaWindowRemaining(window) === 0 && window.reset_at_ms)
    .map((window) => window.reset_at_ms!);
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

/**
 * Joins the credential list with its stored quota readings into one urgency-ordered board.
 *
 * The dashboard asks one question of a credential fleet - what can still serve, and what is about
 * to stop - so the order is the answer: on a deployment with fifty credentials the handful that
 * need a decision are the rows in view, and the healthy remainder is a scroll away. Disabled credentials are
 * the operator's own decision and are only counted; the runtime entries CPA lists for configured
 * API keys are not subscriptions and carry no quota, so they are left to the provider table.
 */
export function buildCredentialQuotaBoard(files: ManagementAuthFile[], quotas: QuotaItem[]): CredentialQuotaBoard {
  const quotaByAuthIndex = new Map<string, QuotaItem>();
  for (const item of quotas) {
    if (item.auth_index && !quotaByAuthIndex.has(item.auth_index)) quotaByAuthIndex.set(item.auth_index, item);
  }

  const rows: CredentialQuotaRow[] = [];
  let disabledCount = 0;
  for (const file of files) {
    if (file.runtime_only) continue;
    if (isDisabled(file)) {
      disabledCount += 1;
      continue;
    }
    const item = file.auth_index ? quotaByAuthIndex.get(file.auth_index) : undefined;
    const windows = pickRowWindows(item?.windows ?? []);
    let bindingWindow: QuotaWindow | undefined;
    let remainingPercent: number | undefined;
    for (const window of windows) {
      const remaining = quotaWindowRemaining(window);
      if (remaining != null && (remainingPercent == null || remaining < remainingPercent)) {
        remainingPercent = remaining;
        bindingWindow = window;
      }
    }
    const state = resolveState(file, item, remainingPercent);
    rows.push({
      key: file.auth_index || file.name,
      fileName: file.name,
      primary: (file.email || file.project_id || file.name || '').trim() || '—',
      provider: (file.type || file.provider || 'unknown').trim().toLowerCase(),
      state,
      windows,
      bindingWindow,
      remainingPercent,
      recoverAtMS: resolveRecovery(state, item, windows),
      detail: (file.status_message || item?.error || item?.recommendation?.reason || '').trim() || undefined,
    });
  }

  rows.sort((left, right) => (
    STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state)
      || (left.remainingPercent ?? 101) - (right.remainingPercent ?? 101)
      || left.primary.localeCompare(right.primary, undefined, { numeric: true, sensitivity: 'base' })
  ));

  const blockedCount = rows.filter((row) => isCredentialQuotaBlocked(row.state)).length;
  return { rows, servingCount: rows.length - blockedCount, blockedCount, disabledCount };
}

/**
 * The credentials a live quota refresh can be asked about: enabled, addressable by an auth index
 * no other credential shares, and from a provider the gateway can read on demand.
 */
export function credentialQuotaRefreshTargets(files: ManagementAuthFile[], quotas: QuotaItem[]): string[] {
  const refreshable = new Set(
    quotas.filter((item) => item.auth_index && item.capabilities?.refresh_supported).map((item) => item.auth_index),
  );
  const occurrences = new Map<string, number>();
  for (const file of files) {
    if (file.auth_index) occurrences.set(file.auth_index, (occurrences.get(file.auth_index) ?? 0) + 1);
  }
  return files
    .filter((file) => !file.runtime_only && !isDisabled(file))
    .map((file) => file.auth_index ?? '')
    .filter((authIndex) => authIndex && occurrences.get(authIndex) === 1 && refreshable.has(authIndex));
}
