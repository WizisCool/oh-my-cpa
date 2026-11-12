import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { InsightsPage } from '../src/pages/insights/InsightsPage';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type { InsightsCubeResponse } from '../src/types/insights';
vi.mock('../src/pages/insights/charts/InsightsFlowChart', () => ({ default: () => null }));
vi.mock('../src/components/dashboard/RollingNumber', () => ({
  RollingNumber: ({ readout }: { readout?: { number: number; prefix?: string; suffix: string; format: Intl.NumberFormatOptions } }) =>
    <>{readout ? `${readout.prefix ?? ''}${new Intl.NumberFormat('en', readout.format).format(readout.number)}${readout.suffix}` : '—'}</>,
}));

const COLUMNS = [
  'bucket', 'key', 'call_point', 'model', 'provider', 'credential',
  'requests', 'failures', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'latency_sum_ms', 'ttft_sum_ms',
  'ttft_count', 'cost_nanos', 'priced_requests', 'costed_requests',
];

function row(bucket: number, key: number, model: number, requests: number, tokens: number): number[] {
  return [bucket, key, model, model, 0, 0, requests, 0, tokens, 0, 0, 0, 0, 0, tokens, requests * 200, 0, 0, requests * 1_000_000, requests, requests];
}

const CUBE: InsightsCubeResponse = {
  window: { preset: '7d', from: 0, to: 2 * 86_400_000 - 1, open_end: true, bucket: 'day', timezone: 'UTC', widened: false },
  compare_window: { from: -2 * 86_400_000, to: -1 },
  bucket_starts: [0, 86_400_000],
  dims: {
    keys: [{ id: 'hmac:a', alias: 'Design team', mask: 'sk-…aaaa', is_client_key: true }, { id: 'hmac:b', mask: 'sk-…bbbb', is_client_key: true }],
    call_points: ['gpt-5', 'sonnet'],
    models: ['gpt-5', 'sonnet'],
    providers: ['codex'],
    credentials: [{ auth_index: 'c1', auth_type: 'oauth' }],
  },
  columns: COLUMNS,
  rows: [row(0, 0, 0, 30, 3000), row(1, 0, 1, 10, 1000), row(1, 1, 0, 5, 500)],
  previous_rows: [row(0, 0, 0, 20, 2000)],
  coverage: { fact_requests: 45, detail_requests: 0 },
};


let api: OmcApi;
let lastSearch = '';

function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}

function mount(route = '/insights') {
  return renderWithOmc(
    <Routes>
      <Route path="/insights" element={<ThemeProvider><InsightsPage /><LocationProbe /></ThemeProvider>} />
    </Routes>,
    { route },
  );
}

const tile = (metric: string) => screen.getByTestId(`insights-tile-${metric}`);

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  api = installOmcApi();
  api.on('GET', '/management/insights/cube', () => CUBE);
  api.on('GET', '/management/insights/rhythm', () => ({
    window: CUBE.window,
    cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, requests: index === 9 ? 4 : 0, total_tokens: 0, cost_nanos: 0 })),
  }));
});

describe('insights page', () => {
  it('reads one cube for the stored window, narrows to a ranked key without re-reading the cube, and switches metrics', async () => {
    api.state.preferences.insights_range = { preset: 'this_week' };
    mount('/insights?group=key&metric=cache_rate');
    await waitFor(() => expect(within(tile('requests')).getByText('45')).toBeTruthy());
    expect(within(tile('requests')).getByText('125%')).toBeTruthy();
    expect(tile('tokens').getAttribute('aria-selected')).toBe('true');

    const ranking = await screen.findByTestId('insights-ranking-key');
    fireEvent.click(within(ranking).getByText('Design team'));
    await waitFor(() => expect(within(tile('requests')).getByText('40')).toBeTruthy());
    expect(new URLSearchParams(lastSearch).getAll('key')).toEqual(['hmac:a']);

    const chip = screen.getByTestId('insights-filter-bar');
    fireEvent.click(within(chip).getByRole('button', { name: 'Remove filter' }));
    await waitFor(() => expect(within(tile('requests')).getByText('45')).toBeTruthy());
    expect(api.requests.filter((request) => request.path === '/management/insights/cube')).toHaveLength(1);

    fireEvent.click(tile('latency'));
    await waitFor(() => expect(tile('latency').getAttribute('aria-selected')).toBe('true'));
    expect(new URLSearchParams(lastSearch).get('metric')).toBe('latency');
  });

  it('isolates a series from the legend or chart click and resets on background click', async () => {
    mount('/insights?metric=tokens&group=key');
    const chart = await screen.findByTestId('insights-trend-chart');
    const names = () => JSON.parse(chart.getAttribute('data-series') ?? '[]') as string[];

    const legend = screen.getByTestId('insights-trend-legend');
    const buttons = within(legend).getAllByRole('button');
    expect(names()).toEqual(['Design team', 'sk-…bbbb']);

    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(names()).toEqual(['Design team']));

    fireEvent.click(chart);
    await waitFor(() => expect(names()).toEqual(['Design team', 'sk-…bbbb']));
  });

  it('keeps the page frame and displays error details when the cube fails to load', async () => {
    api.on('GET', '/management/insights/cube', () => json({ error: 'hour buckets cover at most 14 days' }, 400));
    mount();
    expect(await screen.findByText('Insights could not be loaded')).toBeTruthy();
    expect(screen.getByText(/hour buckets cover at most 14 days/)).toBeTruthy();
  });
});
