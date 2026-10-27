import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CurrencyDisplayProvider } from '../src/types/CurrencyDisplayContext';
import { CurrencySettings } from '../src/components/settings/CurrencySettings';
import { TokenDisplayProvider } from '../src/types/tokenDisplayContext';
import { RequestRow } from '../src/components/usage/RequestRow';
import { MetricTiles } from '../src/pages/insights/components/MetricTiles';
import { UsageCell } from '../src/pages/pricing/UsageCell';
import type { ExchangeRates } from '../src/types/currencyDisplay';
import type { UsageEvent } from '../src/types/usageEvents';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

// jsdom does not animate custom elements. The real readout has already been
// derived by the formatting layer; this test owns which surfaces consume it.
vi.mock('../src/components/dashboard/RollingNumber', () => ({
  RollingNumber: ({ readout }: { readout?: { number: number; prefix?: string; suffix: string; format: Intl.NumberFormatOptions } }) =>
    <>{readout ? `${readout.prefix ?? ''}${new Intl.NumberFormat('en', readout.format).format(readout.number)}${readout.suffix}` : '—'}</>,
}));

const CACHED: ExchangeRates = {
  base_currency: 'USD', source: 'frankfurter_v2', refresh_interval_hours: 24,
  updated_at_ms: 1_800_000_000_000, attempted_at_ms: 1_800_000_000_000, next_refresh_at_ms: 1_800_086_400_000, last_error: '',
  rates: [{ currency: 'MYR', rate: 4, date: '2026-10-27' }],
};
const EVENT: UsageEvent = {
  id: 1, event_key: 'priced', timestamp_ms: 1_800_000_000_000, provider: 'codex', model: 'gpt-5',
  failed: false, generate: true, latency_ms: 1000, has_request_log: false, cost_usd: 2,
  tokens: { input: 100, output: 10, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 110 },
};

it('shares the display choice and refreshed rates with requests and Insights while Cost & Usage stays USD', async () => {
  const api = installOmcApi();
  const read = api.hold('GET', '/preferences');
  api.on('GET', '/exchange-rates', () => CACHED);
  api.on('POST', '/exchange-rates/refresh', () => ({ ...CACHED, rates: [{ ...CACHED.rates[0], rate: 4.5 }] }));
  const { container } = renderWithOmc(<TokenDisplayProvider><CurrencyDisplayProvider>
    <CurrencySettings />
    <RequestRow event={EVENT} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
    <MetricTiles current={{ requests: 1, failures: 0, inputTokens: 100, outputTokens: 10, reasoningTokens: 0, totalTokens: 110, latencySumMs: 1000, ttftSumMs: 0, ttftCount: 0, costNanos: 2_000_000_000, pricedRequests: 1, costedRequests: 1 }} previous={null} metric="cost" onMetricChange={() => undefined} />
    <div data-testid="accounting"><UsageCell usage={{ requests: 1, priced_requests: 1, cost_usd: 2 }} /></div>
  </CurrencyDisplayProvider></TokenDisplayProvider>);
  await waitFor(() => expect(api.requests.some(request => request.path === '/exchange-rates')).toBe(true));
  expect(container.querySelector('.req-cost-val')?.textContent).toBe('$2.0000');
  // The picker waits for the stored document: a read that lands after a choice would replace
  // the optimistic value in the shared cache.
  const picker = screen.getByRole('combobox', { name: 'Display currency' });
  expect(picker.hasAttribute('disabled')).toBe(true);
  await act(async () => { read.release(); });
  await waitFor(() => expect(picker.hasAttribute('disabled')).toBe(false));
  fireEvent.mouseDown(picker);
  fireEvent.click(await screen.findByTitle('MYR · Malaysian Ringgit'));
  await waitFor(() => expect(container.querySelector('.req-cost-val')?.textContent).toBe('RM8.0000'));
  expect(screen.getByTestId('insights-tile-cost').textContent).toContain('RM8.00');
  expect(screen.getByTestId('accounting').textContent).toContain('$2.00');
  await waitFor(() => expect(api.preferenceWrites()).toContainEqual({ key: 'omc_display_currency', value: 'MYR' }));

  fireEvent.click(screen.getByRole('button', { name: 'Update rates' }));
  await waitFor(() => expect(container.querySelector('.req-cost-val')?.textContent).toBe('RM9.0000'));
  expect(screen.getByTestId('insights-tile-cost').textContent).toContain('RM9.00');
  expect(screen.getByTestId('accounting').textContent).toContain('$2.00');
  expect(EVENT.cost_usd).toBe(2);
});

it('keeps the chosen currency and cached display values across hydration and a manual update failure', async () => {
  const api = installOmcApi({ preferences: { omc_display_currency: 'MYR' } });
  api.on('GET', '/exchange-rates', () => CACHED);
  api.on('POST', '/exchange-rates/refresh', () => json({ error: 'exchange_rate_fetch_failed' }, 502));
  const { container } = renderWithOmc(<TokenDisplayProvider><CurrencyDisplayProvider>
    <CurrencySettings /><RequestRow event={EVENT} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
  </CurrencyDisplayProvider></TokenDisplayProvider>);
  await waitFor(() => expect(container.querySelector('.req-cost-val')?.textContent).toBe('RM8.0000'));
  fireEvent.click(screen.getByRole('button', { name: 'Update rates' }));
  await screen.findByText('Could not update exchange rates');
  expect(container.querySelector('.req-cost-val')?.textContent).toBe('RM8.0000');
  expect(api.preferenceWrites()).toEqual([]);
});
