// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { createSystemUpdaterFixture, SYSTEM_UPDATER_CONTRACT } from '../../scripts/acceptance/system-updater-fixture.mjs';

afterEach(() => vi.unstubAllGlobals());

it('reads and applies updates over the handler-certified wire through the typed client', async () => {
  const fixture = createSystemUpdaterFixture();
  const calls: { path: string; options: RequestInit }[] = [];
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    const result = fixture(new URL(path, 'http://127.0.0.1'), options.method ?? 'GET', options.body as string);
    return new Response(JSON.stringify(result.json), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });

  expect(await api.getSystemUpdater()).toEqual(SYSTEM_UPDATER_CONTRACT.ready);
  expect(calls.at(-1)?.path).toBe('/omc/api/v1/management/system/updater');

  for (const refusal of SYSTEM_UPDATER_CONTRACT.refusals) {
    await expect(api.applySystemUpdate(refusal.body.product as 'cpa')).rejects.toMatchObject({ status: refusal.status, data: refusal.response });
  }

  const accepted = await api.applySystemUpdate('omc');
  expect(accepted).toEqual({ ...SYSTEM_UPDATER_CONTRACT.ready, job: SYSTEM_UPDATER_CONTRACT.accepted.job });
  expect(calls.at(-1)?.path).toBe('/omc/api/v1/management/system/updater/apply');
  expect(calls.at(-1)?.options.method).toBe('POST');
  expect(JSON.parse(calls.at(-1)?.options.body as string)).toEqual(SYSTEM_UPDATER_CONTRACT.accepted.body);
  expect(calls.at(-1)?.options.credentials).toBe('same-origin');
});
