/**
 * Locks the quota renewal cell's display contract.
 *
 * The defect this guards against was invisible rather than wrong-looking: a Codex
 * renewal instant taken from the credential's id_token can already be in the past
 * (upstream had rolled the subscription forward, the token had not), and
 * `formatTimeWithCountdown` drops the countdown for a past target, so the card
 * showed a bare date with nothing marking it as unverified or stale. These
 * assertions fix both halves: the snapshot path must be labelled a lower bound and
 * must never carry a countdown, and only a live reading may read as a deadline.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TFunc } from '../web/src/i18n/index.tsx';
import {
  formatSnapshotRenewalBound,
  formatTimeWithCountdown,
} from '../web/src/pages/quota/quotaFormat.ts';

// The formatter under test only needs the countdown keys; the stub keeps the
// suite independent of the dictionary contents.
const t = ((key: string, params?: Record<string, unknown>) => {
  const n = params?.n ?? params?.d ?? params?.h ?? '';
  return `${key}:${n}`;
}) as TFunc;

const utc = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  Date.UTC(year, month - 1, day, hour, minute);

// Mirrors the report: the id_token snapshot said 2026-08-29 while the account's
// live subscription had already rolled to 2026-09-29.
const NOW_MS = utc(2026, 9, 21, 1, 25);
const SNAPSHOT_MS = utc(2026, 8, 29, 14, 2);
const LIVE_MS = utc(2026, 9, 29, 14, 2);

test('a snapshot expiry renders as a labelled lower bound', () => {
  const cell = formatSnapshotRenewalBound(SNAPSHOT_MS);
  assert.ok(cell.startsWith('≥ '), `expected a lower-bound marker, got ${cell}`);
  // The instant itself is still shown, so an operator can still read the date.
  assert.match(cell, /\d{2}\/\d{2} \d{2}:\d{2}/);
});

test('a snapshot expiry never reads as a countdown deadline', () => {
  const cell = formatSnapshotRenewalBound(SNAPSHOT_MS);
  assert.ok(!cell.includes('quota.in_'), `snapshot cell carried a countdown: ${cell}`);
});

test('a past target silently loses its countdown, which is why it needs a label', () => {
  // Documents the behaviour the snapshot label exists to compensate for.
  const cell = formatTimeWithCountdown(SNAPSHOT_MS, NOW_MS, t);
  assert.ok(!cell.includes('quota.in_'), `past target should have no countdown: ${cell}`);
  assert.equal(cell, formatTimeWithCountdown(SNAPSHOT_MS, NOW_MS, t));
});

test('a live future target keeps its countdown', () => {
  const cell = formatTimeWithCountdown(LIVE_MS, NOW_MS, t);
  assert.ok(
    cell.includes('quota.in_'),
    `live renewal should carry a countdown: ${cell}`,
  );
});
