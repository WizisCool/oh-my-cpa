/**
 * Logic-level tests for the routing board: how tiers are read from stored priorities, what moves do
 * to them, which priority numbers an arrangement writes, the plan it sends, and the failover chain it
 * previews for one model. That a drag reaches these functions is the page's component test's claim.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RoutingBoard, RoutingMember, RoutingModels } from '../web/src/types/routing.ts';
import {
  assignTierPriorities,
  diffPlan,
  draftFromBoard,
  moveMember,
  resolveRoute,
  splitMember,
  stepMember,
  tiersFromMembers,
  type RoutingTier,
} from '../web/src/types/routingPlan.ts';

const member = (key: string, priority: number, overrides: Partial<RoutingMember> = {}): RoutingMember => ({
  key,
  kind: 'credential',
  id: key,
  family: 'codex',
  name: key,
  priority,
  weights: [{ index: 0, weight: null }],
  key_count: 1,
  is_disabled: false,
  is_unavailable: false,
  is_runtime_only: false,
  ...overrides,
});

const board = (members: RoutingMember[]): RoutingBoard => ({
  revision: 'r1',
  settings: {
    strategy: 'round-robin',
    session_affinity: false,
    session_affinity_ttl: '',
    request_retry: 0,
    max_retry_credentials: 0,
    max_retry_interval: 0,
    disable_cooling: false,
    transient_error_cooldown_seconds: 0,
    force_model_prefix: false,
  },
  members,
  partial: [],
});

const keysOf = (tiers: RoutingTier[]) => tiers.map((tier) => tier.memberKeys.join('+')).join(' > ');
const priorities = (pairs: [string, number][]) => new Map(pairs);

test('tiers follow stored priority, highest first', () => {
  const tiers = tiersFromMembers([member('b', 0), member('a', 10), member('c', 0), member('d', -5)]);
  assert.equal(keysOf(tiers), 'a > b+c > d');
});

test('moves join a tier, open a gap, and collapse the tier they empty', () => {
  const tiers = tiersFromMembers([member('a', 10), member('b', 0), member('c', 0)]);
  assert.equal(keysOf(moveMember(tiers, 'b', { kind: 'tier', tierId: tiers[0].id })), 'a+b > c');
  assert.equal(keysOf(moveMember(tiers, 'c', { kind: 'gap', index: 0 })), 'c > a > b');
  assert.equal(keysOf(moveMember(tiers, 'a', { kind: 'gap', index: 2 })), 'b+c > a');
  // A gap beside a member's own single tier recreates it: no move.
  assert.equal(keysOf(moveMember(tiers, 'a', { kind: 'gap', index: 1 })), 'a > b+c');
  assert.equal(keysOf(stepMember(tiers, 'b', 'up')), 'a+b > c');
  assert.equal(keysOf(stepMember(tiers, 'a', 'up')), 'a > b+c');
  assert.equal(keysOf(stepMember(tiers, 'c', 'down')), 'a > b > c');
  assert.equal(keysOf(splitMember(tiers, 'c', 'above')), 'a > c > b');
});

test('numbering keeps every stored priority the order allows', () => {
  const original = priorities([['a', 10], ['b', 0], ['c', 0], ['d', 0]]);
  // Unchanged order: unchanged numbers.
  assert.deepEqual(assignTierPriorities([{ id: '1', memberKeys: ['a'] }, { id: '2', memberKeys: ['b', 'c', 'd'] }], original), [10, 0]);
  // Lifting one member out of the zero tier writes one number, between the neighbours.
  assert.deepEqual(
    assignTierPriorities([{ id: '1', memberKeys: ['a'] }, { id: 'n', memberKeys: ['b'] }, { id: '2', memberKeys: ['c', 'd'] }], original),
    [10, 5, 0],
  );
  // Above the top steps by ten.
  assert.deepEqual(assignTierPriorities([{ id: 'n', memberKeys: ['d'] }, { id: '1', memberKeys: ['a'] }, { id: '2', memberKeys: ['b', 'c'] }], original), [20, 10, 0]);
  // Swapping two single tiers keeps the larger group's anchor and renumbers the other.
  assert.deepEqual(assignTierPriorities([{ id: '2', memberKeys: ['b', 'c', 'd'] }, { id: '1', memberKeys: ['a'] }], original), [0, -10]);
});

test('kept numbers leave room for every tier between them', () => {
  const original = priorities([['a', 2], ['b', 1], ['c', 0], ['d', 0]]);
  // Moving c between a=2 and b=1 leaves no integer for it, so two numbers must change. Keeping
  // a and c would push b and d negative; keeping the bottom b and d lifts a and c instead.
  assert.deepEqual(
    assignTierPriorities(
      [{ id: 'a', memberKeys: ['a'] }, { id: 'n', memberKeys: ['c'] }, { id: 'b', memberKeys: ['b'] }, { id: 'd', memberKeys: ['d'] }],
      original,
    ),
    [21, 11, 1, 0],
  );
});

test('the plan names only what changed', () => {
  const current = board([member('a', 10), member('b', 0, { weights: [{ index: 0, weight: 2 }] }), member('c', 0)]);
  const draft = draftFromBoard(current);
  const unchanged = diffPlan(current, draft);
  assert.ok(unchanged);
  assert.deepEqual(unchanged.request, {});
  draft.tiers = stepMember(draft.tiers, 'c', 'up');
  draft.weights.b = [null];
  draft.settings.strategy = 'fill-first';
  const diff = diffPlan(current, draft);
  assert.ok(diff);
  assert.deepEqual(diff.request, {
    settings: { strategy: 'fill-first' },
    members: [
      { key: 'b', weights: [{ index: 0, weight: null }] },
      { key: 'c', priority: 10 },
    ],
  });
  assert.equal(diff.changes.length, 3);
});

test('the preview walks tiers that can serve the model and splits each by its strategy', () => {
  const current = board([
    member('a', 10, { weights: [{ index: 0, weight: 3 }] }),
    member('b', 10, { kind: 'provider', key_count: 2, weights: [{ index: 0, weight: 1 }, { index: 1, weight: null }] }),
    member('c', 5, { is_unavailable: true }),
    member('d', 0),
    member('e', 0, { is_disabled: true }),
    member('f', 0),
  ]);
  const models: RoutingModels = {
    models: { a: ['m'], b: ['m'], c: ['m'], d: ['m'], e: ['m'], f: ['other'] },
    unknown: [],
  };
  const draft = draftFromBoard(current);

  const roundRobin = resolveRoute(current, draft, { models, model: 'm' });
  assert.deepEqual(roundRobin.steps.map((step) => step.members.map((entry) => `${entry.key}:${entry.state}:${entry.share?.toFixed(2)}`)), [
    // b holds two keys, so two of three shares.
    ['a:serving:0.33', 'b:serving:0.67'],
    ['c:blocked:undefined'],
    ['d:standby:1.00'],
  ]);
  assert.equal(roundRobin.states.get('e'), 'ineligible');
  assert.equal(roundRobin.states.get('f'), 'ineligible');

  draft.settings.strategy = 'weighted-round-robin';
  draft.weights.a = [0];
  const weighted = resolveRoute(current, draft, { models, model: 'm' });
  // A zero weight leaves the tier; the other member's keys run as 1 + 1.
  assert.deepEqual(weighted.steps[0].members.map((entry) => `${entry.key}:${entry.state}:${entry.share}`), ['a:excluded:null', 'b:serving:1']);

  draft.settings.strategy = 'fill-first';
  assert.equal(resolveRoute(current, draft, { models, model: 'm' }).steps[0].members[1].share, null);

  const partial = resolveRoute(current, draft, { models: { models: { d: ['m'] }, unknown: [] }, model: 'm' });
  assert.equal(partial.states.get('a'), 'unknown', 'an unread member is not dropped as ineligible');

  // Without a lens only the disabled member stands aside; f, which lacks the lens model, stands by.
  draft.settings.strategy = 'round-robin';
  const unlensed = resolveRoute(current, draft, null);
  assert.equal(unlensed.states.get('e'), 'ineligible');
  assert.equal(unlensed.states.get('f'), 'standby');
});


test('fixed credentials keep their priority when a peer joins their tier', () => {
  const current = board([member('a', 10), member('b', 10), member('fixed', 0, { is_runtime_only: true })]);
  const draft = draftFromBoard(current);
  draft.tiers = stepMember(draft.tiers, 'a', 'down');
  const diff = diffPlan(current, draft);
  assert.ok(diff);
  assert.deepEqual(diff.request, { members: [{ key: 'a', priority: 0 }] });
  assert.deepEqual(diff.tierPriorities, [10, 0]);
});

test('tier numbers stay within the write contract and reject gaps between adjacent fixed priorities', () => {
  for (const boundary of [2147483647, -2147483648]) {
    const current = board([member('edge', boundary), member('moving', 0)]);
    const draft = draftFromBoard(current);
    draft.tiers = moveMember(draft.tiers, 'moving', {kind: 'gap', index: boundary > 0 ? 0 : draft.tiers.length});
    const diff = diffPlan(current, draft);
    assert.ok(diff);
    assert.ok(diff.tierPriorities.every(value => value >= -2147483648 && value <= 2147483647));
    assert.ok(diff.tierPriorities.every((value, index, values) => index === 0 || values[index - 1] > value));
  }
  const current = board([
    member('fixed-top', 10, {is_runtime_only: true}),
    member('fixed-bottom', 9, {is_runtime_only: true}),
    member('moving', 0),
  ]);
  const draft = draftFromBoard(current);
  draft.tiers = moveMember(draft.tiers, 'moving', {kind:'gap', index:1});
  assert.equal(diffPlan(current, draft), null);
  for (const [boundary, index] of [[2147483647, 0], [-2147483648, 2]]) {
    const bounded = board([member('fixed', boundary, { is_runtime_only: true }), member('moving', 0)]);
    const next = draftFromBoard(bounded);
    next.tiers = moveMember(next.tiers, 'moving', { kind: 'gap', index });
    assert.equal(diffPlan(bounded, next), null, 'no new tier fits beyond a fixed int32 boundary');
  }
  const spaced = board([
    member('fixed-top', 10, { is_runtime_only: true }),
    member('fixed-bottom', 6, { is_runtime_only: true }),
    member('moving', 0),
  ]);
  const next = draftFromBoard(spaced);
  next.tiers = moveMember(next.tiers, 'moving', { kind: 'gap', index: 1 });
  const diff = diffPlan(spaced, next);
  assert.ok(diff);
  assert.deepEqual(diff.tierPriorities, [10, 8, 6]);
  assert.deepEqual(diff.request, { members: [{ key: 'moving', priority: 8 }] });
});
