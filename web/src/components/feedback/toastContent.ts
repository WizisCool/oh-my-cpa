import type React from 'react';

export type ToastTone = 'success' | 'info' | 'warning' | 'error';

/** One target of a batch action that did not succeed, and why. */
export interface ToastItem {
  name: string;
  reason?: string;
  /** The heading the target is listed under - failed, skipped. Items are grouped in the order
   * their groups first appear, so a caller lists what needs attention first. */
  group?: string;
  /** Summarises the group by reason instead of listing every target: what was never eligible is
   * context, and twenty-five of it must not push the two failures out of reach. */
  isGroupSummarised?: boolean;
}

export interface ToastOptions {
  /** A second line under the title: the reason, the hint, the next step. */
  detail?: React.ReactNode;
  /** A failure to describe as the detail when no `detail` is given. */
  error?: unknown;
  /** Per-target outcomes. A toast that carries them stays until it is closed: the reasons are the
   * point of it, and one that dismissed itself would take them away mid-read. */
  items?: ToastItem[];
  /** Buttons the outcome offers - view the result, retry the refused message. */
  actions?: React.ReactNode;
  /** A stable key replaces the previous toast with the same key rather than stacking a second. */
  key?: string;
  /** Keeps the toast until it is closed; implied by `items`. */
  isPersistent?: boolean;
  /** Overrides the tone's default lifetime, in seconds. */
  durationSeconds?: number;
  /** A stable hook for acceptance tests that must find this toast among others. */
  testId?: string;
}

/**
 * How long each tone stays, in seconds. An acknowledgement needs a glance; a warning or a failure
 * carries a sentence the operator has to read, and hovering pauses every one of them.
 */
export const TOAST_DURATION_SECONDS: Record<ToastTone, number> = {
  success: 2,
  info: 3,
  warning: 4,
  error: 5,
};

/**
 * A failure reason as a person reads it. Upstream refusals arrive as `... HTTP 502: {"error":"request
 * failed"}`; the JSON envelope is transport, and a reader wants the status and the sentence inside it.
 */
export function readableReason(reason: string): string {
  const match = /^(.*?HTTP \d{3})[:\s]*(\{[\s\S]*\})\s*$/.exec(reason.trim());
  if (!match) return reason;
  try {
    const body = JSON.parse(match[2]) as Record<string, unknown>;
    const nested = body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>).message : undefined;
    const sentence = [body.message, nested, body.error].find((value) => typeof value === 'string' && value.trim());
    return typeof sentence === 'string' ? `${match[1]} · ${sentence}` : match[1];
  } catch {
    return reason;
  }
}

/** Items grouped under their headings, in the order each heading first appears. */
export interface ToastItemGroup {
  group?: string;
  isSummarised: boolean;
  items: ToastItem[];
}

/** A summarised group's targets, one entry per distinct reason, in first-seen order. */
export function summariseToastItems(items: ToastItem[]): Array<{ reason?: string; names: string[] }> {
  const byReason: Array<{ reason?: string; names: string[] }> = [];
  for (const item of items) {
    const existing = byReason.find((entry) => entry.reason === item.reason);
    if (existing) existing.names.push(item.name);
    else byReason.push({ reason: item.reason, names: [item.name] });
  }
  return byReason;
}

export function groupToastItems(items: ToastItem[]): ToastItemGroup[] {
  const groups: ToastItemGroup[] = [];
  for (const item of items) {
    const existing = groups.find((entry) => entry.group === item.group);
    if (existing) existing.items.push(item);
    else groups.push({ group: item.group, isSummarised: Boolean(item.isGroupSummarised), items: [item] });
  }
  return groups;
}

/** A toast that offers an action is given long enough to reach it, whatever its tone. */
export const TOAST_ACTION_DURATION_SECONDS = 6;

const TOAST_DETAIL_DURATION_SECONDS = 3;

export function toastDurationSeconds(tone: ToastTone, options: ToastOptions | undefined): number | false {
  if (options?.isPersistent || (options?.items?.length ?? 0) > 0) return false;
  if (options?.durationSeconds !== undefined) return options.durationSeconds;
  const hasDetail = Boolean(options?.detail) || options?.error !== undefined;
  // A two-line success needs reading time even though the operation itself only needs a glance.
  return Math.max(
    TOAST_DURATION_SECONDS[tone],
    hasDetail ? TOAST_DETAIL_DURATION_SECONDS : 0,
    options?.actions ? TOAST_ACTION_DURATION_SECONDS : 0,
  );
}
