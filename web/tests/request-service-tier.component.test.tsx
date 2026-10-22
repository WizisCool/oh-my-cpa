import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { RequestRow } from '../src/components/usage/RequestRow';
import { TokenDisplayProvider } from '../src/types/tokenDisplayContext';
import type { UsageEvent } from '../src/types/usageEvents';

const clients: QueryClient[] = [];
afterEach(() => clients.splice(0).forEach(client => client.clear()));

function renderTier(overrides: Partial<UsageEvent>) {
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
  client.setQueryData(['preferences'], { omc_models_view: 'model', omc_request_model_icons: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  return render(<QueryClientProvider client={client}><I18nProvider><AntdApp><TokenDisplayProvider>
    <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
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
