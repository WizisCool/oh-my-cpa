// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { quotaRefreshFailureReason, refreshCredentialQuotas } from '../src/utils/quotaRefresh';
import type { TFunc } from '../src/i18n';
import type { QuotaItem } from '../src/types/quota';

afterEach(() => vi.unstubAllGlobals());

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
