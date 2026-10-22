import type { ReactNode } from 'react';
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
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

it('explains a locked outbound-priced tier without labeling it client or response evidence', () => {
  const breakdown: RequestCostBreakdown = {
    status: 'priced', stored_nanos: 6_000_000, service_tier: 'priority', service_tier_source: 'outbound', recomputed_matches: true,
    price_version: { id: 1, available: true, effective_from_ms: 0, price: { model: 'fixture-model', upstream_id: '', channel: '', prompt_price_per_1m: 2, completion_price_per_1m: 10, cache_read_price_per_1m: 0, cache_write_price_per_1m: 0, price_multiplier: 1, source: 'manual', tiers: [{ service_tiers: ['priority'], prompt_price_per_1m: 4 }] } },
  };
  renderTier({}, () => <CostBreakdownView breakdown={breakdown} model="fixture-model" />);
  expect(screen.getByTestId('cost-service-tier').textContent).toMatch(/priced from outbound request|按出站档位计价/);
});
