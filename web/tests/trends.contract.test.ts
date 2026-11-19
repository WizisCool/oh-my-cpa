// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { trendsQuotaParams, trendsWindowParams, usageGroupBy } from '../src/pages/trends/trendsLogic';

afterEach(() => vi.unstubAllGlobals());

it('sends Trends usage, telemetry, and quota query vocabulary under configured basePath', async () => {
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push(input);
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));

  await api.getTrendsUsage(trendsWindowParams({ preset: '7d' }, 'auto', usageGroupBy('model', 'call'), {}));
  await api.getTrendsTelemetry(trendsWindowParams(
    { from: 1000, to: 5000 },
    'hour',
    usageGroupBy('provider', 'model'),
    { model: ['gpt-5'], provider: ['codex'], api_key: ['hmac:a'], auth_index: ['c1'], client_agent: ['claude-code'] },
  ));
  await api.getTrendsQuota(trendsQuotaParams({ model: ['gpt-5'], provider: ['codex'], auth_index: ['c1'] }));

  expect(requests).toHaveLength(3);
  const usageUrl = new URL(requests[0]!, 'http://127.0.0.1');
  expect(usageUrl.pathname).toBe('/omc/api/v1/management/trends/usage');
  expect(usageUrl.searchParams.get('preset')).toBe('7d');
  expect(usageUrl.searchParams.get('group_by')).toBe('call_point');
  expect(usageUrl.searchParams.has('bucket')).toBe(false);

  const telemetryUrl = new URL(requests[1]!, 'http://127.0.0.1');
  expect(telemetryUrl.pathname).toBe('/omc/api/v1/management/trends/telemetry');
  expect(telemetryUrl.searchParams.get('from')).toBe('1000');
  expect(telemetryUrl.searchParams.get('to')).toBe('5000');
  expect(telemetryUrl.searchParams.get('bucket')).toBe('hour');
  expect(telemetryUrl.searchParams.get('group_by')).toBe('provider');
  expect(telemetryUrl.searchParams.getAll('model')).toEqual(['gpt-5']);
  expect(telemetryUrl.searchParams.getAll('provider')).toEqual(['codex']);
  expect(telemetryUrl.searchParams.getAll('api_key')).toEqual(['hmac:a']);
  expect(telemetryUrl.searchParams.getAll('auth_index')).toEqual(['c1']);
  expect(telemetryUrl.searchParams.getAll('client_agent')).toEqual(['claude-code']);

  const quotaUrl = new URL(requests[2]!, 'http://127.0.0.1');
  expect(quotaUrl.pathname).toBe('/omc/api/v1/management/trends/quota');
  expect(quotaUrl.searchParams.getAll('provider')).toEqual(['codex']);
  expect(quotaUrl.searchParams.getAll('auth_index')).toEqual(['c1']);
  expect(quotaUrl.searchParams.has('model')).toBe(false);
});

it('propagates structured error codes from Trends endpoints', async () => {
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/' } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: 'hourly range limited', code: 'insights_bucket_hour_limit' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  )));

  await expect(api.getTrendsTelemetry('preset=30d&bucket=hour')).rejects.toMatchObject({
    constructor: ApiError,
    status: 400,
    data: { code: 'insights_bucket_hour_limit' },
  });
});
