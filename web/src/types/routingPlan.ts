/**
 * The routing board's arithmetic, kept free of React so it can be reasoned about on its own.
 *
 * CPA schedules in strict priority tiers: the highest priority with an available credential serves
 * a request, and the strategy spreads requests only among that tier. The operator arranges tiers;
 * the numbers are derived here, changing as few stored priorities as the new order allows.
 */
import type {
  RoutingBoard,
  RoutingMember,
  RoutingMemberEdit,
  RoutingModels,
  RoutingPlanRequest,
  RoutingSettingKey,
  RoutingSettings,
} from './routing';

export interface RoutingTier {
  /** Stable across moves, so a tier keeps its identity while members come and go. */
  id: string;
  memberKeys: string[];
}

export interface RoutingDraft {
  /** Highest priority first. */
  tiers: RoutingTier[];
  /** Per member key, one entry per editable key weight; null runs as 1. */
  weights: Record<string, (number | null)[]>;
  settings: RoutingSettings;
}

/** Where a dragged member lands: into a tier as a peer, or into the gap before tier `index`. */
export type RoutingDropTarget = { kind: 'tier'; tierId: string } | { kind: 'gap'; index: number };

const TIER_STEP = 10;

export function tiersFromMembers(members: readonly RoutingMember[]): RoutingTier[] {
  const byPriority = new Map<number, RoutingMember[]>();
  for (const member of members) {
    byPriority.set(member.priority, [...(byPriority.get(member.priority) ?? []), member]);
  }
  return [...byPriority.entries()]
    .sort(([left], [right]) => right - left)
    .map(([priority, peers]) => ({
      id: `p${priority}`,
      memberKeys: peers.sort((left, right) => left.name.localeCompare(right.name)).map((member) => member.key),
    }));
}

export function draftFromBoard(board: RoutingBoard): RoutingDraft {
  const weights: RoutingDraft['weights'] = {};
  for (const member of board.members) {
    weights[member.key] = member.weights.map((entry) => entry.weight);
  }
  return { tiers: tiersFromMembers(board.members), weights, settings: { ...board.settings } };
}

let tierSequence = 0;
function newTierId(): string {
  tierSequence += 1;
  return `new-${tierSequence}`;
}

function withoutMember(tiers: readonly RoutingTier[], key: string): RoutingTier[] {
  return tiers.map((tier) => ({ ...tier, memberKeys: tier.memberKeys.filter((memberKey) => memberKey !== key) }));
}

function withoutEmptyTiers(tiers: readonly RoutingTier[]): RoutingTier[] {
  return tiers.filter((tier) => tier.memberKeys.length > 0);
}

export function tierIndexOf(tiers: readonly RoutingTier[], key: string): number {
  return tiers.findIndex((tier) => tier.memberKeys.includes(key));
}

/**
 * Moves a member onto a tier or into a gap. A gap on either side of the member's own single-member
 * tier would recreate that tier, so it is no move at all.
 */
export function moveMember(tiers: readonly RoutingTier[], key: string, target: RoutingDropTarget): RoutingTier[] {
  const from = tierIndexOf(tiers, key);
  if (from < 0) {
    return [...tiers];
  }
  if (target.kind === 'tier') {
    if (tiers[from].id === target.tierId || !tiers.some((tier) => tier.id === target.tierId)) {
      return [...tiers];
    }
    const moved = withoutMember(tiers, key).map((tier) =>
      tier.id === target.tierId ? { ...tier, memberKeys: [...tier.memberKeys, key] } : tier,
    );
    return withoutEmptyTiers(moved);
  }
  const isAlone = tiers[from].memberKeys.length === 1;
  if (isAlone && (target.index === from || target.index === from + 1)) {
    return [...tiers];
  }
  const moved = withoutMember(tiers, key);
  const index = Math.max(0, Math.min(target.index, moved.length));
  moved.splice(index, 0, { id: newTierId(), memberKeys: [key] });
  return withoutEmptyTiers(moved);
}

/**
 * Keyboard and menu moves. Stepping up joins the tier above; a member already at the top with peers
 * leaves them for a tier of its own above, which is the only way further up.
 */
export function stepMember(tiers: readonly RoutingTier[], key: string, direction: 'up' | 'down'): RoutingTier[] {
  const from = tierIndexOf(tiers, key);
  if (from < 0) {
    return [...tiers];
  }
  if (direction === 'up') {
    return from > 0 ? moveMember(tiers, key, { kind: 'tier', tierId: tiers[from - 1].id }) : moveMember(tiers, key, { kind: 'gap', index: 0 });
  }
  return from < tiers.length - 1
    ? moveMember(tiers, key, { kind: 'tier', tierId: tiers[from + 1].id })
    : moveMember(tiers, key, { kind: 'gap', index: tiers.length });
}

/** Gives a member a tier of its own directly above or below its current one. */
export function splitMember(tiers: readonly RoutingTier[], key: string, side: 'above' | 'below'): RoutingTier[] {
  const from = tierIndexOf(tiers, key);
  if (from < 0) {
    return [...tiers];
  }
  return moveMember(tiers, key, { kind: 'gap', index: side === 'above' ? from : from + 1 });
}

/** Keeps fixed tiers and as many stored priorities as the legal integer spacing permits. */
export function assignTierPriorities(
  tiers: readonly RoutingTier[],
  original: ReadonlyMap<string, number>,
  fixed: ReadonlyMap<string, number> = new Map(),
): number[] | null {
  const minimum = tiers.map((_, index) => -2_147_483_648 + tiers.length - 1 - index);
  const maximum = tiers.map((_, index) => 2_147_483_647 - index);
  const fixedTiers = new Map<number, number>();
  for (const [index, tier] of tiers.entries()) {
    for (const key of tier.memberKeys) {
      const value = fixed.get(key);
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < minimum[index] || value > maximum[index]) return null;
      if (fixedTiers.has(index) && fixedTiers.get(index) !== value) return null;
      fixedTiers.set(index, value);
    }
  }
  // Every tier needs an integer between its fixed neighbours; a locked credential can never be
  // renumbered to make a move fit. The end bounds also leave room inside the server's int32 range.
  for (const [index, value] of fixedTiers) {
    minimum[index] = maximum[index] = value;
    for (let earlier = 0; earlier < index; earlier += 1) {
      minimum[earlier] = Math.max(minimum[earlier], value + index - earlier);
    }
    for (let later = index + 1; later < tiers.length; later += 1) {
      maximum[later] = Math.min(maximum[later], value - later + index);
    }
  }
  if (minimum.some((value, index) => value > maximum[index])) return null;

  const preferred = tiers.map((tier, index) => {
    const counts = new Map<number, number>();
    for (const key of tier.memberKeys) {
      const value = original.get(key);
      if (value !== undefined && value >= minimum[index] && value <= maximum[index]) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const fixedValue = fixedTiers.get(index);
    if (fixedValue !== undefined) return { value: fixedValue, count: counts.get(fixedValue) ?? 0 };
    let selected: { value: number; count: number } | null = null;
    for (const [value, count] of counts) {
      if (!selected || count > selected.count || (count === selected.count && value > selected.value)) {
        selected = { value, count };
      }
    }
    return selected;
  });

  const anchors = new Set(fixedTiers.keys());
  const best = preferred.map((entry) => entry?.count ?? -1);
  const previous = preferred.map(() => -1);
  let start = 0;
  // A heaviest descending subsequence is selected separately between each pair of mandatory
  // anchors. Even many editable peers cannot outweigh a fixed tier.
  for (const stop of [...fixedTiers.keys(), tiers.length]) {
    let end = -1;
    for (let index = start; index < stop; index += 1) {
      const current = preferred[index];
      if (!current) continue;
      for (let earlier = start; earlier < index; earlier += 1) {
        const candidate = preferred[earlier];
        if (candidate && candidate.value - current.value >= index - earlier && best[earlier] + current.count > best[index]) {
          best[index] = best[earlier] + current.count;
          previous[index] = earlier;
        }
      }
      // Keeping the furthest-down equally good anchor avoids drifting the default zero tier.
      if (end < 0 || best[index] >= best[end]) end = index;
    }
    for (let index = end; index >= 0; index = previous[index]) anchors.add(index);
    start = stop + 1;
  }

  const values: (number | undefined)[] = tiers.map((_, index) => anchors.has(index) ? preferred[index]!.value : undefined);
  start = 0;
  while (start < values.length) {
    if (values[start] !== undefined) {
      start += 1;
      continue;
    }
    let stop = start;
    while (stop < values.length && values[stop] === undefined) stop += 1;
    const upper = start > 0 ? values[start - 1] : undefined;
    const lower = stop < values.length ? values[stop] : undefined;
    const count = stop - start;
    for (let offset = 0; offset < count; offset += 1) {
      if (upper !== undefined && lower !== undefined) {
        values[start + offset] = upper - Math.floor((upper - lower) / (count + 1)) * (offset + 1);
      } else if (upper !== undefined) {
        values[start + offset] = upper - Math.min(TIER_STEP, Math.floor((upper + 2_147_483_648) / count)) * (offset + 1);
      } else if (lower !== undefined) {
        values[start + offset] = lower + Math.min(TIER_STEP, Math.floor((2_147_483_647 - lower) / count)) * (count - offset);
      } else {
        values[start + offset] = TIER_STEP * (count - 1 - offset);
      }
    }
    start = stop;
  }
  return values as number[];
}

export interface RoutingChange {
  key: string;
  kind: 'priority' | 'weight' | 'setting';
  /** Setting name, or the key index of a weight. */
  field?: string;
  from: unknown;
  to: unknown;
}

export interface RoutingPlanDiff {
  /** Priority each member ends up with, by member key. */
  priorities: Map<string, number>;
  /** Priority value of each tier, in tier order. */
  tierPriorities: number[];
  changes: RoutingChange[];
  request: Omit<RoutingPlanRequest, 'revision'>;
}

const SETTING_KEYS: RoutingSettingKey[] = [
  'strategy',
  'session_affinity',
  'session_affinity_ttl',
  'request_retry',
  'max_retry_credentials',
  'max_retry_interval',
  'disable_cooling',
  'transient_error_cooldown_seconds',
];

/** What applying the draft would change against the board, and the request that applies it. */
export function diffPlan(board: RoutingBoard, draft: RoutingDraft): RoutingPlanDiff | null {
  const original = new Map(board.members.map((member) => [member.key, member.priority]));
  const fixed = new Map(board.members.filter(member => member.is_runtime_only).map(member => [member.key, member.priority]));
  const tierPriorities = assignTierPriorities(draft.tiers, original, fixed);
  if (!tierPriorities) return null;
  const priorities = new Map<string, number>();
  draft.tiers.forEach((tier, index) => {
    for (const key of tier.memberKeys) {
      priorities.set(key, tierPriorities[index]);
    }
  });
  const changes: RoutingChange[] = [];
  const members: RoutingMemberEdit[] = [];
  for (const member of board.members) {
    const edit: RoutingMemberEdit = { key: member.key };
    const priority = priorities.get(member.key) ?? member.priority;
    if (priority !== member.priority) {
      edit.priority = priority;
      changes.push({ key: member.key, kind: 'priority', from: member.priority, to: priority });
    }
    const weights = draft.weights[member.key] ?? [];
    for (const [position, entry] of member.weights.entries()) {
      const next = weights[position] ?? null;
      if (next !== entry.weight) {
        edit.weights = [...(edit.weights ?? []), { index: entry.index, weight: next }];
        changes.push({ key: member.key, kind: 'weight', field: String(entry.index), from: entry.weight, to: next });
      }
    }
    if (edit.priority !== undefined || edit.weights) {
      members.push(edit);
    }
  }
  const settings: RoutingPlanRequest['settings'] = {};
  for (const key of SETTING_KEYS) {
    if (draft.settings[key] !== board.settings[key]) {
      Object.assign(settings, { [key]: draft.settings[key] });
      changes.push({ key: 'settings', kind: 'setting', field: key, from: board.settings[key], to: draft.settings[key] });
    }
  }
  const request: RoutingPlanDiff['request'] = {};
  if (Object.keys(settings).length > 0) {
    request.settings = settings;
  }
  if (members.length > 0) {
    request.members = members;
  }
  return { priorities, tierPriorities, changes, request };
}

/** Why a member does or does not take part in serving the lens model. */
export type RouteMemberState = 'serving' | 'standby' | 'excluded' | 'blocked' | 'unknown' | 'ineligible';

export interface RouteMember {
  key: string;
  state: RouteMemberState;
  /** Expected share of its tier's requests, 0..1; null where the strategy does not split. */
  share: number | null;
}

export interface RouteStep {
  tierId: string;
  /** 1-based failover order among tiers that can serve the model. */
  step: number;
  members: RouteMember[];
  /** True for the tier that receives requests while every member is available. */
  isPrimary: boolean;
}

export interface RoutePreview {
  steps: RouteStep[];
  /** Member state by key, including members outside any step. */
  states: Map<string, RouteMemberState>;
}

/** One model and what each member can serve, narrowing the route to the requests for that model. */
export interface RouteLens {
  model: string;
  models: RoutingModels;
}

/**
 * The failover chain CPA would walk under the draft: tiers that hold a member able to serve a
 * request, highest first, and each member's share within its tier. Without a lens every enabled
 * member counts as able, which is the route for a model all of them serve. A member whose models
 * could not be read stays in the chain as unknown rather than being dropped as ineligible.
 */
export function resolveRoute(
  board: RoutingBoard,
  draft: RoutingDraft,
  lens: RouteLens | null,
): RoutePreview {
  const members = new Map(board.members.map((member) => [member.key, member]));
  const unknown = new Set(lens?.models.unknown);
  const states = new Map<string, RouteMemberState>();
  const steps: RouteStep[] = [];
  let hasPrimary = false;
  for (const tier of draft.tiers) {
    const routeMembers: RouteMember[] = [];
    let units = 0;
    const unitsByKey = new Map<string, number>();
    for (const key of tier.memberKeys) {
      const member = members.get(key);
      if (!member) {
        continue;
      }
      let state: RouteMemberState;
      if (member.is_disabled) {
        state = 'ineligible';
      } else if (lens && (unknown.has(key) || !Object.prototype.hasOwnProperty.call(lens.models.models, key))) {
        state = 'unknown';
      } else if (lens && !lens.models.models[key].includes(lens.model)) {
        state = 'ineligible';
      } else if (member.is_unavailable) {
        state = 'blocked';
      } else {
        state = 'serving';
      }
      if (state === 'serving') {
        const weights = draft.weights[key] ?? [];
        // Keys in a legacy spelling carry no weight and run as 1.
        const legacyKeys = Math.max(0, member.key_count - weights.length);
        const memberUnits =
          draft.settings.strategy === 'weighted-round-robin'
            ? weights.reduce<number>((sum, weight) => sum + (weight ?? 1), 0) + legacyKeys
            : member.key_count;
        if (memberUnits <= 0) {
          state = 'excluded';
        } else {
          unitsByKey.set(key, memberUnits);
          units += memberUnits;
        }
      }
      states.set(key, state);
      if (state !== 'ineligible') {
        routeMembers.push({ key, state, share: null });
      }
    }
    if (routeMembers.length === 0) {
      continue;
    }
    const isPrimary: boolean = !hasPrimary && units > 0;
    hasPrimary ||= isPrimary;
    for (const routeMember of routeMembers) {
      const memberUnits = unitsByKey.get(routeMember.key);
      if (memberUnits === undefined) {
        continue;
      }
      if (draft.settings.strategy === 'fill-first') {
        // CPA fills the credential with the lowest internal ID first, which the console cannot see.
        routeMember.share = null;
      } else {
        routeMember.share = memberUnits / units;
      }
      if (!isPrimary) {
        routeMember.state = 'standby';
        states.set(routeMember.key, 'standby');
      }
    }
    steps.push({ tierId: tier.id, step: steps.length + 1, members: routeMembers, isPrimary });
  }
  return { steps, states };
}
