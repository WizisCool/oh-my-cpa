import type { UsageEvent } from './usageEvents';

/**
 * The live routing panel's wire types and the pure model drawn from them.
 *
 * The panel holds a rolling minute of attempts in the browser. CPA writes one
 * request record per attempt, so a record is a route a request actually took,
 * and several records sharing a request id are one request CPA moved to another
 * credential. The server answers the whole minute once and then only what was
 * recorded since (`after`); the browser ages records out on its own clock, which
 * is what lets a row leave the moment its last request turns a minute old rather
 * than at the next read.
 */

export interface UsageRoutingCooldown {
  auth_index: string;
  provider: string;
  status_code?: number;
  quota_exceeded: boolean;
  until_at_ms: number;
}

export interface UsageRoutingResponse {
  as_of_ms: number;
  window_ms: number;
  /** Attempts, newest first. */
  records: UsageEvent[];
  /** The window held more attempts than one read returns; the oldest were left out. */
  has_more: boolean;
  cooldowns: UsageRoutingCooldown[];
}

/** An attempt belongs to the minute it finished in, whenever it started. */
export function finishedAt(event: Pick<UsageEvent, 'timestamp_ms' | 'latency_ms'>): number {
  return event.timestamp_ms + Math.max(0, event.latency_ms || 0);
}

/**
 * Folds one read into the rolling window.
 *
 * A full read (`isIncremental` false) replaces the window: it is the server's
 * whole minute. An incremental read adds what was recorded since; a record the
 * window already holds is replaced by the newer projection of it.
 */
export function mergeRoutingRecords(
  previous: ReadonlyMap<number, UsageEvent> | undefined,
  records: readonly UsageEvent[],
  isIncremental: boolean,
): Map<number, UsageEvent> {
  const next = new Map(isIncremental && previous ? previous : []);
  for (const record of records) next.set(record.id, record);
  return next;
}

/** The records still inside the window at `nowMs`. */
export function liveRecords(records: ReadonlyMap<number, UsageEvent>, nowMs: number, windowMs: number): UsageEvent[] {
  const from = nowMs - windowMs;
  return [...records.values()].filter((record) => finishedAt(record) >= from);
}

/** Drops records that left the window, so a long-open dashboard holds a minute, not a day. */
export function pruneRoutingRecords(records: ReadonlyMap<number, UsageEvent>, nowMs: number, windowMs: number): Map<number, UsageEvent> {
  return new Map(liveRecords(records, nowMs, windowMs).map((record) => [record.id, record]));
}

export function newestRecordIdOf(records: ReadonlyMap<number, UsageEvent> | readonly UsageEvent[]): number | undefined {
  let newest: number | undefined;
  for (const record of records.values()) if (newest === undefined || record.id > newest) newest = record.id;
  return newest;
}

/** The model a caller asked for: the alias it named, else the model. */
export function callModelOf(event: Pick<UsageEvent, 'model' | 'model_alias'>): string {
  return event.model_alias?.trim() || event.model?.trim() || '';
}

export function modelIdOf(event: Pick<UsageEvent, 'model' | 'model_alias'>): string {
  return `model:${callModelOf(event)}`;
}

/** A credential is the runtime auth index CPA reported, else the provider that answered. */
export function targetIdOf(event: Pick<UsageEvent, 'auth_index' | 'provider'>): string {
  return event.auth_index?.trim() ? `auth:${event.auth_index.trim()}` : `provider:${event.provider || ''}`;
}

/** The number of categorical series slots (`--series-1`…`--series-6`). */
export const SERIES_SLOTS = 6;

function hashSlot(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return hash % SERIES_SLOTS;
}

/**
 * Gives each drawn model a colour that it keeps while it stays on the panel.
 *
 * A model already holding a slot keeps it: a row that changed colour because
 * another model arrived would read as a different model. A newcomer takes the
 * slot its name hashes to, or the next free one, so two drawn models share a
 * colour only when more than six are drawn at once.
 */
export function allocateSlots(previous: ReadonlyMap<string, number>, ids: readonly string[]): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set<number>();
  for (const id of ids) {
    const slot = previous.get(id);
    if (slot !== undefined && !used.has(slot)) {
      next.set(id, slot);
      used.add(slot);
    }
  }
  for (const id of [...ids].sort()) {
    if (next.has(id)) continue;
    let slot = hashSlot(id);
    for (let step = 0; step < SERIES_SLOTS && used.has(slot); step++) slot = (slot + 1) % SERIES_SLOTS;
    used.add(slot);
    next.set(id, slot);
  }
  return next;
}

export interface RoutingAttempt {
  event: UsageEvent;
  targetId: string;
}

/** One logical request: its attempts in the order CPA made them. */
export interface RoutingRoute {
  key: string;
  requestId?: string;
  modelId: string;
  attempts: RoutingAttempt[];
  /** The newest record id of the route, which is what orders arrivals. */
  lastId: number;
  isFailed: boolean;
  isRerouted: boolean;
}

/**
 * Groups attempts into requests, newest first. A record without a request id is
 * a request of its own; attempts inside a request are in record order, which is
 * the order CPA reported them in.
 */
export function groupRoutes(records: readonly UsageEvent[]): RoutingRoute[] {
  const groups = new Map<string, UsageEvent[]>();
  for (const record of records) {
    const key = record.request_id?.trim() ? `req:${record.request_id.trim()}` : `rec:${record.id}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const routes: RoutingRoute[] = [];
  for (const [key, events] of groups) {
    events.sort((left, right) => left.id - right.id);
    const last = events[events.length - 1];
    routes.push({
      key,
      requestId: events[0].request_id?.trim() || undefined,
      modelId: modelIdOf(events[0]),
      attempts: events.map((event) => ({ event, targetId: targetIdOf(event) })),
      lastId: last.id,
      isFailed: last.failed,
      isRerouted: events.length > 1,
    });
  }
  return routes.sort((left, right) => right.lastId - left.lastId);
}

export interface RoutingModelRow {
  id: string;
  name: string;
  /** Logical requests that started from this model in the window. */
  requests: number;
  /** Requests whose last attempt failed: errors the caller saw. */
  failures: number;
  lastAtMs: number;
  latencyMs: number;
}

export interface RoutingTarget {
  id: string;
  /** The newest attempt this credential answered, for the identity the request list prints. */
  sample: UsageEvent;
  attempts: number;
  failures: number;
  lastAtMs: number;
  latencyMs: number;
  cooldown?: UsageRoutingCooldown;
}

export interface RoutingModel {
  models: RoutingModelRow[];
  targets: RoutingTarget[];
  routes: RoutingRoute[];
  /** Attempts in the window: every credential CPA tried, rerouted ones included. */
  attempts: number;
  /** Models and credentials past the drawn limit, folded into one count each. */
  hiddenModels: number;
  hiddenTargets: number;
}

export const MAX_DRAWN_MODELS = 7;
export const MAX_DRAWN_TARGETS = 7;

/**
 * Builds what the panel draws from the window's attempts.
 *
 * Rows are ordered by name, never by volume: a row that jumped every time a
 * count overtook another would be impossible to follow, and with rows entering
 * and leaving every few seconds a stable order is what lets the motion read as
 * "this one arrived" rather than "everything moved". Volume only decides which
 * rows are drawn when there are more than fit; a resting credential always is.
 */
export function buildRoutingModel(
  records: readonly UsageEvent[],
  cooldowns: readonly UsageRoutingCooldown[],
  nowMs: number,
): RoutingModel {
  const routes = groupRoutes(records);
  const models = new Map<string, RoutingModelRow & { latencyTotal: number }>();
  for (const route of routes) {
    const last = route.attempts[route.attempts.length - 1].event;
    const finished = finishedAt(last);
    const row = models.get(route.modelId);
    if (!row) {
      models.set(route.modelId, {
        id: route.modelId, name: callModelOf(last), requests: 1, failures: route.isFailed ? 1 : 0,
        lastAtMs: finished, latencyMs: last.latency_ms, latencyTotal: last.latency_ms,
      });
    } else {
      row.requests += 1;
      row.failures += route.isFailed ? 1 : 0;
      row.lastAtMs = Math.max(row.lastAtMs, finished);
      row.latencyTotal += last.latency_ms;
      row.latencyMs = Math.round(row.latencyTotal / row.requests);
    }
  }

  const targets = new Map<string, Omit<RoutingTarget, 'cooldown'> & { latencyTotal: number }>();
  for (const record of records) {
    const targetId = targetIdOf(record);
    const finished = finishedAt(record);
    const target = targets.get(targetId);
    if (!target) {
      targets.set(targetId, {
        id: targetId, sample: record, attempts: 1, failures: record.failed ? 1 : 0,
        lastAtMs: finished, latencyMs: record.latency_ms, latencyTotal: record.latency_ms,
      });
    } else {
      target.attempts += 1;
      target.failures += record.failed ? 1 : 0;
      target.latencyTotal += record.latency_ms;
      target.latencyMs = Math.round(target.latencyTotal / target.attempts);
      if (record.id > target.sample.id) target.sample = record;
      target.lastAtMs = Math.max(target.lastAtMs, finished);
    }
  }

  const resting = new Map<string, UsageRoutingCooldown>();
  for (const cooldown of cooldowns) {
    if (cooldown.until_at_ms > nowMs) resting.set(`auth:${cooldown.auth_index}`, cooldown);
  }

  const byVolume = <T extends { lastAtMs: number }>(count: (value: T) => number) => (left: T, right: T) =>
    count(right) - count(left) || right.lastAtMs - left.lastAtMs;
  const drawnModels = [...models.values()].sort(byVolume((row) => row.requests)).slice(0, MAX_DRAWN_MODELS);
  const allTargets = [...targets.values()].sort(byVolume((target) => target.attempts));
  const drawnTargets = [
    ...allTargets.filter((target) => resting.has(target.id)),
    ...allTargets.filter((target) => !resting.has(target.id)),
  ].slice(0, MAX_DRAWN_TARGETS);

  return {
    models: drawnModels
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ latencyTotal: _latencyTotal, ...row }) => row),
    targets: drawnTargets
      .sort((left, right) => `${left.sample.provider}\u0000${left.id}`.localeCompare(`${right.sample.provider}\u0000${right.id}`))
      .map(({ latencyTotal: _latencyTotal, ...target }) => ({
        ...target,
        cooldown: resting.get(target.id),
      })),
    routes,
    attempts: records.length,
    hiddenModels: models.size - drawnModels.length,
    hiddenTargets: targets.size - drawnTargets.length,
  };
}

/**
 * The routes that gained an attempt past `seenId`, oldest first, so the map
 * replays them in the order they happened. Without a `seenId` nothing replays:
 * the panel opening is not the moment those requests ran.
 */
export function arrivedRoutes(routes: readonly RoutingRoute[], seenId: number | undefined): RoutingRoute[] {
  if (seenId === undefined) return [];
  return routes.filter((route) => route.lastId > seenId).sort((left, right) => left.lastId - right.lastId);
}

export type PresencePhase = 'entering' | 'present' | 'exiting';

export interface Presence<T> {
  key: string;
  item: T;
  phase: PresencePhase;
}

/**
 * Reconciles what is on screen with what should be, so a row can animate out
 * before it is removed.
 *
 * A key that is new enters; one still wanted stays (and takes the newest item);
 * one no longer wanted keeps its last item and exits in the place it was, so the
 * rows around it close the gap only once it has gone. A key that returns while
 * it is still exiting is simply present again.
 */
export function reconcilePresence<T>(
  previous: readonly Presence<T>[],
  next: readonly T[],
  keyOf: (item: T) => string,
): Presence<T>[] {
  const wanted = new Set(next.map(keyOf));
  const previousKeys = new Set(previous.map((entry) => entry.key));
  const result: Presence<T>[] = next.map((item) => {
    const key = keyOf(item);
    return { key, item, phase: previousKeys.has(key) ? 'present' : 'entering' };
  });
  // An exiting entry goes back right after the nearest entry that preceded it
  // and is still on screen, so it leaves from the place the reader saw it.
  previous.forEach((entry, index) => {
    if (wanted.has(entry.key)) return;
    let position = 0;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const found = result.findIndex((other) => other.key === previous[cursor].key);
      if (found >= 0) {
        position = found + 1;
        break;
      }
    }
    result.splice(position, 0, { key: entry.key, item: entry.item, phase: 'exiting' });
  });
  return result;
}
