// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, requestResponse, setUnauthorizedHandler } from '../src/api/client';
import { createPreferenceFixture, PREFERENCE_CONTRACT, type PreferenceWireCase } from '../../scripts/acceptance/preferences-fixture.mjs';

afterEach(() => { setUnauthorizedHandler(undefined); });

it('consumes the Go-certified corpus through the actual typed API client and stateful fixture', async () => {
  const authorized = createPreferenceFixture();
  const unauthorized = createPreferenceFixture({ authenticated: false });
  const unauthorizedHandler = vi.fn();
  setUnauthorizedHandler(unauthorizedHandler);
  const requests: { path: string; options: RequestInit }[] = [];
  let isAuthenticated = true;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    requests.push({ path, options });
    const fixture = isAuthenticated ? authorized : unauthorized;
    const response = fixture(new URL(path, 'http://127.0.0.1'), options.method ?? 'GET', typeof options.body === 'string' ? options.body : null);
    return new Response(JSON.stringify(response.json), { status: response.status, headers: response.headers });
  }));
  const cases: PreferenceWireCase[] = PREFERENCE_CONTRACT.cases;
  expect(cases.length).toBeGreaterThan(0);
  for (const entry of cases) {
    isAuthenticated = entry.authenticated;
    const key = entry.path.split('/').pop()!;
    const invoke = () => {
      if (entry.method === 'GET') return api.getPreferences();
      let value: unknown;
      try { value = JSON.parse(entry.body!); }
      catch { return requestResponse(`/preferences/${key}`, { method: 'PUT', body: entry.body! }); }
      return api.putPreference(key, value);
    };
    if (entry.status >= 400) {
      await expect(invoke(), entry.id).rejects.toMatchObject({ status: entry.status, message: entry.response.error, data: entry.response });
    } else if (entry.method === 'GET') {
      await expect(invoke(), entry.id).resolves.toEqual({ ...(entry.response.preferences as Record<string, unknown>), omc_server_timezone: (entry.response.time_zone as { server_timezone: string }).server_timezone });
    } else {
      await expect(invoke(), entry.id).resolves.toBeUndefined();
    }
    const request = requests.at(-1)!;
    expect(request.path, entry.id).toBe(entry.path);
    expect(request.options.method, entry.id).toBe(entry.method);
    expect(request.options.credentials, entry.id).toBe('same-origin');
    expect(request.options.headers, entry.id).toMatchObject({ Accept: 'application/json' });
    if (entry.body !== null) {
      expect(request.options.body, entry.id).toBe(entry.body);
      expect(request.options.headers, entry.id).toMatchObject({ 'Content-Type': 'application/json' });
    }
  }
  expect(requests).toHaveLength(cases.length);
  expect(unauthorizedHandler).toHaveBeenCalledTimes(2);
});

it('retains runtime base paths, UTF-8 keepalive admission and error classification', async () => {
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/console/nested' } });
  const requests: { path: string; options: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    requests.push({ path, options });
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }));
  const values = ['a'.repeat(8190), 'a'.repeat(8191), '汉'.repeat(2730), '汉'.repeat(2731)];
  for (const value of values) await api.putPreference('playground_session', value);
  expect(requests.map(request => request.options.keepalive)).toEqual([true, false, true, false]);
  expect(requests.every(request => request.path === '/console/nested/api/v1/preferences/playground_session')).toBe(true);
  expect(requests.map(request => JSON.parse(String(request.options.body)))).toEqual(values);
  const unauthorizedHandler = vi.fn();
  setUnauthorizedHandler(unauthorizedHandler);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"authentication required"}', { status: 401 })));
  await expect(api.getPreferences()).rejects.toBeInstanceOf(ApiError);
  expect(unauthorizedHandler).toHaveBeenCalledTimes(1);
});

it('reads certified non-UTC server metadata rather than silently using the fallback', async () => {
  const alternate = PREFERENCE_CONTRACT.alternate_server;
  const fixture = createPreferenceFixture({ serverTimezone: alternate.timezone });
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    const response = fixture(new URL(path, 'http://127.0.0.1'), options.method ?? 'GET', null);
    expect(response.json).toEqual(alternate.response);
    return new Response(JSON.stringify(response.json), { status: response.status, headers: response.headers });
  }));
  await expect(api.getPreferences()).resolves.toEqual({ omc_server_timezone: alternate.response.time_zone.server_timezone });
});
