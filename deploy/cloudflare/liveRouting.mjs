/**
 * The demonstration's live traffic.
 *
 * Every other answer the demonstration gives is a capture re-based onto the viewer's
 * clock, and for a report that is enough. The live routing panel is not a report: it
 * plays each request as it lands, and it only learns that one landed when a read
 * returns a record newer than the last. A capture re-based on every read never does, so
 * the panel sat still - a map of a minute in which nothing ever happened.
 *
 * So this module is a small gateway that is always busy. Traffic is a pure function of
 * the wall clock: time is cut into slots, and each slot's requests come from a generator
 * seeded with the slot's number. Two reads - by one viewer seconds apart, or by two
 * viewers anywhere - therefore agree on every request in the overlap, which is what lets
 * the console's `after` cursor and its rolling minute work against it exactly as they
 * work against CPA. There is no state to keep and nothing to drift.
 *
 * What it imitates is a modest deployment under light concurrency: three models, five
 * credentials, a request every second or so with a few in flight at once, a rate that
 * ebbs and swells, the occasional upstream error answered on a sibling credential, and
 * now and then a credential resting after a rate limit while its sibling carries the
 * load.
 */

/** The window the panel holds, as CPA's routing read reports it. */
export const WINDOW_MS = 60_000;

/** One slot of the clock; each holds at most one request start. */
const SLOT_MS = 500;

/**
 * The longest a request can take, every attempt included. A read looks back this far
 * past the window, so a request that started before the window but finished inside it
 * is still found.
 */
const MAX_REQUEST_MS = 12_000;

/** How far apart rate-limit rests are scheduled, and how long one lasts. */
const COOLDOWN_EPOCH_MS = 150_000;
const COOLDOWN_MS = 28_000;

/**
 * The credentials, as the rest of the dataset names them: the auth indexes are the ones
 * the credential list and the provider list carry, so the panel resolves each to the
 * same name, icon and key mask a visitor sees on those pages.
 */
const CREDENTIALS = {
  'auth-ds-01': {
    provider: 'openai-compatible-deepseek',
    auth_type: 'api_key',
    provider_key_mask: 'relay-de••••••••mary',
  },
  'auth-ds-02': {
    provider: 'openai-compatible-deepseek',
    auth_type: 'api_key',
    provider_key_mask: 'relay-de••••••••dary',
  },
  'auth-claude-01': { provider: 'claude', auth_type: 'oauth' },
  'auth-codex-01': { provider: 'codex', auth_type: 'oauth' },
  'auth-codex-02': { provider: 'codex', auth_type: 'oauth' },
};

/**
 * The models callers ask for, with the credentials CPA may send each to and the shape
 * of a typical answer. Prices are per million tokens, taken from the price book the
 * demonstration serves; a model the book does not list is recorded as unpriced, as it
 * would be on a real deployment.
 */
const MODELS = [
  {
    model: 'claude-opus-5.5',
    weight: 0.36,
    pool: ['auth-claude-01'],
    latency: [1400, 5200],
    ttftShare: [0.25, 0.45],
    input: [9000, 42000],
    output: [400, 2600],
    reasoningEffort: 'xhigh',
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, versionId: 20 },
  },
  {
    model: 'gpt-6-astra',
    weight: 0.38,
    pool: ['auth-codex-01', 'auth-codex-02'],
    latency: [900, 4200],
    ttftShare: [0.2, 0.4],
    input: [6000, 36000],
    output: [300, 2200],
    reasoningEffort: 'high',
    price: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, versionId: 28 },
  },
  {
    model: 'deepseek-v4.1-flash',
    weight: 0.26,
    pool: ['auth-ds-01', 'auth-ds-02'],
    latency: [450, 1900],
    ttftShare: [0.15, 0.3],
    input: [3000, 24000],
    output: [200, 1800],
  },
];

/**
 * The credentials that rest after a rate limit, in turn. Each has a sibling to take its
 * traffic, so a rest shows as a lane going quiet rather than as errors.
 */
const RESTING_IN_TURN = ['auth-codex-02', 'auth-ds-01', 'auth-codex-01', 'auth-ds-02'];

/** Upstream errors an attempt can end with, other than a rate limit. */
const TRANSIENT_STATUSES = [500, 502, 503];

/** mulberry32: small, fast, and good enough to make traffic look unplanned. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(slot, salt) {
  // Slot numbers exceed 32 bits' worth of nothing in particular, so they are folded
  // with a multiplier rather than truncated: neighbouring slots must not share a seed.
  return Math.imul((slot % 0x7fffffff) ^ salt, 0x9e3779b1) ^ Math.floor(slot / 0x7fffffff);
}

const between = (random, [low, high]) => low + random() * (high - low);
const integerBetween = (random, range) => Math.round(between(random, range));
const pick = (random, items) => items[Math.floor(random() * items.length)];

/**
 * How busy the gateway is at an instant, as the chance that a slot starts a request.
 * Two slow waves on different periods make the rate drift between a trickle and a small
 * burst without ever repeating on a cycle a visitor would notice.
 */
function intensityAt(ms) {
  const slow = Math.sin((2 * Math.PI * ms) / 53_000);
  const quick = Math.sin((2 * Math.PI * ms) / 17_000 + 1.3);
  return Math.min(0.85, Math.max(0.18, 0.46 + 0.22 * slow + 0.12 * quick));
}

/** The rest scheduled in an epoch: which credential, and when. */
function cooldownOfEpoch(epoch) {
  const random = generator(seedOf(epoch, 0x51ed));
  const authIndex = RESTING_IN_TURN[((epoch % RESTING_IN_TURN.length) + RESTING_IN_TURN.length) % RESTING_IN_TURN.length];
  const startMs = epoch * COOLDOWN_EPOCH_MS + Math.round(between(random, [10_000, COOLDOWN_EPOCH_MS - COOLDOWN_MS - 10_000]));
  return {
    authIndex,
    startMs,
    untilMs: startMs + COOLDOWN_MS,
    // A codex account that ran out of its window says so; an API key is merely throttled.
    isQuotaExceeded: authIndex.startsWith('auth-codex') && random() < 0.5,
  };
}

/** The rests that touch [fromMs, toMs]. */
function cooldownsBetween(fromMs, toMs) {
  const rests = [];
  for (let epoch = Math.floor(fromMs / COOLDOWN_EPOCH_MS) - 1; epoch <= Math.floor(toMs / COOLDOWN_EPOCH_MS); epoch++) {
    const rest = cooldownOfEpoch(epoch);
    if (rest.untilMs >= fromMs && rest.startMs <= toMs) rests.push(rest);
  }
  return rests;
}

function isResting(rests, authIndex, atMs) {
  return rests.some((rest) => rest.authIndex === authIndex && rest.startMs <= atMs && atMs < rest.untilMs);
}

const callersByDataset = new WeakMap();

/** The callers, taken from the captured traffic so the keys match the key table. */
function callersOf(dataset) {
  const known = callersByDataset.get(dataset);
  if (known) return known;
  const captured = JSON.parse(dataset.responses['usage-routing'].body).records;
  const seen = new Map();
  for (const record of captured) {
    if (!record.api_group_key || seen.has(record.api_group_key)) continue;
    seen.set(record.api_group_key, {
      api_group_key: record.api_group_key,
      api_group_label: record.api_group_label,
      api_key_mask: record.api_key_mask,
      api_key_alias: record.api_key_alias,
      user_agent: record.user_agent,
    });
  }
  const callers = [...seen.values()];
  callersByDataset.set(dataset, callers);
  return callers;
}

/**
 * The record id of an attempt.
 *
 * CPA numbers records in the order they are stored, which is the order attempts finish,
 * and the console's cursor depends on that: it asks for everything after the newest id
 * it holds. So the id leads with the finishing instant, and the slot and attempt make it
 * unique - two slots sixteen apart are eight seconds apart, longer than any two
 * latencies differ, so they cannot finish on the same millisecond.
 */
function recordIdOf(finishedMs, slot, attempt) {
  return finishedMs * 32 + (slot % 16) * 2 + attempt;
}

function tokensFor(random, spec, isFailed) {
  if (isFailed) return { input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 0 };
  const input = integerBetween(random, spec.input);
  const output = integerBetween(random, spec.output);
  const cacheRead = Math.round(input * between(random, [0.3, 0.75]));
  const cacheCreation = Math.round(input * between(random, [0, 0.12]));
  return {
    input,
    output,
    reasoning: spec.reasoningEffort ? Math.round(output * between(random, [0.2, 0.5])) : 0,
    cached: cacheRead,
    cache_read: cacheRead,
    cache_creation: cacheCreation,
    total: input + output,
  };
}

function pricingFor(spec, tokens) {
  if (!spec.price) return { pricing_status: 'unpriced' };
  const { price } = spec;
  const fresh = Math.max(0, tokens.input - tokens.cache_read - tokens.cache_creation);
  const cost = (fresh * price.input + tokens.output * price.output + tokens.cache_read * price.cacheRead
    + tokens.cache_creation * price.cacheWrite) / 1_000_000;
  return { pricing_status: 'priced', price_version_id: price.versionId, cost_usd: Math.round(cost * 1e8) / 1e8 };
}

/**
 * The request a slot starts, as the attempts CPA records for it, or nothing.
 *
 * A rest is caused by something: the attempt that met the rate limit. So when a rest
 * begins inside a slot, that slot's request is the one that met it - it reached the
 * credential, came back 429, and was answered by the sibling. Otherwise the slot draws
 * from the rate, the model mix and the credential pool, skipping a credential that is
 * resting, as CPA's scheduler does.
 */
function requestOfSlot(slot, rests, callers) {
  const slotStartMs = slot * SLOT_MS;
  const random = generator(seedOf(slot, 0x2b7f));
  const trigger = rests.find((rest) => rest.startMs >= slotStartMs && rest.startMs < slotStartMs + SLOT_MS);
  if (!trigger && random() >= intensityAt(slotStartMs)) return [];

  const spec = trigger
    ? MODELS.find((candidate) => candidate.pool.includes(trigger.authIndex))
    : (() => {
      let roll = random();
      for (const candidate of MODELS) {
        roll -= candidate.weight;
        if (roll < 0) return candidate;
      }
      return MODELS[MODELS.length - 1];
    })();
  const caller = pick(random, callers);
  const requestId = `req_live_${slot.toString(36)}`;
  const startedMs = trigger ? trigger.startMs - integerBetween(random, [260, 420]) : slotStartMs + Math.floor(random() * SLOT_MS);

  // The plan: which credentials are tried, and how each attempt ends.
  const plan = [];
  if (trigger) {
    plan.push({ authIndex: trigger.authIndex, status: 429, latencyMs: trigger.startMs - startedMs });
    plan.push({ authIndex: spec.pool.find((index) => index !== trigger.authIndex), status: 200 });
  } else {
    const open = spec.pool.filter((index) => !isResting(rests, index, startedMs));
    const candidates = open.length > 0 ? open : spec.pool;
    const first = pick(random, candidates);
    const sibling = candidates.find((index) => index !== first);
    const errorRoll = random();
    if (errorRoll < 0.05 && sibling) {
      // An upstream error on a credential with a sibling: CPA moves the request on.
      plan.push({ authIndex: first, status: pick(random, TRANSIENT_STATUSES), latencyMs: integerBetween(random, [180, 700]) });
      plan.push({ authIndex: sibling, status: 200 });
    } else if (errorRoll < 0.07) {
      // An error with nowhere left to go reaches the caller.
      plan.push({ authIndex: first, status: pick(random, [...TRANSIENT_STATUSES, 529]), latencyMs: integerBetween(random, [600, 2400]) });
    } else {
      plan.push({ authIndex: first, status: 200 });
    }
  }

  const records = [];
  let attemptStartMs = startedMs;
  plan.forEach((step, attempt) => {
    const isFailed = step.status !== 200;
    const latencyMs = step.latencyMs ?? integerBetween(random, spec.latency);
    const finishedMs = attemptStartMs + latencyMs;
    const tokens = tokensFor(random, spec, isFailed);
    const credential = CREDENTIALS[step.authIndex];
    records.push({
      id: recordIdOf(finishedMs, slot, attempt),
      event_key: `${requestId}_${attempt}`,
      request_id: requestId,
      timestamp_ms: attemptStartMs,
      latency_ms: latencyMs,
      ttft_ms: isFailed ? null : Math.round(latencyMs * between(random, spec.ttftShare)),
      model: spec.model,
      response_model: isFailed ? undefined : spec.model,
      provider: credential.provider,
      auth_index: step.authIndex,
      auth_type: credential.auth_type,
      provider_key_mask: credential.provider_key_mask,
      executor_type: 'gateway',
      ...caller,
      reasoning_effort: spec.reasoningEffort,
      service_tier: 'default',
      response_service_tier: isFailed ? undefined : 'default',
      failed: isFailed,
      fail_status_code: isFailed ? step.status : undefined,
      generate: true,
      stream: true,
      tokens,
      // The detail view answers from the captured record, so a live record offers none.
      has_request_log: false,
      ...pricingFor(spec, tokens),
    });
    attemptStartMs = finishedMs;
  });
  return records;
}

/**
 * Every attempt that finished in [fromMs, toMs], newest first.
 *
 * An attempt still running at `toMs` is not returned: CPA records an attempt when it
 * ends, so a reader cannot know of it yet.
 */
export function attemptsBetween(fromMs, toMs, dataset) {
  const callers = callersOf(dataset);
  const rests = cooldownsBetween(fromMs - MAX_REQUEST_MS, toMs);
  const records = [];
  const firstSlot = Math.floor((fromMs - MAX_REQUEST_MS) / SLOT_MS);
  const lastSlot = Math.floor(toMs / SLOT_MS);
  for (let slot = firstSlot; slot <= lastSlot; slot++) {
    for (const record of requestOfSlot(slot, rests, callers)) {
      const finishedMs = record.timestamp_ms + record.latency_ms;
      if (finishedMs >= fromMs && finishedMs <= toMs) records.push(record);
    }
  }
  return records.sort((left, right) => right.id - left.id);
}

/**
 * The routing read: the last minute's attempts, or those recorded after `afterId`, and
 * the credentials resting now - the shape `GET /usage/routing` answers with.
 */
export function routingAt(nowMs, afterId, dataset) {
  const all = attemptsBetween(nowMs - WINDOW_MS, nowMs, dataset);
  const records = afterId === undefined ? all : all.filter((record) => record.id > afterId);
  const cooldowns = cooldownsBetween(nowMs, nowMs)
    .filter((rest) => rest.startMs <= nowMs && nowMs < rest.untilMs)
    .map((rest) => ({
      auth_index: rest.authIndex,
      provider: CREDENTIALS[rest.authIndex].provider,
      status_code: 429,
      quota_exceeded: rest.isQuotaExceeded,
      until_at_ms: rest.untilMs,
    }));
  return { as_of_ms: nowMs, window_ms: WINDOW_MS, records, has_more: false, cooldowns };
}

/**
 * When the live stream tells the console to read, for the attempts recorded in
 * (fromMs, toMs], ascending.
 *
 * Like the gateway's coalescing hub, a burst costs one read: an attempt recorded at or
 * before a signal already scheduled is found by that signal's read, so it schedules
 * nothing, and the next signal waits at least `minGapMs` after the last.
 */
export function signalInstantsBetween(fromMs, toMs, dataset, minGapMs) {
  const recorded = attemptsBetween(fromMs, toMs, dataset)
    .map((record) => record.timestamp_ms + record.latency_ms)
    .filter((instant) => instant > fromMs)
    .sort((left, right) => left - right);
  const signals = [];
  let last = -Infinity;
  for (const instant of recorded) {
    if (instant <= last) continue;
    last = Math.max(instant, last + minGapMs);
    signals.push(last);
  }
  return signals;
}
