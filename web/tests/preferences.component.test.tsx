import React from 'react';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreference, type PreferenceWrite } from '../src/hooks/usePreference';
import { I18nProvider } from '../src/i18n';
import { TokenDisplayProvider, useTokenDisplayStyle } from '../src/types/tokenDisplayContext';
import { ContextReadout } from '../src/components/workspace/ContextReadout';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}

const parseString = (raw: unknown) => typeof raw === 'string' ? raw : undefined;
const clients: QueryClient[] = [];
let writeResults: Promise<PreferenceWrite>[];
let reads: number;
let isDraining: boolean;
let stored: Record<string, unknown>;
let readResponse: Promise<Response> | undefined;
let writes: { key: string; value: unknown; options: RequestInit; response: ReturnType<typeof deferred<Response>> }[];

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function PreferenceControl({ name, preferenceKey = 'omc_tps_calculation_mode' }: { name: string; preferenceKey?: string }) {
  const preference = usePreference(preferenceKey, 'exclude_ttft', parseString);
  return <section aria-label={name}>
    <output aria-label={`${name} value`}>{preference.value}</output>
    <output aria-label={`${name} ready`}>{String(preference.ready)}</output>
    <button onClick={() => { writeResults.push(preference.set('include_ttft')); }}>{name} include</button>
    <button onClick={() => { writeResults.push(preference.set('exclude_ttft')); }}>{name} exclude</button>
  </section>;
}

function DisplayControl() {
  const { setStyle } = useTokenDisplayStyle();
  return <>
    <button onClick={() => { setStyle('full'); }}>Full token reading</button>
    <ContextReadout usedTokens={10_000} windowTokens={100_000} />
  </>;
}

function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const view = render(<React.StrictMode><QueryClientProvider client={client}>
    <I18nProvider><AntdApp>{children}</AntdApp></I18nProvider>
  </QueryClientProvider></React.StrictMode>);
  return { ...view, client };
}

async function completeWrite(index: number, status = 200, error = 'write_busy') {
  const write = writes[index];
  await act(async () => {
    if (status === 200) stored[write.key] = write.value;
    write.response.resolve(jsonResponse(status === 200 ? { key: write.key, value: write.value } : { error }, status));
    await writeResults[index];
  });
}

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  writeResults = [];
  reads = 0;
  isDraining = false;
  stored = {};
  readResponse = undefined;
  writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    expect(options.credentials).toBe('same-origin');
    if (input === '/omc/api/v1/preferences' && options.method === 'GET') {
      reads += 1;
      return readResponse ?? jsonResponse({ preferences: stored, time_zone: { server_timezone: 'UTC' } });
    }
    if (input.startsWith('/omc/api/v1/preferences/') && options.method === 'PUT') {
      const response = deferred<Response>();
      writes.push({ key: input.split('/').pop()!, value: JSON.parse(String(options.body)), options, response });
      if (isDraining) response.resolve(jsonResponse({ key: writes.at(-1)!.key, value: writes.at(-1)!.value }));
      return response.promise;
    }
    throw new Error(`Unexpected component request: ${options.method} ${input}`);
  }));
});

afterEach(async () => {
  // Drain admitted and subsequently queued writes even when an assertion fails;
  // the production per-key queue must not become the next test's fixture.
  await act(async () => {
    isDraining = true;
    for (const write of writes) write.response.resolve(jsonResponse({ key: write.key, value: write.value }));
    await Promise.all(writeResults);
  });
  for (const client of clients.splice(0)) client.clear();
});

describe('real preference hook and cache integration', () => {
  it('waits for a held read, shares one StrictMode query and publishes optimistic updates to both readers', async () => {
    const read = deferred<Response>();
    readResponse = read.promise;
    mount(<><PreferenceControl name="first" /><PreferenceControl name="second" /></>);
    expect(screen.getByLabelText('first ready').textContent).toBe('false');
    expect(screen.getByLabelText('first value').textContent).toBe('exclude_ttft');
    await act(async () => { read.resolve(jsonResponse({ preferences: { omc_tps_calculation_mode: 'include_ttft' } })); });
    await waitFor(() => expect(screen.getByLabelText('second value').textContent).toBe('include_ttft'));
    expect(reads).toBe(1);
    expect(screen.getByLabelText('first ready').textContent).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'first exclude' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('second value').textContent).toBe('exclude_ttft'));
    expect(stored.omc_tps_calculation_mode).toBeUndefined();
    expect(writes[0].options.keepalive).toBe(true);
    await completeWrite(0);
    expect(await writeResults[0]).toEqual({ ok: true });
    expect(reads).toBe(1);
  });

  it('rolls back a refused optimistic write, presents the real feedback and permits a subsequent save', async () => {
    stored.omc_tps_calculation_mode = 'include_ttft';
    mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('include_ttft'));
    fireEvent.click(screen.getByRole('button', { name: 'setting exclude' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('exclude_ttft'));
    await completeWrite(0, 503);
    expect(await writeResults[0]).toEqual({ ok: false });
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('include_ttft'));
    await screen.findByText('write_busy');
    expect(stored.omc_tps_calculation_mode).toBe('include_ttft');
    fireEvent.click(screen.getByRole('button', { name: 'setting exclude' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    await completeWrite(1);
    expect(await writeResults[1]).toEqual({ ok: true });
    expect(stored.omc_tps_calculation_mode).toBe('exclude_ttft');
    expect(reads).toBe(1);
  });

  it('serializes a key and never lets an older failure erase a newer optimistic intent', async () => {
    mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting ready').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'setting include' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'setting exclude' }));
    fireEvent.click(screen.getByRole('button', { name: 'setting include' }));
    await act(async () => { await Promise.resolve(); });
    expect(writes).toHaveLength(1);
    await completeWrite(0, 503);
    await waitFor(() => expect(writes).toHaveLength(2));
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('include_ttft'));
    await completeWrite(1);
    await waitFor(() => expect(writes).toHaveLength(3));
    await completeWrite(2);
    expect(await Promise.all(writeResults)).toEqual([{ ok: false }, { ok: true }, { ok: true }]);
    expect(stored.omc_tps_calculation_mode).toBe('include_ttft');
  });

  it('does not serialize unrelated keys behind a held write', async () => {
    mount(<><PreferenceControl name="tps" /><PreferenceControl name="tokens" preferenceKey="omc_token_style" /></>);
    await waitFor(() => expect(screen.getByLabelText('tps ready').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'tps include' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'tokens include' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map(write => write.key)).toEqual(['omc_tps_calculation_mode', 'omc_token_style']);
    await completeWrite(1);
    expect(stored.omc_token_style).toBe('include_ttft');
    expect(stored.omc_tps_calculation_mode).toBeUndefined();
    await completeWrite(0);
  });

  it('completes an already admitted keepalive write after unmount and reads it on a fresh mount', async () => {
    const view = mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting ready').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'setting include' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    view.unmount();
    await completeWrite(0);
    mount(<PreferenceControl name="reopened" />);
    await waitFor(() => expect(screen.getByLabelText('reopened value').textContent).toBe('include_ttft'));
    expect(reads).toBe(2);
  });

  it('exposes a usable fallback after a failed initial read rather than remaining unready', async () => {
    readResponse = Promise.resolve(jsonResponse({ error: 'database is unavailable' }, 503));
    mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting ready').textContent).toBe('true'));
    expect(screen.getByLabelText('setting value').textContent).toBe('exclude_ttft');
    expect(reads).toBe(1);
  });

  it('keeps object parsing reference-stable when another preference updates', async () => {
    stored.usage_events_columns = { provider: 200 };
    const parse = vi.fn((raw: unknown) => typeof raw === 'object' && raw !== null ? { ...(raw as object) } : undefined);
    const fallback = {};
    const values: object[] = [];
    function Columns() {
      const preference = usePreference('usage_events_columns', fallback, parse);
      values.push(preference.value);
      return <output aria-label="columns ready">{String(preference.ready)}</output>;
    }
    const { client } = mount(<Columns />);
    await waitFor(() => expect(screen.getByLabelText('columns ready').textContent).toBe('true'));
    const value = values.at(-1);
    await act(async () => { client.setQueryData(['preferences'], { ...stored, omc_theme: 'dark' }); });
    expect(values.at(-1)).toBe(value);
  });
});

describe('shared provider and real rendered consumer', () => {
  it('updates the context meter accessible reading through the real provider, hook and API client', async () => {
    stored.omc_token_style = 'short';
    mount(<TokenDisplayProvider><DisplayControl /></TokenDisplayProvider>);
    const meter = await screen.findByRole('meter');
    await waitFor(() => expect(meter.getAttribute('aria-valuetext')).toContain('10K'));
    fireEvent.click(screen.getByRole('button', { name: 'Full token reading' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].key).toBe('omc_token_style');
    expect(writes[0].value).toBe('full');
    await waitFor(() => expect(meter.getAttribute('aria-valuetext')).toContain('10,000'));
    await act(async () => { stored.omc_token_style = 'full'; writes[0].response.resolve(jsonResponse({ key: 'omc_token_style', value: 'full' })); });
    expect(reads).toBe(1);
  });
});
