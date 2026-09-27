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

export function filterAuditEvents(decoded, url) {
  if (!decoded || !Array.isArray(decoded.events)) return decoded;
  const params = url.searchParams;
  const categories = params
    .getAll('category')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const outcome = params.get('outcome') ?? '';
  const needle = (params.get('q') ?? '').trim().toLowerCase();
  const fold = params.get('fold') !== '0' && params.get('fold') !== 'false';

  let events = fold ? foldAttempts(decoded.events) : decoded.events;
  if (categories.length > 0) {
    events = events.filter((event) =>
      categories.some((category) => event.action === category || event.action.startsWith(`${category}.`)),
    );
  }
  if (outcome === 'failed') events = events.filter((event) => FAILED_RESULTS.has(event.result));
  if (outcome === 'succeeded') events = events.filter((event) => SUCCEEDED_RESULTS.has(event.result));
  if (needle) {
    events = events.filter((event) =>
      [event.action, event.target_type, event.target_id, event.request_id].some((field) =>
        String(field ?? '').toLowerCase().includes(needle),
      ),
    );
  }
  // The capture is one page; a cursor would ask for rows the dataset does not hold.
  return { ...decoded, events: params.has('before') ? [] : events, next_cursor: '' };
}

/** A resumed read returns only what follows the sequence the console last saw. */
export function filterServiceLogs(decoded, url) {
  if (!decoded || !Array.isArray(decoded.records)) return decoded;
  const after = Number(url.searchParams.get('after') ?? 0);
  if (!Number.isFinite(after) || after <= 0) return decoded;
  return { ...decoded, records: decoded.records.filter((record) => record.seq > after), gap: false };
}

const FILTERS = new Map([
  ['/api/v1/management/audit/events', filterAuditEvents],
  ['/api/v1/management/service-logs', filterServiceLogs],
]);

export function applyQueryFilters(decoded, url) {
  const filter = FILTERS.get(url.pathname);
  return filter ? filter(decoded, url) : decoded;
}
