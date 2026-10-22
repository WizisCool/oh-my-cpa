import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RequestRow } from '../src/components/usage/RequestRow';
import { TokenDisplayProvider, useTokenDisplayStyle } from '../src/types/tokenDisplayContext';
import type { UsageEvent } from '../src/types/usageEvents';
import { installOmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';

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
  const preferences = { omc_models_view: 'call', omc_request_model_icons: false };
  installOmcApi({ preferences: { ...preferences } });
  // Seeded and never stale, so the row renders its stored view on the first pass.
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: Infinity } });
  client.setQueryData(['preferences'], preferences);
  return renderWithOmc(<TokenDisplayProvider><ModelViewControl /><RequestRow event={{ ...event, ...overrides }}
    credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
  </TokenDisplayProvider>, { client, isStrict: true });
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
