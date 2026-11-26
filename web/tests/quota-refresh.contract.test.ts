// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { quotaRefreshFailureReason, refreshCredentialQuotas } from '../src/utils/quotaRefresh';
import { api, ApiError } from '../src/api/client';
import type { TFunc } from '../src/i18n';
import type { QuotaItem } from '../src/types/quota';

let cleanupDemoSandbox: (() => void) | null = null;
afterEach(() => {
  cleanupDemoSandbox?.();
  cleanupDemoSandbox = null;
  vi.unstubAllGlobals();
});

const reading = (authIndex: string, extra: Partial<QuotaItem> = {}) => ({ auth_index: authIndex, name: `${authIndex}.json`, status: 'ok', ...extra });
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A response whose frames are written one by one, each only when the test releases it. */
function streamedResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

it('hands each reading over as it lands, before the slowest credential of the batch answers', async () => {
  const stream = streamedResponse();
  const calls: RequestInit[] = [];
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
    calls.push(options);
    return stream.response;
  });

  const landed: string[] = [];
  let reportFirst!: () => void;
  const firstLanded = new Promise<void>((resolve) => { reportFirst = resolve; });
  const run = refreshCredentialQuotas(['fast', 'failing', 'slow', 'missing'], (item) => {
    landed.push(item.auth_index);
    reportFirst();
  });

  stream.write(frame('quota', reading('fast')));
  await firstLanded;
  // The batch is still open: `slow` has not answered, yet `fast` is already with the caller.
  expect(landed).toEqual(['fast']);

  stream.write(frame('quota', reading('failing', { status: 'error', error: 'HTTP 401' })));
  stream.write(frame('quota', reading('slow')));
  stream.write(frame('done', { status: 'ok', total: 3 }));
  stream.close();

  const outcome = await run;
  expect(landed).toEqual(['fast', 'failing', 'slow']);
  expect(outcome.succeeded).toBe(2);
  expect(outcome.failures).toEqual([{ authIndex: 'failing', name: 'failing.json', error: 'HTTP 401' }]);
  expect(outcome.unknownIndexes).toEqual(['missing']);
  expect(JSON.parse(calls[0].body as string)).toEqual({ auth_indexes: ['fast', 'failing', 'slow', 'missing'] });
  expect((calls[0].headers as Record<string, string>).Accept).toBe('text/event-stream');
});

it('the demonstration answers a batch refresh with the same stream', async () => {
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc', demo: true } });
  vi.stubGlobal('fetch', async (path: string) => {
    // The sandbox reads the baseline overview once; every other request stays in the browser.
    if (!path.endsWith('/management/quota')) throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify({ quotas: [reading('demo-a'), reading('demo-b')] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const { resetDemoSandbox } = await import('../src/demo/sandbox');
  cleanupDemoSandbox = resetDemoSandbox;
  resetDemoSandbox();

  const landed: string[] = [];
  const outcome = await refreshCredentialQuotas(['demo-a', 'demo-b', 'demo-missing'], (item) => landed.push(item.auth_index));
  expect(landed).toEqual(['demo-a', 'demo-b']);
  expect(outcome.succeeded).toBe(2);
  expect(outcome.unknownIndexes).toEqual(['demo-missing']);
  expect(outcome.failures).toEqual([]);
});

it('keeps what a cut stream delivered and fails only the credentials it never answered', async () => {
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  vi.stubGlobal('fetch', async () => new Response(frame('quota', reading('fast')), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  }));

  const outcome = await refreshCredentialQuotas(['fast', 'slow']);
  expect(outcome.succeeded).toBe(1);
  expect(outcome.unknownIndexes).toEqual([]);
  expect(outcome.failures.map((failure) => failure.authIndex)).toEqual(['slow']);
  // Named in the reader's language, not with the client's own wording.
  expect(quotaRefreshFailureReason(outcome.failures[0], ((key: string) => key) as TFunc)).toBe('omc.quota_refresh_cut');
});

it('redeemCodexResetCredit forwards an explicit credit_id and omits it when automatic', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath: '/omc' } });
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    expect(url).toBe('/omc/api/v1/management/quota/redeem-credit');
    bodies.push(JSON.parse(String(options?.body ?? '{}')));
    return new Response(JSON.stringify({ status: 'ok', credit_id: 'c-late', quota: reading('codex-1'), cooldown_cleared: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await api.redeemCodexResetCredit('codex-1', ' c-late ');
  await api.redeemCodexResetCredit('codex-1');

  expect(bodies).toEqual([
    { auth_index: 'codex-1', credit_id: 'c-late' },
    { auth_index: 'codex-1' },
  ]);
});

it('demo sandbox rejects duplicate explicit credit redemptions and applies legacy redeemed counts before auto-selection', async () => {
  const store = new Map<string, string>();
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const baselineQuota = reading('codex-demo', {
    windows: [],
    reset_credits: {
      available_count: 3,
      applicable_available_count: 3,
      credits: [
        { id: 'c-3', status: 'available', expires_at_ms: future + 3_000 },
        { id: 'c-1', status: 'available', expires_at_ms: future + 1_000 },
        { id: 'c-2', status: 'available', expires_at_ms: future + 2_000 },
      ],
    },
  });
  const fakeLocalStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  vi.stubGlobal('window', {
    __OMCPA_CONFIG__: { basePath: '/omc', demo: true },
    localStorage: fakeLocalStorage,
    addEventListener: () => undefined,
  });
  vi.stubGlobal('fetch', async (path: string) => {
    if (path.endsWith('/management/auth-files')) {
      return new Response(JSON.stringify({ files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!path.endsWith('/management/quota')) throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify({ quotas: [baselineQuota] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  vi.resetModules();
  const [{ DEMO_SANDBOX_STORAGE_KEY, resetDemoSandbox }, { api: freshApi }] = await Promise.all([
    import('../src/demo/sandbox'),
    import('../src/api/client'),
  ]);
  cleanupDemoSandbox = resetDemoSandbox;
  resetDemoSandbox();

  // Explicit redemption of c-2 succeeds once, then re-redeeming c-2 fails closed with 409 and preserves c-1 & c-3.
  const first = await freshApi.redeemCodexResetCredit('codex-demo', 'c-2');
  expect(first.credit_id).toBe('c-2');
  await expect(freshApi.redeemCodexResetCredit('codex-demo', 'c-2')).rejects.toMatchObject<Partial<ApiError>>({
    status: 409,
    data: expect.objectContaining({ code: 'reset_credit_not_available' }),
  });
  const afterExplicit = await freshApi.getQuotaOverview();
  expect(afterExplicit.quotas[0].reset_credits?.available_count).toBe(2);
  expect(afterExplicit.quotas[0].reset_credits?.credits?.map((c) => c.id)).toEqual(['c-1', 'c-3']);

  // Legacy v1 storage containing redeemedCredits=1 without redeemedCreditIds skips c-1 in both GET and auto-POST.
  const persisted = JSON.parse(store.get(DEMO_SANDBOX_STORAGE_KEY) ?? '{}');
  persisted.quota.redeemedCredits = { 'codex-demo': 1 };
  delete persisted.quota.redeemedCreditIds;
  store.set(DEMO_SANDBOX_STORAGE_KEY, JSON.stringify(persisted));
  // Trigger storage invalidation (or fresh module reload) so loadState() restores the legacy v1 payload.
  vi.resetModules();
  const [{ resetDemoSandbox: resetReloadedSandbox }, { api: reloadedApi }] = await Promise.all([
    import('../src/demo/sandbox'),
    import('../src/api/client'),
  ]);
  cleanupDemoSandbox = resetReloadedSandbox;

  const auto = await reloadedApi.redeemCodexResetCredit('codex-demo');
  expect(auto.credit_id).toBe('c-2');
  const afterAuto = await reloadedApi.getQuotaOverview();
  expect(afterAuto.quotas[0].reset_credits?.available_count).toBe(1);
  expect(afterAuto.quotas[0].reset_credits?.credits?.map((c) => c.id)).toEqual(['c-3']);
});
