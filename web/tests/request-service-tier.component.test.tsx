import type { ReactNode } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import usageEventMessages from '../src/i18n/locales/en/usageEvents';
import { StructuredUsageView } from '../src/components/usage/StructuredUsageView';
import { TokenAccountingNote } from '../src/components/usage/TokenAccountingNote';
import { UsageEventDrawer } from '../src/components/usage/UsageEventDrawer';
import { PricingEditorProvider } from '../src/components/pricing/PricingEditorContext';
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
  // Seeded and never stale, so the row and the drawer render the record on the first pass.
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: Infinity } });
  client.setQueryData(['usage-event', event.id], { event, related_errors: [] });
  client.setQueryData(['preferences'], preferences);
  return renderWithOmc(<TokenDisplayProvider>
    {renderContent ? renderContent(event) : <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />}
  </TokenDisplayProvider>, { client });
}

it('marks Codex priority with a request-based hint even when the response says default', () => {
  renderTier({ resolved_service_tier: 'priority', resolved_service_tier_source: 'request' });
  expect(screen.getByTestId('request-fast-tier').getAttribute('aria-label')).toMatch(/请求服务等级 priority|requested service tier priority/);
});

it('keeps a non-Codex response downgrade off the fast lane', () => {
  renderTier({ provider: 'openai', resolved_service_tier: 'default', resolved_service_tier_source: 'response' });
  expect(screen.queryByTestId('request-fast-tier')).toBeNull();
});

it('identifies response-based Fast independently of a requested priority tier', () => {
  renderTier({ provider: 'claude', service_tier: undefined, response_service_tier: 'fast', resolved_service_tier: 'fast', resolved_service_tier_source: 'response' });
  expect(screen.getByTestId('request-fast-tier').getAttribute('aria-label')).toMatch(/响应服务等级 fast|response service tier fast/);
});

it('identifies server-injected Fast from outbound evidence without calling it a response tier', () => {
  renderTier({ service_tier: 'auto', effective_service_tier: 'priority', resolved_service_tier: 'priority', resolved_service_tier_source: 'outbound' });
  expect(screen.getByTestId('request-fast-tier').getAttribute('aria-label')).toMatch(/出站服务等级 priority|outbound service tier priority/);
});

it.each(['default', 'auto'])('does not mark a requested Fast after an outbound %s override', tier => {
  renderTier({ effective_service_tier: tier, resolved_service_tier: tier === 'auto' ? undefined : tier, resolved_service_tier_source: 'outbound' });
  expect(screen.queryByTestId('request-fast-tier')).toBeNull();
});


it('shows the client, outbound and response tiers separately in request details', async () => {
  renderTier({ service_tier: 'auto', effective_service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'priority', resolved_service_tier_source: 'outbound' }, event =>
    <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />);
  expect(await screen.findByText(/priority.*(?:based on outbound request|按出站判断)/)).toBeTruthy();
  expect(screen.getByText(/^(?:Outbound tier|出站档位)$/)).toBeTruthy();
  expect(screen.getByText('auto')).toBeTruthy();
  expect(screen.getByText('default')).toBeTruthy();
});

it('exposes an unavailable TPS basis to keyboard users in request details', async () => {
  renderTier({ latency_ms: 0 }, event => <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />);
  const rate = await screen.findByText('—', { selector: 'strong[tabindex="0"]' });
  expect(rate.getAttribute('aria-label')).toMatch(/^TPS: —\./);
});

it('explains a locked outbound-priced tier without labeling it client or response evidence', () => {
  const breakdown: RequestCostBreakdown = {
    status: 'priced', stored_nanos: 6_000_000, service_tier: 'priority', service_tier_source: 'outbound', recomputed_matches: true,
    price_version: { id: 1, available: true, effective_from_ms: 0, price: { model: 'fixture-model', upstream_id: '', channel: '', prompt_price_per_1m: 2, completion_price_per_1m: 10, cache_read_price_per_1m: 0, cache_write_price_per_1m: 0, price_multiplier: 1, source: 'manual', tiers: [{ service_tiers: ['priority'], prompt_price_per_1m: 4 }] } },
  };
  renderTier({}, () => <CostBreakdownView breakdown={breakdown} model="fixture-model" />);
  expect(screen.getByTestId('cost-service-tier').textContent).toMatch(/priced from outbound request|按出站档位计价/);
});

it.each(['row', 'breakdown'])('does not offer a price edit as a remedy for unresolved token accounting in the %s', surface => {
  const breakdown: RequestCostBreakdown = {
    status: 'unpriced', accounting_status: 'unclassified', recomputed_matches: false,
    token_accounting: {
      version: 2, status: 'unclassified',
      raw_tokens: { input_tokens: 100, output_tokens: 30, reasoning_tokens: 10, cached_tokens: 20,
        cache_read_tokens: 20, cache_read_tokens_present: true, cache_creation_tokens: 0, total_tokens: 140 },
    },
  };
  renderTier({ pricing_status: 'unpriced', token_accounting: breakdown.token_accounting }, event => <PricingEditorProvider>
    {surface === 'breakdown' ? <CostBreakdownView breakdown={breakdown} model="fixture-model" /> :
      <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />}
  </PricingEditorProvider>);
  expect(screen.queryByTestId(surface === 'breakdown' ? 'cost-set-price' : 'request-set-price')).toBeNull();
});

it.each(['invalid', 'unsupported', 'inconsistent', 'unclassified'] as const)('shows original counts for %s accounting in the row and its explanation', status => {
  const accounting = {
    version: 2, status,
    raw_tokens: { input_tokens: 100, output_tokens: 30, reasoning_tokens: 10, cached_tokens: 20,
      cache_read_tokens: 20, cache_read_tokens_present: true, cache_creation_tokens: 0, total_tokens: 140 },
  };
  const { container } = renderTier({ pricing_status: 'unpriced', token_accounting: accounting }, event => <>
    <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
    <TokenAccountingNote accounting={accounting} />
  </>);
  const tooltipReasons = Array.from(container.querySelectorAll('[data-request-tooltip]')).map(element => element.getAttribute('data-request-tooltip'));
  const explanation = container.querySelector('p')?.textContent;
  expect(tooltipReasons).toContain(explanation);
  expect(explanation).toContain('100');
  expect(explanation).toContain('30');
});

it('paints the duration from its ramp in the row and drawer, and leaves TTFT in the secondary ink', async () => {
  const { container } = renderTier({ latency_ms: 65_000, ttft_ms: 3_000 }, event => <>
    <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
    <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />
  </>);
  const duration = await screen.findAllByText('65.00 s');
  expect(duration).toHaveLength(2);
  // One reading, one ramp: every duration readout asks for the same three values.
  for (const readout of duration) {
    expect(readout.style.getPropertyValue('--duration-from')).toBe('var(--timing-green)');
    expect(readout.style.getPropertyValue('--duration-to')).toBe('var(--timing-orange)');
    expect(readout.style.getPropertyValue('--duration-from-share')).toBe('0%');
  }
  // TTFT is detail, not a verdict: a minute of waiting must not paint it.
  const ttft = container.querySelector('.req-ttft-val');
  expect(ttft?.textContent).toBe('TTFT 3.00 s');
  expect(ttft?.className).not.toContain('req-timing-value');
  expect(container.querySelector('.req-ttft-val .req-timing-value')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /Performance/ }));
  await screen.findByRole('heading', { name: usageEventMessages['events.waterfall_title'] });
  // The drawer's hero, the waterfall header and the total legend all read the same ramp, and each
  // of them asks for it; the drawer renders in a portal, so the document is the container.
  const ramps = [...document.querySelectorAll<HTMLElement>('.req-timing-value')];
  expect(ramps).toHaveLength(3);
  for (const readout of ramps) {
    expect(readout.textContent).toBe('65.00 s');
    expect(readout.style.getPropertyValue('--duration-from-share')).toBe('0%');
  }
  // TTFT is detail: neither its readouts nor the waterfall legend may carry the ramp.
  const ttftReadouts = screen.getAllByText('3.00 s');
  expect(ttftReadouts.length).toBeGreaterThan(0);
  expect(ttftReadouts.every((node) => !node.className.includes('req-timing-value'))).toBe(true);
});

it.each([undefined, null, 0, -1, 65_000, 65_001])('keeps an unmeasured TTFT (%s) out of the row and drawer', async ttft => {
  renderTier({ latency_ms: 65_000, ttft_ms: ttft }, event => <>
    <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
    <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />
  </>);
  expect(await screen.findAllByText('65.00 s')).toHaveLength(2);
  expect(document.body.textContent).not.toContain('TTFT');
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
  fireEvent.click(await screen.findByRole('tab', { name: /Performance/ }));
  const details = within(await screen.findByRole('region', { name: 'Upstream usage details' }));
  const valueFor = (label: string) => within(details.getByText(label).parentElement!).getByRole('definition').textContent;
  expect(valueFor('Text input tokens')).toBe('0');
  expect(valueFor('Web search calls')).toBe('0');
  expect(valueFor('Reported cost')).toBe('0');
  expect(valueFor('Upstream inference cost')).toBe('0.0000000000001');
  expect(valueFor('Bring your own key')).toBe('No');
  expect(valueFor('Audio duration (seconds)')).toBe('0');
  expect(details.queryByText('Web fetch calls')).toBeNull();
  expect(within(details.getByRole('heading', { name: 'Requested image settings' }).parentElement!).getByText('1024x1024')).toBeTruthy();
  expect(within(details.getByRole('heading', { name: 'Upstream-observed image settings' }).parentElement!).getByText('1536x1024')).toBeTruthy();
  expect(within(details.getByRole('region', { name: 'Iteration 1' })).getByText('5')).toBeTruthy();
  expect(details.getByRole('status')).toBeTruthy();
  // A zero reported upstream does not replace the stored OMC estimate in the drawer.
  expect(details.queryByText('$0.25')).toBeNull();
  expect(screen.getAllByText(/0.25/).length).toBeGreaterThan(0);
});

it('keeps legacy structured usage unknown instead of fabricating zero-valued counters', () => {
  renderWithOmc(<StructuredUsageView />);
  const details = within(screen.getByRole('region', { name: 'Upstream usage details' }));
  expect(details.getByText('Not captured')).toBeTruthy();
  expect(details.queryByRole('definition')).toBeNull();
});
