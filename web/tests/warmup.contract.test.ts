// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { api, requestResponse } from '../src/api/client';
import { pickAutoModel, sortModelsForAuto } from '../src/types/warmup';
import { createWarmupFixture, WARMUP_CONTRACT } from '../../scripts/acceptance/warmup-fixture.mjs';

afterEach(() => vi.unstubAllGlobals());

it('uses the handler-certified wire projection and strict refusals through the typed client', async () => {
  const fixture = createWarmupFixture();
  const calls: { path: string; options: RequestInit }[] = [];
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    const result = fixture(new URL(path, 'http://127.0.0.1'), options.method ?? 'GET', options.body as string);
    return new Response(JSON.stringify(result.json), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });

  const state = await api.getWarmupSettings();
  expect(state).toEqual(WARMUP_CONTRACT.state);

  const runResp = await api.runWarmupTask('t_wire_test');
  expect(runResp.run).toEqual(WARMUP_CONTRACT.run);
  expect(calls.at(-1)?.options.method).toBe('POST');
  expect(calls.at(-1)?.options.credentials).toBe('same-origin');
  expect(calls.at(-1)?.path).toBe('/omc/api/v1/management/quota/warmup/tasks/t_wire_test/run');

  for (const refusal of WARMUP_CONTRACT.cases) {
    await expect(
      requestResponse('/management/quota/warmup/tasks', { method: 'POST', body: JSON.stringify(refusal.body) }),
    ).rejects.toMatchObject({ status: refusal.status, data: refusal.response });
  }
});

it('picks the lightest newest model for Auto mode', () => {
  expect(pickAutoModel(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5');
  expect(pickAutoModel(['gpt-5.2', 'gpt-5.4', 'gpt-5.4-mini'])).toBe('gpt-5.4-mini');
  expect(sortModelsForAuto(['claude-haiku-3-5', 'claude-haiku-4-5', 'claude-sonnet-4-6'])[0]).toBe('claude-haiku-4-5');
  expect(pickAutoModel(['custom-flashlight-v1', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5');
});
