/**
 * Query semantics for the captured reads whose answer depends on a filter.
 *
 * The dataset holds one capture per surface. For most surfaces the console's filters
 * are already accounted for by the captured window, but the audit trail and the
 * service log are read with parameters that select rows - a category, an outcome,
 * a sequence to resume after - and answering every one of them with the whole capture
 * would make a working filter look broken. These mirror the server's own rules on the
 * captured rows instead.
 */

const FAILED_RESULTS = new Set(['failure', 'error', 'rejected', 'denied', 'uncertain', 'partial']);
const SUCCEEDED_RESULTS = new Set(['success', 'checked', 'cached', 'admitted']);

/** The same folding the repository applies: an attempt is hidden once its outcome exists. */
function foldAttempts(events) {
  const finished = new Set(
    events
      .filter((event) => event.result !== 'attempt' && event.request_id)
      .map((event) => `${event.request_id}\u0000${event.action}`),
  );
  return events.filter(
    (event) => event.result !== 'attempt' || !event.request_id || !finished.has(`${event.request_id}\u0000${event.action}`),
  );
}

/** The outcome class the repository gives a stored result (`auditOutcomeClass`). */
function outcomeOf(result) {
  if (result === 'attempt') return 'unfinished';
  if (SUCCEEDED_RESULTS.has(result)) return 'succeeded';
  if (FAILED_RESULTS.has(result)) return 'failed';
  return 'other';
}

/**
 * The rows every audit read starts from: folded unless asked otherwise, inside the
 * `since_ms` window and matching the search. The captured instants are on the dataset's
 * calendar while `since_ms` is on the viewer's, so the window is moved by the same delta
 * the response will be re-based with.
 */
function windowedAuditEvents(events, params, deltaMs) {
  const needle = (params.get('q') ?? '').trim().toLowerCase();
  const fold = params.get('fold') !== '0' && params.get('fold') !== 'false';
  const since = Number(params.get('since_ms') ?? 0);
  let rows = fold ? foldAttempts(events) : events;
  if (Number.isFinite(since) && since > 0) rows = rows.filter((event) => event.occurred_at_ms + deltaMs >= since);
  if (needle) {
    rows = rows.filter((event) =>
      [event.action, event.target_type, event.target_id, event.request_id].some((field) =>
        String(field ?? '').toLowerCase().includes(needle),
      ),
    );
  }
  return rows;
}

export function filterAuditEvents(decoded, url, { deltaMs = 0 } = {}) {
  if (!decoded || !Array.isArray(decoded.events)) return decoded;
  const params = url.searchParams;
  const categories = params
    .getAll('category')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const outcome = params.get('outcome') ?? '';

  let events = windowedAuditEvents(decoded.events, params, deltaMs);
  if (categories.length > 0) {
    events = events.filter((event) =>
      categories.some((category) => event.action === category || event.action.startsWith(`${category}.`)),
    );
  }
  if (outcome === 'failed' || outcome === 'succeeded' || outcome === 'unfinished') {
    events = events.filter((event) => outcomeOf(event.result) === outcome);
  }
  // The capture is one page; a cursor would ask for rows the dataset does not hold.
  return { ...decoded, events: params.has('before') ? [] : events, next_cursor: '' };
}

/**
 * The summary is counted from the captured trail rather than served as captured, so its
 * facets always describe the rows the timeline beside them shows for the same window and
 * search. Category, outcome and cursor are ignored, as the server ignores them.
 */
export function summarizeAuditEvents(decoded, url, { deltaMs = 0, dataset } = {}) {
  let trail;
  try {
    trail = JSON.parse(dataset?.responses?.['audit-events']?.body ?? 'null')?.events;
  } catch {
    trail = undefined;
  }
  if (!Array.isArray(trail)) return decoded;
  const counts = new Map();
  for (const event of windowedAuditEvents(trail, url.searchParams, deltaMs)) {
    const dot = event.action.indexOf('.');
    const prefix = dot > 0 ? event.action.slice(0, dot) : event.action;
    const key = `${prefix}\u0000${outcomeOf(event.result)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const buckets = [...counts.entries()]
    .map(([key, count]) => {
      const [prefix, outcome] = key.split('\u0000');
      return { prefix, outcome, count };
    })
    .sort((left, right) => left.prefix.localeCompare(right.prefix) || left.outcome.localeCompare(right.outcome));
  return { ...decoded, buckets };
}

/**
 * A resumed read returns only what follows the sequence the console last saw, and a limit
 * keeps the newest records and reports the skip - the server's own rule.
 */
export function filterServiceLogs(decoded, url) {
  if (!decoded || !Array.isArray(decoded.records)) return decoded;
  const after = Number(url.searchParams.get('after') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 0);
  let records = Number.isFinite(after) && after > 0 ? decoded.records.filter((record) => record.seq > after) : decoded.records;
  let gap = false;
  if (Number.isInteger(limit) && limit > 0 && records.length > limit) {
    records = records.slice(records.length - limit);
    gap = true;
  }
  return { ...decoded, records, gap };
}

const FILTERS = new Map([
  ['/api/v1/management/audit/events', filterAuditEvents],
  ['/api/v1/management/audit/summary', summarizeAuditEvents],
  ['/api/v1/management/service-logs', filterServiceLogs],
  ['/api/v1/usage/events', filterUsageEvents],
  ['/api/v1/usage/facets', filterUsageFacets],
]);

/**
 * Filters captured usage events against query parameters (`q`, `result`, `model`,
 * `provider`, `auth_index`, `api_key`, `source`, `preset`, `from`/`to`, `limit`, `cursor`)
 * so filtering, searching, and pagination on Request Events work accurately in the Worker.
 */
export function filterUsageEvents(decoded, url, { deltaMs = 0 } = {}) {
  if (!decoded || !Array.isArray(decoded.items)) return decoded;
  const params = url.searchParams;
  const win = presetWindowBounds(decoded.window, params, deltaMs, decoded.items);
  const filtered = matchUsageItems(decoded.items, params, deltaMs, win);

  const cursor = params.get('cursor') ?? '';
  const limitRaw = Number(params.get('limit') ?? decoded.limit ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  // When no query filter is active, keep the captured page bounds, cursor, and limit intact
  // so default unfiltered reads remain identical to the backend's capture.
  const hasFilter = Boolean(
    params.get('q') ||
    (params.get('result') && params.get('result') !== 'all') ||
    params.get('model') ||
    params.get('model_alias') ||
    params.get('provider') ||
    params.get('auth_index') ||
    params.get('auth_type') ||
    params.get('api_key') ||
    params.get('source') ||
    params.get('executor') ||
    params.get('reasoning') ||
    params.get('service_tier') ||
    params.get('resolved_service_tier') ||
    (params.get('cost') && params.get('cost') !== 'all') ||
    (params.get('transport') && params.get('transport') !== 'all') ||
    params.has('min_latency_ms') ||
    params.has('max_latency_ms') ||
    params.has('from') ||
    params.has('to') ||
    params.has('preset') ||
    params.has('cursor') ||
    params.has('limit'),
  );
  if (!hasFilter) return decoded;

  let startIndex = 0;
  if (cursor) {
    const idx = filtered.findIndex((item) => String(item.id) === cursor);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }
  const items = filtered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < filtered.length;
  const nextCursor = hasMore && items.length > 0 ? String(items[items.length - 1].id) : '';

  return {
    ...decoded,
    window: win,
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    limit,
  };
}

/**
 * Recomputes usage facets from the captured `usage-events` items for the same window/search
 * so facet counts agree with the filtered list.
 */
export function filterUsageFacets(decoded, url, { deltaMs = 0, dataset } = {}) {
  let rawPayload;
  try {
    rawPayload = JSON.parse(dataset?.responses?.['usage-events']?.body ?? 'null');
  } catch {
    rawPayload = undefined;
  }
  const rawItems = rawPayload?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) return decoded;
  const params = url.searchParams;
  const win = presetWindowBounds(decoded.window ?? rawPayload?.window, params, deltaMs, rawItems);
  const winItems = matchUsageItems(rawItems, new URLSearchParams({
    ...(params.has('preset') ? { preset: params.get('preset') } : {}),
    ...(params.has('from') ? { from: params.get('from') } : {}),
    ...(params.has('to') ? { to: params.get('to') } : {}),
    ...(params.has('q') ? { q: params.get('q') } : {}),
  }), deltaMs, win);
  if (winItems.length === 0 && !params.has('q') && !params.has('preset') && !params.has('from')) return decoded;

  const countBy = (getter) => {
    const map = new Map();
    for (const item of winItems) {
      const value = getter(item);
      if (!value) continue;
      map.set(value, (map.get(value) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };

  return {
    ...decoded,
    window: win ?? decoded.window,
    facets: {
      ...(decoded.facets ?? {}),
      models: countBy((i) => i.model),
      model_aliases: countBy((i) => i.model_alias),
      providers: countBy((i) => i.provider),
      auth_indexes: countBy((i) => i.auth_index),
      auth_types: countBy((i) => i.auth_type),
      executors: countBy((i) => i.executor_type),
      sources: countBy((i) => i.source),
      api_group_keys: countBy((i) => i.api_group_key),
      reasoning_efforts: countBy((i) => i.reasoning_effort),
      service_tiers: countBy((i) => i.service_tier),
      resolved_service_tiers: countBy((i) => i.resolved_service_tier),
    },
  };
}

const USAGE_PRESET_MS = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '90d': 90 * 24 * 60 * 60_000,
};

function presetWindowBounds(baseWindow, params, deltaMs, items = []) {
  const fromParam = Number(params.get('from'));
  const toParam = Number(params.get('to'));
  if (Number.isFinite(fromParam) && Number.isFinite(toParam) && toParam > fromParam) {
    return {
      ...(baseWindow ?? {}),
      from: fromParam - deltaMs,
      to: toParam - deltaMs,
      preset: params.get('preset') ?? 'custom',
    };
  }
  const preset = (params.get('preset') ?? baseWindow?.preset ?? '').toLowerCase();
  const duration = USAGE_PRESET_MS[preset];
  if (duration) {
    let anchorTo = typeof baseWindow?.to === 'number' ? baseWindow.to : null;
    if (anchorTo === null && items.length > 0) {
      anchorTo = items.reduce((max, item) => Math.max(max, item.timestamp_ms ?? 0), 0);
    }
    if (anchorTo !== null) {
      return {
        ...(baseWindow ?? {}),
        from: anchorTo - duration,
        to: anchorTo,
        preset,
      };
    }
  }
  return baseWindow;
}

function matchUsageItems(items, params, deltaMs, resolvedWindow = null) {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const result = (params.get('result') ?? 'all').toLowerCase();
  const models = new Set(params.getAll('model').filter(Boolean));
  const modelAliases = new Set(params.getAll('model_alias').filter(Boolean));
  const providers = new Set(params.getAll('provider').filter(Boolean));
  const authIndexes = new Set(params.getAll('auth_index').filter(Boolean));
  const authTypes = new Set(params.getAll('auth_type').filter(Boolean));
  const apiKeys = new Set(params.getAll('api_key').filter(Boolean));
  const sources = new Set(params.getAll('source').filter(Boolean));
  const executors = new Set(params.getAll('executor').filter(Boolean));
  const reasoning = new Set(params.getAll('reasoning').filter(Boolean));
  const serviceTiers = new Set(params.getAll('service_tier').filter(Boolean));
  const resolvedTiers = new Set(params.getAll('resolved_service_tier').filter(Boolean));
  const cost = (params.get('cost') ?? 'all').toLowerCase();
  const transport = (params.get('transport') ?? 'all').toLowerCase();
  const minLatency = params.has('min_latency_ms') ? Number(params.get('min_latency_ms')) : null;
  const maxLatency = params.has('max_latency_ms') ? Number(params.get('max_latency_ms')) : null;

  let fromCaptured = null;
  let toCaptured = null;
  const fromParam = Number(params.get('from'));
  const toParam = Number(params.get('to'));
  if (Number.isFinite(fromParam) && Number.isFinite(toParam) && toParam > fromParam) {
    fromCaptured = fromParam - deltaMs;
    toCaptured = toParam - deltaMs;
  } else if ((params.has('preset') || resolvedWindow) && resolvedWindow && typeof resolvedWindow.from === 'number' && typeof resolvedWindow.to === 'number') {
    fromCaptured = resolvedWindow.from;
    toCaptured = resolvedWindow.to;
  }

  return items.filter((item) => {
    if (fromCaptured !== null && (item.timestamp_ms ?? 0) < fromCaptured) return false;
    if (toCaptured !== null && (item.timestamp_ms ?? 0) > toCaptured) return false;
    if (result === 'success' && item.failed) return false;
    if (result === 'failed' && !item.failed) return false;
    if (models.size > 0 && !models.has(item.model)) return false;
    if (modelAliases.size > 0 && !modelAliases.has(item.model_alias ?? '')) return false;
    if (providers.size > 0 && !providers.has(item.provider)) return false;
    if (authIndexes.size > 0 && !authIndexes.has(item.auth_index ?? '')) return false;
    if (authTypes.size > 0 && !authTypes.has(item.auth_type ?? '')) return false;
    if (apiKeys.size > 0 && !apiKeys.has(item.api_group_key ?? '')) return false;
    if (sources.size > 0 && !sources.has(item.source ?? '')) return false;
    if (executors.size > 0 && !executors.has(item.executor_type ?? '')) return false;
    if (reasoning.size > 0 && !reasoning.has(item.reasoning_effort ?? '')) return false;
    if (serviceTiers.size > 0 && !serviceTiers.has(item.service_tier ?? '')) return false;
    if (resolvedTiers.size > 0 && !resolvedTiers.has(item.resolved_service_tier ?? '')) return false;
    if (cost === 'priced' && item.pricing_status !== 'priced') return false;
    if (cost === 'unpriced' && item.pricing_status === 'priced') return false;
    if (transport === 'stream' && item.stream !== true) return false;
    if (transport === 'non_stream' && item.stream !== false) return false;
    if (minLatency !== null && Number.isFinite(minLatency) && (item.latency_ms ?? 0) < minLatency) return false;
    if (maxLatency !== null && Number.isFinite(maxLatency) && (item.latency_ms ?? 0) > maxLatency) return false;
    if (q) {
      const hay = [
        item.model,
        item.model_alias,
        item.response_model,
        item.provider,
        item.request_id,
        item.api_key_alias,
        item.api_key_mask,
        item.source,
        item.auth_index,
      ].map((v) => String(v ?? '').toLowerCase()).join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * `context.deltaMs` is the re-basing delta the response will be served with, and
 * `context.dataset` the whole dataset, for a read derived from another capture.
 */
export function applyQueryFilters(decoded, url, context = {}) {
  const filter = FILTERS.get(url.pathname);
  return filter ? filter(decoded, url, context) : decoded;
}
