// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { api, requestResponse } from '../src/api/client';
import { createWarmupFixture, WARMUP_CONTRACT } from '../../scripts/acceptance/warmup-fixture.mjs';

afterEach(() => vi.unstubAllGlobals());

it('uses the handler-certified wire projection and strict refusals through the typed client', async () => {
  const fixture = createWarmupFixture();
  const calls: { path: string; options: RequestInit }[] = [];
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    const result = fixture(new URL(path, 'http://127.0.0.1'), options.method ?? 'GET', options.body as string);
    return new Response(JSON.stringify('json' in result ? result.json : result), { status: 'status' in result ? result.status : 200, headers: { 'Content-Type': 'application/json' } });
  });
  const credential = await api.getWarmupCredential('exact-claude');
  expect(credential).toEqual(WARMUP_CONTRACT.credential);
  const result = await api.runWarmup('exact-claude', 'manual-wire-test', credential.revision);
  expect(result).toEqual(WARMUP_CONTRACT.result);
  expect(calls.at(-1)?.options.method).toBe('POST');
  expect(JSON.parse(calls.at(-1)?.options.body as string)).toEqual({ request_id: 'manual-wire-test', revision: credential.revision, confirmed: true });
  expect(calls.at(-1)?.options.credentials).toBe('same-origin');
  expect(calls.at(-1)?.path).toBe('/omc/api/v1/management/quota/warmup/credentials/exact-claude/run');
  for (const refusal of WARMUP_CONTRACT.cases) {
    await expect(requestResponse('/management/quota/warmup/credentials/exact-claude/run', { method: 'POST', body: JSON.stringify(refusal.body) })).rejects.toMatchObject({ status: refusal.status, data: refusal.response });
  }
  await api.getWarmupCredential('index/with space');
  expect(calls.at(-1)?.path).toContain('index%2Fwith%20space');
});

it('reads independently persisted model refusal evidence through the typed client', async () => {
  const fixture = createWarmupFixture({ isProtocolPaused: true });
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    const result = fixture(new URL(path, 'http://127.0.0.1'), options.method ?? 'GET', options.body as string);
    return new Response(JSON.stringify(result.json), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });
  const credential = await api.getWarmupCredential('exact-claude');
  expect(credential).toEqual(WARMUP_CONTRACT.paused_credential);
  expect(credential.state.protocol_pause).toEqual({ model: credential.policy.model, reason: 'protocol_unsupported' });
  await api.runWarmup('exact-claude', 'manual-paused-recheck', credential.revision);
  const activated = await api.getWarmupCredential('exact-claude');
  expect(activated.state.protocol_pause).toBeUndefined();
  expect(activated.state.last_result?.status).toBe('activated');
});
