import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PriceEditorDrawer } from '../src/components/pricing/PriceEditorDrawer';
import type { ModelPrice, PricingModelDetail, PricingResponse } from '../src/types/pricing';
import { installOmcApi, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const SHARED: ModelPrice = {
  model: 'gpt-5', prompt_price_per_1m: 2, completion_price_per_1m: 8, cache_read_price_per_1m: 0.5, cache_write_price_per_1m: 2,
  price_multiplier: 1, tiers: null, source: 'manual', upstream_id: '', match_kind: '', mode: 'custom', synced_at_ms: 0, updated_at_ms: 0,
};

const BOOK: PricingResponse = {
  source: 'openrouter', upstream_count: 0, unpriced: [], channel_models: [],
  models: [{ ...SHARED, usage_30d: { requests: 0, priced_requests: 0 } }],
  providers: [{ id: 'relay-0', family: 'openai-compatibility', name: 'Relay', channel: 'relay', priority: 1, is_oauth: false, models: ['gpt-5'] }],
  channels: [{ channel: 'relay', multiplier: 0.5, note: '', updated_at_ms: 0, is_configured: true, usage_30d: { requests: 0, priced_requests: 0 } }],
  sync: { known: true, running: false, state: { source: 'openrouter', last_error: '', last_matched: 0, last_unmatched: 0, updated_at_ms: 0 } },
};

function detail(channel: string | null): PricingModelDetail {
  return {
    model: 'gpt-5', price: SHARED, automatic: null, suggestions: [], candidate: null, versions: [],
    profile: { samples: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, max_input: 0 },
    ...(channel ? { channel, is_inherited: true } : {}),
  };
}

function servePricing(api: OmcApi) {
  api.on('GET', /\/pricing$/, () => BOOK);
  api.on('GET', /\/pricing\/models\/gpt-5$/, (request) => detail(request.query.get('channel')));
  api.on('PUT', /\/pricing\/models\/gpt-5$/, (request) => ({ price: { ...SHARED, ...(request.body as object), channel: request.query.get('channel') ?? undefined } }));
}

it('prices a channel separately only after the operator chooses to, and saves it to that channel', async () => {
  const api = installOmcApi();
  servePricing(api);
  const view = renderWithOmc(<PriceEditorDrawer model="gpt-5" channel="relay" isOpen onClose={vi.fn()} />);
  try {
    const inherited = await screen.findByTestId('pricing-scope-inherited');
    expect(within(inherited).getByText('Uses the shared price')).toBeTruthy();
    expect(screen.queryByTestId('pricing-editor-save')).toBeNull();

    fireEvent.click(within(inherited).getByTestId('pricing-scope-override'));
    const prompt = await screen.findByTestId('pricing-rate-prompt');
    fireEvent.change(prompt.querySelector('input') ?? prompt, { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('pricing-editor-save'));

    await waitFor(() => expect(api.writes('/pricing/models/gpt-5')).toHaveLength(1));
    const [write] = api.writes('/pricing/models/gpt-5');
    expect(write.query.get('channel')).toBe('relay');
    expect(write.body).toMatchObject({ mode: 'custom', prompt_price_per_1m: 1, completion_price_per_1m: 8 });
  } finally {
    view.unmount();
  }
});

it('asks before a scope change discards an edit', async () => {
  const api = installOmcApi();
  servePricing(api);
  const view = renderWithOmc(<PriceEditorDrawer model="gpt-5" isOpen onClose={vi.fn()} />);
  try {
    const prompt = await screen.findByTestId('pricing-rate-prompt');
    const tabs = await screen.findAllByTestId('pricing-scope-tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Shared', 'Relay']);

    fireEvent.change(prompt.querySelector('input') ?? prompt, { target: { value: '3' } });
    fireEvent.click(tabs[1]);
    expect(await screen.findByText('Discard unsaved changes?')).toBeTruthy();
    expect(screen.queryByTestId('pricing-scope-inherited')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByTestId('pricing-scope-inherited')).toBeTruthy();
    expect(api.writes('/pricing/models/gpt-5')).toHaveLength(0);
  } finally {
    view.unmount();
  }
});
