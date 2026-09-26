/**
 * The public demonstration's API.
 *
 * This Worker serves the responses the console reads, from a dataset generated out of
 * the real Go handlers (`scripts/generate-demo-data.mjs`). It exists because the
 * demonstration used to run the whole Go binary for one purpose - to answer these
 * reads - and the hosting that could run it imposed a container-image quota that broke
 * deployments. The console is the same build either way; what changes is that the
 * answers are now data.
 *
 * Two properties matter more than any feature here.
 *
 * **It never looks stale.** The dataset is captured against a fixed instant, and every
 * response is re-based onto the viewer's clock as it is served, so a window the
 * console asks for as "the last 24 hours" is always the last 24 hours. A frozen
 * recording would show an empty chart within a day, which is the failure this design
 * exists to avoid. The re-basing shifts every timestamp by one delta, so the panels
 * that have to agree still agree.
 *
 * **It never reaches outside itself.** There is no forwarding, no fallback origin and
 * no arbitrary URL handling. A path that is not in the dataset is refused. The
 * demonstration's promise that opening it causes no outbound request is a property of
 * this code rather than a claim about the environment.
 */
import { DATASET, REFERENCE_MS, presetOf, responseNameFor } from './routes.mjs';
import { rebase } from './time.mjs';
/** Marker the console reads to render its own demonstration notices. */
const DEMO_HEADER = 'X-OMCPA-Demo';

/** Refusal code the console renders as "this is disabled in the demonstration". */
const REFUSED_CODE = 'demo_operation_refused';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // Nothing here is durable, and a cached refusal would outlive a code change.
  'Cache-Control': 'no-store',
  [DEMO_HEADER]: 'active',
};

/**
 * Operations the demonstration refuses.
 *
 * The list is checked before the dataset, so a write cannot be answered by a
 * coincidence of path matching. Everything that would leave the demonstration - a
 * sign-in, a credential movement, a plugin execution, a gateway configuration write, a
 * quota spend - is refused here rather than merely missing, because a client that
 * receives a shaped refusal renders the console's own explanation while a missing
 * route would look like a broken deployment.
 */
function isRefused(request) {
  const method = request.method.toUpperCase();
  const { pathname } = new URL(request.url);
  if (method === 'GET' || method === 'HEAD') {
    return (
      pathname === '/api/v1/management/auth-files/download' ||
      pathname.startsWith('/api/v1/management/request-error-logs/') ||
      pathname.endsWith('/request-log')
    );
  }
  // Everything else that is not a read: the demonstration has nothing durable to
  // write to, and saying so is more honest than failing halfway through.
  return pathname.startsWith('/api/');
}

function refusedResponse() {
  return new Response(
    JSON.stringify({
      code: REFUSED_CODE,
      error: 'this operation is disabled in the demonstration',
    }),
    { status: 403, headers: JSON_HEADERS },
  );
}

function notFoundResponse(pathname) {
  return new Response(
    JSON.stringify({
      code: 'demo_route_unknown',
      error: `the demonstration does not answer ${pathname}`,
    }),
    { status: 404, headers: JSON_HEADERS },
  );
}

/**
 * The preset a window was captured under, which the response cannot know.
 *
 * The dataset holds closed windows - `from`/`to` on the reference - because a preset
 * resolves against the wall clock at capture time and two exports would then disagree.
 * The console, however, labels its range picker from the `preset` the response echoes,
 * so a window captured as explicit bounds would leave the picker showing "custom"
 * after a visitor chose "7 days". The Worker knows which preset was asked for, so it
 * says so.
 */
function labelPreset(payload, preset) {
  if (!preset || !payload || typeof payload !== 'object') return payload;
  if (!payload.window || typeof payload.window !== 'object') return payload;
  return { ...payload, window: { ...payload.window, preset } };
}

/**
 * Renders one dataset response for this request.
 *
 * The body is parsed, re-based and re-serialised rather than string-replaced: the
 * timestamps sit at different depths in different responses, and the relationships
 * between them - a window's bounds against its buckets, an event against the range it
 * is listed in - are what keep the panels consistent with each other.
 */
/**
 * The identity fields a request record's detail has to carry from the row it was opened from.
 *
 * The dataset holds one captured detail, and it is served for whichever record a visitor
 * opens. Without this the drawer showed a different request than the row that was clicked -
 * a mismatched request id, model and provider, which is the demonstration contradicting the
 * list on the same screen.
 */
const EVENT_IDENTITY_FIELDS = [
  'id',
  'event_key',
  'request_id',
  'timestamp_ms',
  'model',
  'provider',
  'auth_index',
  'auth_type',
  'executor_type',
  'api_group_key',
  'api_group_label',
  'api_key_mask',
  'api_key_alias',
  'failed',
  'has_request_log',
];

/** The code a caller reads when it asks for a record the dataset does not hold. */
const RECORD_UNKNOWN_CODE = 'demo_record_unknown';

/** The path of a request record's detail, and the id it names. */
const EVENT_DETAIL_PATH = /^\/api\/v1\/usage\/events\/(\d+)$/;

/**
 * Rewrites a served detail so it describes the record that was asked for.
 *
 * The identity comes from the list capture, which is the same data the row was rendered
 * from, so the two cannot disagree. The measured fields - latency, tokens, cost - stay the
 * capture's: they are what the record looks like, and inventing them per id would be a
 * number this fixture cannot support.
 */
function matchEventIdentity(decoded, pathname, dataset) {
  const match = EVENT_DETAIL_PATH.exec(pathname);
  if (!match) return decoded;
  const wanted = Number(match[1]);
  let rows;
  try {
    rows = JSON.parse(dataset.responses['usage-events'].body).items ?? [];
  } catch {
    return decoded;
  }
  const row = rows.find((item) => item.id === wanted);
  const event = decoded?.event;
  if (!event) return decoded;
  if (!row) {
    // A record the dataset does not hold. Answering it with the captured record's detail
    // would describe a request the visitor never asked for, so the drawer is told there is
    // nothing here instead - and with a status that says so, because a 200 carrying an error
    // body would be read as a successful detail that happens to have no event in it.
    return undefined;
  }
  for (const field of EVENT_IDENTITY_FIELDS) {
    if (row[field] !== undefined) event[field] = row[field];
  }
  return decoded;
}

function serve(entry, nowMs, url) {
  const deltaMs = nowMs - REFERENCE_MS;
  let body = entry.body;
  try {
    // The identity is substituted on the capture and then re-based with it, rather than
    // after: the row's `timestamp_ms` is on the capture's calendar like every other
    // instant in the response, so copying it in afterwards left the detail dated months
    // away from the list row it was opened from.
    const identity = matchEventIdentity(JSON.parse(entry.body), url.pathname, DATASET);
    if (identity === undefined) {
      // The record this path names is not in the dataset, which is a 404 rather than a
      // degraded answer: there is nothing to show and no capture to fall back to.
      return new Response(
        JSON.stringify({ error: 'this record is not part of the demonstration', code: RECORD_UNKNOWN_CODE }),
        { status: 404, headers: { ...JSON_HEADERS, 'Content-Type': entry.content_type } },
      );
    }
    const decoded = rebase(identity, deltaMs);
    const preset = url.searchParams.has('preset') ? presetOf(url) : '';
    body = JSON.stringify(labelPreset(decoded, preset));
  } catch {
    // A body that is not JSON is served as captured. There are none today; this keeps
    // a future binary response from being corrupted by the walk.
  }
  return new Response(body, {
    status: entry.status,
    headers: { ...JSON_HEADERS, 'Content-Type': entry.content_type },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (!pathname.startsWith('/api/')) {
      // Not an API path, so it belongs to the static assets. Handing the request back
      // to the asset binding is what lets the SPA's routes and its chunks coexist with
      // these responses.
      return env.ASSETS.fetch(request);
    }

    if (isRefused(request)) return refusedResponse();

    // Every read comes from the dataset, including `/api/healthz`.
    //
    // That endpoint was hardcoded here first, with a minimal `{status, version}` body,
    // on the reasoning that a health check deserves a cheaper answer than a JSON walk.
    // It cost more than it saved: the console's header reads `cpa_connected` from that
    // response to decide whether to show the gateway as reachable, so the field's
    // absence made the demonstration display "CPA offline" on every page while the
    // overview reported the gateway connected. A hand-written response beside a generated
    // dataset is one that drifts from it, and this one drifted immediately.
    const name = responseNameFor(request);
    const entry = name ? DATASET.responses[name] : undefined;
    if (!entry) return notFoundResponse(pathname);

    return serve(entry, Date.now(), new URL(request.url));
  },
};
