import { vi } from 'vitest';
import type { ProviderItem } from '../../src/types/providers';
import type { HealthStatus } from '../../src/types/resource';
import type { ManagementAuthFile } from '../../src/types/managementAuthFile';

/** A stored OAuth credential: its listing row and the editable fields the detail reads. */
export interface OmcAuthFile {
  file: ManagementAuthFile;
  fields: Record<string, unknown>;
}

/**
 * An in-memory OMC server for rendered tests: one state object behind `/api/*`,
 * answered through the real typed client by stubbing `fetch`.
 *
 * The routes every page leans on (preferences, providers, plugins) are stateful, so a
 * write is visible to the next read exactly as on the server, and a remount reads what
 * the previous mount stored. A test adds the endpoints its component needs with `on`,
 * holds a response with `hold` to observe an in-flight state, and reads `requests` to
 * assert what was sent. A request nothing answers fails the test in `setup.ts` rather
 * than turning into a rejected query the component may swallow.
 */

export interface OmcState {
  preferences: Record<string, unknown>;
  serverTimezone: string;
  plugins: unknown[];
  providers: ProviderItem[];
  health: HealthStatus;
  authFiles: OmcAuthFile[];
}

export interface OmcRequest {
  method: string;
  /**
   * The path below `/api/v1`, e.g. `/preferences/omc_tps_calculation_mode`; a route
   * outside v1 keeps its whole path, e.g. `/api/healthz`.
   */
  path: string;
  query: URLSearchParams;
  body: unknown;
  init: RequestInit;
}

/** A handler's reply: a Response as is, anything else as a 200 JSON body. */
type Reply = Response | Promise<Response> | object | string | number | boolean | null;
type Handler = (request: OmcRequest, state: OmcState) => Reply | undefined;

interface Route { method: string; path: string | RegExp; handler: Handler }

export interface HeldResponse {
  /** Resolves once a matching request has arrived. */
  readonly arrived: Promise<OmcRequest>;
  /** Answers the held request; without a reply, the route that would have answered it does. */
  release(reply?: Reply): void;
}

export const API_BASE = '/api/v1';

type ContractFixture = (url: URL, method: string, body: string | null) => { status?: number; json?: unknown };

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function toResponse(reply: Reply): Promise<Response> {
  if (reply instanceof Response) return Promise.resolve(reply);
  if (reply instanceof Promise) return reply;
  return Promise.resolve(json(reply));
}

function matches(route: Route, method: string, path: string) {
  if (route.method !== '*' && route.method !== method) return false;
  return typeof route.path === 'string' ? route.path === path : route.path.test(path);
}

function decodeBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') return body ?? undefined;
  try { return JSON.parse(body); } catch { return body; }
}

const lastSegment = (path: string) => decodeURIComponent(path.split('/').pop() ?? '');

const findAuthFile = (state: OmcState, name: unknown) => state.authFiles.find(entry => entry.file.name === name);

const BUILT_IN_ROUTES: Route[] = [
  { method: 'GET', path: '/management/auth-files', handler: (_request, state) => ({ files: state.authFiles.map(entry => entry.file) }) },
  {
    method: 'GET', path: '/management/auth-files/safe-fields', handler: (request, state) => {
      const entry = findAuthFile(state, request.query.get('name'));
      return entry ? { name: entry.file.name, ...entry.fields } : json({ error: 'auth_file_not_found' }, 404);
    },
  },
  {
    method: 'PATCH', path: '/management/auth-files/fields', handler: (request, state) => {
      const { name, auth_index: _authIndex, ...patch } = request.body as Record<string, unknown>;
      const entry = findAuthFile(state, name);
      if (!entry) return json({ error: 'auth_file_not_found' }, 404);
      entry.fields = { ...entry.fields, ...patch };
      return { status: 'ok', file: entry.file, fields: { name: entry.file.name, ...entry.fields } };
    },
  },
  { method: 'GET', path: '/api/healthz', handler: (_request, state) => state.health },
  { method: 'GET', path: '/preferences', handler: (_request, state) => ({ preferences: state.preferences, time_zone: { server_timezone: state.serverTimezone } }) },
  {
    method: 'PUT', path: /^\/preferences\/[^/]+$/, handler: (request, state) => {
      const key = lastSegment(request.path);
      state.preferences[key] = request.body;
      return { key, value: request.body };
    },
  },
  { method: 'GET', path: '/management/plugins', handler: (_request, state) => ({ plugins: state.plugins }) },
  { method: 'GET', path: '/management/providers', handler: (_request, state) => ({ providers: state.providers }) },
  {
    method: 'PUT', path: /^\/management\/providers\/[^/]+$/, handler: (request, state) => {
      const id = lastSegment(request.path);
      const index = state.providers.findIndex(provider => provider.id === id);
      if (index < 0) return json({ error: 'provider_not_found' }, 404);
      state.providers[index] = { ...state.providers[index], ...(request.body as Partial<ProviderItem>) };
      return { status: 'ok', id, ids: [id] };
    },
  },
  {
    method: 'POST', path: '/management/providers', handler: (request, state) => {
      const body = request.body as Partial<ProviderItem> & { family: string };
      const id = `${body.family}-${state.providers.filter(provider => provider.family === body.family).length}`;
      state.providers.push({ ...body, id } as ProviderItem);
      return { status: 'ok', family: body.family, id, ids: [id] };
    },
  },
];

export interface OmcApi {
  readonly state: OmcState;
  readonly requests: OmcRequest[];
  /** Requests that changed something, optionally only those whose path ends with `suffix`. */
  writes(suffix?: string): OmcRequest[];
  /** The preference documents written, in order, as `{ key, value }`. */
  preferenceWrites(): { key: string; value: unknown }[];
  /** Answers `method path` before every earlier route; return undefined to pass it on. */
  on(method: string, path: string | RegExp, handler: Handler): void;
  /**
   * Answers `path` from a contract fixture under `scripts/acceptance/`, the stateful
   * `(url, method, body) => { status, json }` form the probes and the Go contract
   * tests share, so all three layers read one model of that surface.
   */
  serve(path: string | RegExp, fixture: ContractFixture): void;
  /** Holds the next matching request until the test releases it. */
  hold(method: string, path: string | RegExp): HeldResponse;
  readonly unexpected: string[];
}

let current: OmcApi | undefined;

/** Installs the server for the current test; `setup.ts` checks and removes it afterwards. */
export function installOmcApi(seed: Partial<OmcState> = {}): OmcApi {
  const state: OmcState = {
    preferences: {}, serverTimezone: 'UTC', plugins: [], providers: [], authFiles: [],
    health: { status: 'ok', cpa_connected: true, cpa_management_api: 'v8', database_status: 'ok' },
    ...seed,
  };
  const requests: OmcRequest[] = [];
  const unexpected: string[] = [];
  const routes: Route[] = [...BUILT_IN_ROUTES];
  const holds: { method: string; path: string | RegExp; arrive: (request: OmcRequest) => void; reply: Promise<Reply | undefined> }[] = [];

  const answer = (request: OmcRequest): Promise<Response> => {
    for (const route of routes) {
      if (!matches(route, request.method, request.path)) continue;
      const reply = route.handler(request, state);
      if (reply !== undefined) return toResponse(reply);
    }
    const description = `${request.method} ${request.path}${request.query.size ? `?${request.query}` : ''}`;
    unexpected.push(description);
    return Promise.reject(new Error(`No in-memory OMC route answers ${description}`));
  };

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), window.location.origin);
    if (!url.pathname.startsWith('/api/')) {
      unexpected.push(`${init.method ?? 'GET'} ${url.pathname}`);
      throw new Error(`Request outside the OMC API: ${url.pathname}`);
    }
    const request: OmcRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname.startsWith(`${API_BASE}/`) ? url.pathname.slice(API_BASE.length) : url.pathname,
      query: url.searchParams,
      body: decodeBody(init.body),
      init,
    };
    requests.push(request);
    // The console authenticates by its session cookie; a request that leaves it out
    // would be refused by the real server however the test answers it.
    if (init.credentials !== 'same-origin') unexpected.push(`${request.method} ${request.path} without credentials: 'same-origin'`);
    const heldIndex = holds.findIndex(held => matches({ ...held, handler: () => undefined }, request.method, request.path));
    if (heldIndex >= 0) {
      const [held] = holds.splice(heldIndex, 1);
      held.arrive(request);
      const reply = await held.reply;
      return reply === undefined ? answer(request) : toResponse(reply);
    }
    return answer(request);
  }));

  const api: OmcApi = {
    state,
    requests,
    unexpected,
    writes: suffix => requests.filter(request => request.method !== 'GET' && (!suffix || request.path.endsWith(suffix))),
    preferenceWrites: () => requests
      .filter(request => request.method === 'PUT' && request.path.startsWith('/preferences/'))
      .map(request => ({ key: lastSegment(request.path), value: request.body })),
    on: (method, path, handler) => { routes.unshift({ method, path, handler }); },
    serve: (path, fixture) => {
      routes.unshift({
        method: '*', path, handler: request => {
          const url = new URL(`${API_BASE}${request.path}${request.query.size ? `?${request.query}` : ''}`, window.location.origin);
          const result = fixture(url, request.method, typeof request.init.body === 'string' ? request.init.body : null);
          return json('json' in result ? result.json : result, result.status ?? 200);
        },
      });
    },
    hold: (method, path) => {
      let arrive!: (request: OmcRequest) => void;
      let release!: (reply?: Reply) => void;
      const arrived = new Promise<OmcRequest>(resolve => { arrive = resolve; });
      const reply = new Promise<Reply | undefined>(resolve => { release = resolve; });
      holds.push({ method, path, arrive, reply });
      return { arrived, release };
    },
  };
  current = api;
  return api;
}

/** Called by `setup.ts` after each test. */
export function finishOmcApi() {
  const api = current;
  current = undefined;
  if (api && api.unexpected.length > 0) {
    throw new Error(`Requests no in-memory OMC route answered:\n  ${api.unexpected.join('\n  ')}`);
  }
}
