import type { TFunc } from '../../i18n';

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * Short absolute time used across the quota card, e.g. "09/30 01:05".
 * Numeric and locale-neutral on purpose so every language shares one layout.
 */
export function formatShortDateTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "GMT+8" style label for the viewer's local timezone (dynamically derived). */
export function formatGmtOffsetLabel(now: Date = new Date()): string {
  const totalMinutes = -now.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(totalMinutes);
  return `GMT${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad2(abs % 60)}` : ''}`;
}

/**
 * Live countdown until `targetMS`, e.g. "in 4 hours" / "in 28 days".
 * Returns null once the target has passed (caller decides the expired copy).
 */
export function formatCountdown(targetMS: number, nowMS: number, t: TFunc): string | null {
  const diff = targetMS - nowMS;
  if (diff <= 0) return null;
  const totalMinutes = Math.ceil(diff / 60000);
  if (totalMinutes < 60) return t('quota.in_minutes', { n: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    const mins = totalMinutes % 60;
    return mins > 0 ? t('quota.in_hours_min', { h: hours, m: mins }) : t('quota.in_hours', { n: hours });
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? t('quota.in_days_min', { d: days, h: remH }) : t('quota.in_days', { n: days });
}

/**
 * Combined "09/30 01:05 · in 24 days" cell; falls back to the plain date when
 * no countdown applies (already expired / unknown target).
 */
export function formatTimeWithCountdown(targetMS: number, nowMS: number, t: TFunc): string {
  const date = formatShortDateTime(targetMS);
  const countdown = formatCountdown(targetMS, nowMS, t);
  return countdown ? `${date} · ${countdown}` : date;
}

/** Relative "x minutes ago" / "x hours ago" for observation timestamps. */
export function formatObservedAgo(ms: number, nowMS: number, t: TFunc): string {
  const diffSec = Math.floor((nowMS - ms) / 1000);
  if (diffSec < 60) return t('quota.just_now');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} ${t('quota.mins_ago')}`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ${t('quota.hours_ago')}`;
  const diffDays = Math.floor(diffHours / 24);
  return t('quota.days_ago', { n: diffDays });
}
