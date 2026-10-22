import type { ReactNode } from 'react';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { UsageEventDrawer } from '../src/components/usage/UsageEventDrawer';
import { CostBreakdownView } from '../src/components/pricing/CostBreakdownView';
import type { RequestCostBreakdown } from '../src/types/pricing';
import { RequestRow } from '../src/components/usage/RequestRow';
import { TokenDisplayProvider } from '../src/types/tokenDisplayContext';
import type { UsageEvent } from '../src/types/usageEvents';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
});

const clients: QueryClient[] = [];
afterEach(() => clients.splice(0).forEach(client => client.clear()));

function renderTier(overrides: Partial<UsageEvent>, renderContent?: (event: UsageEvent) => ReactNode) {
  const event: UsageEvent = {
    id: 274, event_key: 'codex-fast', timestamp_ms: 1_800_000_000_000,
    provider: 'codex', model: 'fixture-model', failed: false, generate: true,
    latency_ms: 1000, has_request_log: false,
    service_tier: 'priority', response_service_tier: 'default',
    tokens: { input: 100, output: 10, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 110 },
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(['usage-event', event.id], { event, related_errors: [] });
  client.setQueryData(['preferences'], { omc_models_view: 'model', omc_request_model_icons: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  return render(<QueryClientProvider client={client}><I18nProvider><AntdApp><TokenDisplayProvider>
    {renderContent ? renderContent(event) : <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />}
  </TokenDisplayProvider></AntdApp></I18nProvider></QueryClientProvider>);
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
