import React from 'react';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { RequestRow } from '../src/components/usage/RequestRow';
import { TokenDisplayProvider, useTokenDisplayStyle } from '../src/types/tokenDisplayContext';
import type { UsageEvent } from '../src/types/usageEvents';

const clients: QueryClient[] = [];
afterEach(() => clients.splice(0).forEach(client => client.clear()));

const event: UsageEvent = {
  id: 183, event_key: 'oauth-alias', timestamp_ms: 1_800_000_000_000,
  provider: 'antigravity', model: 'gemini-3.8-flash-high', model_alias: 'gemini-3.8-flash',
  response_model: 'gemini-3.8-flash-high', model_substituted: false,
  failed: false, generate: true, latency_ms: 1000, has_request_log: false,
  tokens: { input: 100, output: 10, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 110 },
};

function ModelViewControl() {
  const { setModelView } = useTokenDisplayStyle();
  return <button onClick={() => setModelView('model')}>Requested view</button>;
}

function renderRow(overrides: Partial<UsageEvent> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(['preferences'], { omc_models_view: 'call', omc_request_model_icons: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ key: 'omc_models_view', value: 'model' }), {
    headers: { 'Content-Type': 'application/json' },
  })));
  return render(<React.StrictMode><QueryClientProvider client={client}><I18nProvider><AntdApp>
    <TokenDisplayProvider><ModelViewControl /><RequestRow event={{ ...event, ...overrides }}
      credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
    </TokenDisplayProvider>
  </AntdApp></I18nProvider></QueryClientProvider></React.StrictMode>);
}

it('leads with the caller alias and shows its billable upstream as secondary information', () => {
  const { container } = renderRow();
  expect(container.querySelector('.req-model-name')?.textContent).toBe(event.model_alias);
  expect(screen.getByTestId('request-routed-model').textContent).toBe(event.model);
  expect(screen.queryByTestId('request-served-model')).toBeNull();
});

it('changes to the upstream-first view through the shared preference without a redundant line', async () => {
  const { container } = renderRow();
  fireEvent.click(screen.getByRole('button', { name: 'Requested view' }));
  await waitFor(() => expect(container.querySelector('.req-model-name')?.textContent).toBe(event.model));
  expect(screen.queryByTestId('request-routed-model')).toBeNull();
});

it('gives a served substitution the second line while keeping the routed upstream in the tooltip', () => {
  const { container } = renderRow({ model_substituted: true, response_model: 'gemini-fallback' });
  expect(screen.getByTestId('request-served-model').textContent).toBe('gemini-fallback');
  expect(screen.queryByTestId('request-routed-model')).toBeNull();
  expect(container.querySelector('.req-model-name')?.getAttribute('title')).toContain(event.model);
});

it.each([undefined, 'gemini-3.8-flash-high'])('omits a redundant routed-model line for alias %s', model_alias => {
  renderRow({ model_alias });
  expect(screen.queryByTestId('request-routed-model')).toBeNull();
});
