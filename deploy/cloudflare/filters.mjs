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
]);

/**
 * `context.deltaMs` is the re-basing delta the response will be served with, and
 * `context.dataset` the whole dataset, for a read derived from another capture.
 */
export function applyQueryFilters(decoded, url, context = {}) {
  const filter = FILTERS.get(url.pathname);
  return filter ? filter(decoded, url, context) : decoded;
}
