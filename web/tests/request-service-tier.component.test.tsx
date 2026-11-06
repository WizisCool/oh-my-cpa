import type { ReactNode } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import usageEventMessages from '../src/i18n/locales/en/usageEvents';
import { StructuredUsageView } from '../src/components/usage/StructuredUsageView';
import { UsageEventDrawer } from '../src/components/usage/UsageEventDrawer';
import { CostBreakdownView } from '../src/components/pricing/CostBreakdownView';
import type { RequestCostBreakdown } from '../src/types/pricing';
import { RequestRow } from '../src/components/usage/RequestRow';
import { TokenDisplayProvider } from '../src/types/tokenDisplayContext';
import type { UsageEvent } from '../src/types/usageEvents';
import { installOmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';

function renderTier(overrides: Partial<UsageEvent>, renderContent?: (event: UsageEvent) => ReactNode) {
  const event: UsageEvent = {
    id: 274, event_key: 'codex-fast', timestamp_ms: 1_800_000_000_000,
    provider: 'codex', model: 'fixture-model', failed: false, generate: true,
    latency_ms: 1000, has_request_log: false,
    service_tier: 'priority', response_service_tier: 'default',
    tokens: { input: 100, output: 10, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 110 },
    ...overrides,
  };
  const preferences = { omc_models_view: 'model', omc_request_model_icons: false };
  installOmcApi({ preferences: { ...preferences } });
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: Infinity } });
  client.setQueryData(['usage-event', event.id], { event, related_errors: [] });
  client.setQueryData(['preferences'], preferences);
  return renderWithOmc(<TokenDisplayProvider>
    {renderContent ? renderContent(event) : <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />}
  </TokenDisplayProvider>, { client });
}

it('marks Codex priority and outbound/response Fast tiers accurately', () => {
  const first = renderTier({ resolved_service_tier: 'priority', resolved_service_tier_source: 'request' });
  expect(screen.getByTestId('request-fast-tier').getAttribute('aria-label')).toMatch(/请求服务等级 priority|requested service tier priority/);
  first.unmount();

  const second = renderTier({ service_tier: 'auto', effective_service_tier: 'priority', resolved_service_tier: 'priority', resolved_service_tier_source: 'outbound' });
  expect(screen.getByTestId('request-fast-tier').getAttribute('aria-label')).toMatch(/出站服务等级 priority|outbound service tier priority/);
  second.unmount();

  const third = renderTier({ provider: 'openai', resolved_service_tier: 'default', resolved_service_tier_source: 'response' });
  expect(screen.queryByTestId('request-fast-tier')).toBeNull();
  third.unmount();
});

it('shows the client, outbound and response tiers separately in request details and cost breakdown', async () => {
  const breakdown: RequestCostBreakdown = {
    status: 'priced', stored_nanos: 6_000_000, service_tier: 'priority', service_tier_source: 'outbound', recomputed_matches: true,
    price_version: { id: 1, available: true, effective_from_ms: 0, price: { model: 'fixture-model', upstream_id: '', channel: '', prompt_price_per_1m: 2, completion_price_per_1m: 10, cache_read_price_per_1m: 0, cache_write_price_per_1m: 0, price_multiplier: 1, source: 'manual', tiers: [{ service_tiers: ['priority'], prompt_price_per_1m: 4 }] } },
  };
  renderTier({ service_tier: 'auto', effective_service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'priority', resolved_service_tier_source: 'outbound' }, event => <>
    <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />
    <CostBreakdownView breakdown={breakdown} model="fixture-model" />
  </>);
  fireEvent.click(await screen.findByRole('tab', { name: /^(?:Raw fields|原始字段)$/ }));
  expect(await screen.findByText(/priority.*(?:based on outbound request|按出站判断)/)).toBeTruthy();
  expect(screen.getByText(/^(?:Outbound tier|出站档位)$/)).toBeTruthy();
  expect(screen.getByTestId('cost-service-tier').textContent).toMatch(/priced from outbound request|按出站档位计价/);
});

it('paints the duration from its ramp in the row and drawer, and leaves TTFT in the secondary ink', async () => {
  const { container } = renderTier({ latency_ms: 65_000, ttft_ms: 3_000 }, event => <>
    <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
    <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />
  </>);
  // The row, the drawer's headline and its timing card read the same duration on the same ramp.
  const duration = await screen.findAllByText('65.00 s');
  expect(duration).toHaveLength(3);
  for (const readout of duration) {
    expect(readout.style.getPropertyValue('--duration-from')).toBe('var(--timing-green)');
    expect(readout.style.getPropertyValue('--duration-to')).toBe('var(--timing-orange)');
    expect(readout.style.getPropertyValue('--duration-from-share')).toBe('0%');
  }
  const ttft = container.querySelector('.req-ttft-val');
  expect(ttft?.textContent).toBe('TTFT 3.00 s');
  expect(ttft?.className).not.toContain('req-timing-value');
  const ramps = [...document.querySelectorAll<HTMLElement>('.req-timing-value')];
  expect(ramps).toHaveLength(3);
  // The first-token wait is drawn in its own secondary segment, never on the duration ramp.
  expect(screen.getByText(usageEventMessages['events.timing_wait']).closest('.req-timing-value')).toBeNull();
});

it('reads structured detail in the drawer without merging observations into canonical totals or estimated costs', async () => {
  renderTier({ cost_usd: 0.25, structured_usage: {
    tokens: { text_input_tokens: 0, image_input_tokens: 12 },
    cache_details: { by_ttl: { '5m': 0 } },
    tool_usage_details: { web_search_calls: 0, code_execution_calls: 2 },
    web_search_requests: 0,
    image_count: 0,
    requested_image_details: { size: '1024x1024', quality: 'high' },
    image_details: { size: '1536x1024' },
    media_counts: { audio_seconds: 0 },
    iterations: [{ output_tokens: 0, cache_creation: { by_ttl: { '1h': 5 } } }],
    cost_details: { cost: 0, upstream_inference_cost: 0.0000000000001, is_byok: false, cost_in_usd_ticks: 0 },
    is_partial: true,
  } }, event => <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />);
  fireEvent.click(await screen.findByRole('tab', { name: /^Usage$/ }));
  const details = within(await screen.findByRole('region', { name: 'Upstream usage details' }));
  const valueFor = (label: string) => within(details.getByText(label).parentElement!).getByRole('definition').textContent;
  expect(valueFor('Text input tokens')).toBe('0');
  expect(valueFor('Web search calls')).toBe('0');
  expect(valueFor('Reported cost')).toBe('0');
});

it('keeps legacy structured usage unknown instead of fabricating zero-valued counters', () => {
  renderWithOmc(<StructuredUsageView />);
  expect(within(screen.getByRole('region', { name: 'Upstream usage details' })).getByText('Not captured')).toBeTruthy();
});
