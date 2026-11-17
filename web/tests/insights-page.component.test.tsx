import type React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';
import type { QueryClient } from '@tanstack/react-query';
import { InsightsPage } from '../src/pages/insights/InsightsPage';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type { InsightsClientsResponse, InsightsCubeResponse, InsightsRhythmCell, InsightsRhythmResponse } from '../src/types/insights';
import { RhythmGrid } from '../src/pages/insights/components/RhythmGrid';
vi.mock('../src/pages/insights/charts/InsightsFlowChart', () => ({ default: () => null }));
vi.mock('../src/components/dashboard/RollingNumber', () => ({
  RollingNumberGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  // Half of every prompt is a cache read, so the net scope halves the token total.
  return [bucket, key, model, model, 0, 0, requests, 0, tokens, 0, 0, 0, tokens / 2, 0, tokens, requests * 200, 0, 0, requests * 1_000_000, requests, requests];
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

const CLIENTS: InsightsClientsResponse = {
  window: CUBE.window,
  // The window held 40 requests; the 36 still kept as records are what the clients add up to.
  coverage: { total_requests: 40, retained_requests: 36 },
  clients: [{
    id: 'claude-code', category: 'agent', raw_prefix: 'claude-cli/2.0', requests: 30, failures: 0,
    input_tokens: 3000, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_read_tokens: 1500,
    cache_creation_tokens: 0, total_tokens: 3000, latency_sum_ms: 6000, ttft_sum_ms: 0, ttft_count: 0,
    cost_nanos: 0, priced_requests: 0, costed_requests: 0,
  }, ...(['oh-my-cpa', 'hindsight', 'node-http'] as const).map((id, index) => {
    // Oh My CPA sends fewer tokens than Claude Code but none of them from cache, so it leads the net scope.
    const tokens = id === 'oh-my-cpa' ? 2000 : 10;
    return {
      id, category: (id === 'node-http' ? 'sdk' : 'agent') as 'sdk' | 'agent', requests: 3 - index, failures: 0,
      input_tokens: tokens, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_read_tokens: 0,
      cache_creation_tokens: 0, total_tokens: tokens, latency_sum_ms: 0, ttft_sum_ms: 0, ttft_count: 0,
      cost_nanos: 0, priced_requests: 0, costed_requests: 0,
    };
  })],
};

let api: OmcApi;
let lastSearch = '';
let lastPath = '';

function LocationProbe() {
  const location = useLocation();
  lastSearch = location.search;
  lastPath = location.pathname;
  return null;
}

function mount(route = '/insights', client?: QueryClient) {
  return renderWithOmc(
    <Routes>
      <Route path="/insights" element={<ThemeProvider><InsightsPage /><LocationProbe /></ThemeProvider>} />
      <Route path="/usage/events" element={<LocationProbe />} />
    </Routes>,
    { route, client },
  );
}

/** The client ranking's names, top first. */
function clientOrder(): string[] {
  return within(screen.getByTestId('insights-ranking-client')).getAllByRole('listitem')
    .map((item) => item.querySelector('[class*="value-name"]')?.textContent ?? '');
}

const tile = (metric: string) => screen.getByTestId(`insights-tile-${metric}`);

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  api = installOmcApi();
  api.on('GET', '/management/insights/cube', () => CUBE);
  api.on('GET', '/management/insights/clients', () => CLIENTS);
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
    expect(tile('tokens').getAttribute('aria-pressed')).toBe('true');

    const ranking = await screen.findByTestId('insights-ranking-key');
    fireEvent.click(within(ranking).getByText('Design team'));
    await waitFor(() => expect(within(tile('requests')).getByText('40')).toBeTruthy());
    expect(new URLSearchParams(lastSearch).getAll('key')).toEqual(['hmac:a']);

    const chip = screen.getByTestId('insights-filter-bar');
    fireEvent.click(within(chip).getByRole('button', { name: 'Remove filter' }));
    await waitFor(() => expect(within(tile('requests')).getByText('45')).toBeTruthy());
    expect(api.requests.filter((request) => request.path === '/management/insights/cube')).toHaveLength(1);

    fireEvent.click(tile('latency'));
    await waitFor(() => expect(tile('latency').getAttribute('aria-pressed')).toBe('true'));
    expect(new URLSearchParams(lastSearch).get('metric')).toBe('latency');

    // The change line keeps its place when the comparison is turned off, so nothing below it moves.
    const parts = tile('requests').children.length;
    fireEvent.click(screen.getByTestId('insights-compare'));
    await waitFor(() => expect(within(tile('requests')).queryByText('125%')).toBeNull());
    expect(tile('requests').children).toHaveLength(parts);

    // Narrowed to a model only one key called, every ranking stays where the reader left it.
    const places = () => [...screen.getByTestId('insights-ranking-key').parentElement!.children].map((panel) => panel.getAttribute('data-testid'));
    const order = ['insights-ranking-model', 'insights-ranking-client', 'insights-ranking-key', 'insights-ranking-provider', 'insights-ranking-credential'];
    expect(places()).toEqual(order);
    fireEvent.click(within(screen.getByTestId('insights-ranking-model')).getByText('sonnet'));
    await waitFor(() => expect(within(screen.getByTestId('insights-ranking-key')).queryByText('sk-…bbbb')).toBeNull());
    expect(places()).toEqual(order);
  });

  it('isolates a series from the legend or chart click and resets on background click', async () => {
    mount('/insights?metric=tokens&group=key');
    // The trend chart is a lazy chunk; under a full suite its first import can outlast the default wait.
    const chart = await screen.findByTestId('insights-trend-chart', undefined, { timeout: 5000 });
    const names = () => JSON.parse(chart.getAttribute('data-series') ?? '[]') as string[];

    const legend = screen.getByTestId('insights-trend-legend');
    const buttons = within(legend).getAllByRole('button');
    expect(names()).toEqual(['Design team', 'sk-…bbbb']);

    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(names()).toEqual(['Design team']));

    fireEvent.click(chart);
    await waitFor(() => expect(names()).toEqual(['Design team', 'sk-…bbbb']));
  });

  it('switches the token scope across the tiles and the client ranking, and keeps it in the link', async () => {
    mount('/insights');
    await waitFor(() => expect(within(tile('tokens')).getByText('Tokens')).toBeTruthy());
    const allReading = within(tile('tokens')).getByText((_, element) => element?.getAttribute('data-tip') === '4,500').textContent;
    const clients = await screen.findByTestId('insights-ranking-client');
    expect(within(clients).getByText('Claude Code')).toBeTruthy();
    // Clients the icon catalog lacks carry their own marks: the console's brand, Hindsight's eye, the Node.js hexagon.
    const markOf = (name: string) => within(clients).getByText(name).parentElement!.querySelector('svg');
    expect(markOf('Oh My CPA')).toBeTruthy();
    expect(markOf('Hindsight')?.getAttribute('data-mark')).toBe('hindsight');
    expect(markOf('Hindsight')?.querySelector('linearGradient')?.id).toBeTruthy();
    expect(markOf('Node HTTP')?.getAttribute('data-mark')).toBe('node-http');
    expect(screen.getByTestId('insights-client-coverage').textContent).toContain('90.0%');
    expect(clientOrder().slice(0, 2)).toEqual(['Claude Code', 'Oh My CPA']);

    fireEvent.click(within(screen.getByTestId('insights-token-scope')).getByText('Net'));
    await waitFor(() => expect(within(tile('tokens')).getByText('Net tokens')).toBeTruthy());
    await waitFor(() => expect(clientOrder().slice(0, 2)).toEqual(['Oh My CPA', 'Claude Code']));
    expect(new URLSearchParams(lastSearch).get('scope')).toBe('net');
    const netReading = within(tile('tokens')).getByText((_, element) => element?.getAttribute('data-tip') === '2,250').textContent;
    expect(netReading).not.toBe(allReading);

    fireEvent.click(within(screen.getByTestId('insights-token-scope')).getByText('With cache'));
    await waitFor(() => expect(new URLSearchParams(lastSearch).has('scope')).toBe(false));
  });

  it('opens a client\'s requests by its normalised identifier', async () => {
    mount('/insights');
    const clients = await screen.findByTestId('insights-ranking-client');
    await waitFor(() => expect(within(clients).getByText('Claude Code')).toBeTruthy());
    fireEvent.click(within(within(clients).getAllByRole('listitem')[0]!).getByRole('button', { name: 'View requests' }));
    await waitFor(() => expect(lastPath).toBe('/usage/events'));
    const search = new URLSearchParams(lastSearch);
    expect(search.getAll('client_agent')).toEqual(['claude-code']);
    expect(search.get('from')).toBe('0');
    expect(search.has('ua')).toBe(false);
  });

  it('offers a retry when the client attribution fails to load', async () => {
    api.on('GET', '/management/insights/clients', () => json({ error: 'records unavailable' }, 500));
    const client = createTestQueryClient();
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } });
    mount('/insights', client);
    const clients = await screen.findByTestId('insights-ranking-client');
    await waitFor(() => expect(within(clients).getByText('Client attribution could not be loaded')).toBeTruthy());
    expect(within(clients).queryByText('No usage in this window')).toBeNull();

    api.on('GET', '/management/insights/clients', () => CLIENTS);
    fireEvent.click(within(clients).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(clients).getByText('Claude Code')).toBeTruthy());
  });

  it('keeps the client drill-down closed while the cube still holds the previous window', async () => {
    api.state.preferences.insights_range = { preset: '7d' };
    mount('/insights');
    const clients = await screen.findByTestId('insights-ranking-client');
    await waitFor(() => expect(within(clients).getByText('Claude Code')).toBeTruthy());
    const drill = () => within(within(clients).getAllByRole('listitem')[0]!).getByRole('button', { name: 'View requests' }) as HTMLButtonElement;
    expect(drill().disabled).toBe(false);

    // The new window's clients answer at once; its cube is held back.
    const month = { ...CUBE.window, preset: '30d', from: -28 * 86_400_000 };
    api.on('GET', '/management/insights/clients', () => ({ ...CLIENTS, window: month }));
    const cube = api.hold('GET', '/management/insights/cube');
    fireEvent.click(screen.getAllByRole('button', { name: /Last 7 days/ })[0]!);
    fireEvent.click(await screen.findByText('Last 30 days'));
    await cube.arrived;
    await waitFor(() => expect(api.requests.filter((request) => request.path === '/management/insights/clients')).toHaveLength(2));
    await waitFor(() => expect(within(clients).getByText('Claude Code')).toBeTruthy());
    expect(drill().disabled).toBe(true);

    cube.release({ ...CUBE, window: month });
    await waitFor(() => expect(drill().disabled).toBe(false));
    fireEvent.click(drill());
    await waitFor(() => expect(lastPath).toBe('/usage/events'));
    expect(new URLSearchParams(lastSearch).get('from')).toBe(String(month.from));
  });

  it('offers a retry when the usage by hour fails to load', async () => {
    api.on('GET', '/management/insights/rhythm', () => json({ error: 'records unavailable' }, 500));
    const client = createTestQueryClient();
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } });
    mount('/insights', client);
    // Three reads (two retries) must fail first; under a full suite that can outlast the default wait.
    const failure = await screen.findByText('Usage by hour could not be loaded', undefined, { timeout: 5000 });
    const frame = failure.closest('section') ?? document.body;

    api.on('GET', '/management/insights/rhythm', () => ({
      window: CUBE.window,
      cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, requests: index === 9 ? 4 : 0, total_tokens: 0, cost_nanos: 0 })),
    }));
    fireEvent.click(within(frame as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Usage by hour could not be loaded')).toBeNull());
  });

  it('opens the detail of a model and narrows the page to it from the drawer', async () => {
    mount('/insights');
    const models = await screen.findByTestId('insights-ranking-model');
    fireEvent.click(within(models).getAllByRole('button', { name: 'Open details' })[0]!);
    const drawer = await screen.findByTestId('insights-entity-drawer');
    expect(['call_point', 'model']).toContain(drawer.getAttribute('data-dimension'));
    // A model is read across the keys that called it and the providers that served it.
    expect(within(drawer).getByText('Design team')).toBeTruthy();
    expect(within(drawer).getByText('Cache read rate')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Filter to this' }));
    await waitFor(() => {
      const search = new URLSearchParams(lastSearch);
      expect([...search.getAll('call_point'), ...search.getAll('model')]).toEqual(['gpt-5']);
    });
  });

  it('offers no filter or request list for a value with a blank identity', async () => {
    // Records that named no model are one group in the ranking, with nothing a filter could hold.
    api.on('GET', '/management/insights/cube', () => ({ ...CUBE, dims: { ...CUBE.dims, call_points: ['gpt-5', ''], models: ['gpt-5', ''] } }));
    mount('/insights');
    const models = await screen.findByTestId('insights-ranking-model');
    const opens = within(models).getAllByRole('button', { name: 'Open details' });
    fireEvent.click(opens[opens.length - 1]!);
    const drawer = await screen.findByTestId('insights-entity-drawer');
    expect(drawer.getAttribute('data-dimension')).toMatch(/call_point|model/);
    expect((screen.getByRole('button', { name: 'Filter to this' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'View requests ›' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the composition views and their order on a phone', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 640px)', media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    }));
    // Sonnet is the slower model, so ordering by latency puts it above the busier GPT-5.
    const slow = row(1, 0, 1, 10, 1000);
    slow[15] = 10 * 900;
    api.on('GET', '/management/insights/cube', () => ({ ...CUBE, rows: [row(0, 0, 0, 30, 3000), slow, row(1, 1, 0, 5, 500)] }));
    mount('/insights');
    const panel = await screen.findByTestId('insights-matrix');
    const order = () => {
      const text = panel.textContent ?? '';
      return text.indexOf('sonnet') < text.indexOf('gpt-5') ? ['sonnet', 'gpt-5'] : ['gpt-5', 'sonnet'];
    };
    await waitFor(() => expect(order()).toEqual(['gpt-5', 'sonnet']));
    // The view switch's options are icons, named by their tip.
    const viewOption = (name: string) => panel.querySelector<HTMLElement>(`[data-slot="segmented-item"][data-tip="${name}"]`);
    expect(viewOption('Chart')).toBeNull();

    fireEvent.mouseDown(within(panel).getByRole('combobox', { name: 'Sort by' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Avg latency' }));
    await waitFor(() => expect(order()).toEqual(['sonnet', 'gpt-5']));

    fireEvent.click(viewOption('Table')!);
    await waitFor(() => expect(within(panel).queryByRole('combobox', { name: 'Sort by' })).toBeNull());
    fireEvent.click(viewOption('Model load profile')!);
    await waitFor(() => expect(within(panel).getByRole('combobox', { name: 'Sort by' })).toBeTruthy());
  });

  it('keeps the page frame and displays error details when the cube fails to load', async () => {
    api.on('GET', '/management/insights/cube', () => json({ error: 'hour buckets cover at most 14 days' }, 400));
    mount();
    expect(await screen.findByText('Insights could not be loaded')).toBeTruthy();
    expect(screen.getByText(/hour buckets cover at most 14 days/)).toBeTruthy();
  });

  it('waits for the cube before fetching rhythm and clients when a provider filter is active', async () => {
    const cube = api.hold('GET', '/management/insights/cube');
    mount('/insights?provider=codex');
    await cube.arrived;
    expect(api.requests.filter((request) => request.path === '/management/insights/rhythm')).toHaveLength(0);
    expect(api.requests.filter((request) => request.path === '/management/insights/clients')).toHaveLength(0);

    cube.release(CUBE);
    await waitFor(() => expect(api.requests.filter((request) => request.path === '/management/insights/rhythm')).toHaveLength(1));
    await waitFor(() => expect(api.requests.filter((request) => request.path === '/management/insights/clients')).toHaveLength(1));
    const rhythm = api.requests.find((request) => request.path === '/management/insights/rhythm');
    const clients = api.requests.find((request) => request.path === '/management/insights/clients');
    expect(rhythm?.query.getAll('auth_index')).toEqual(['c1']);
    expect(clients?.query.getAll('auth_index')).toEqual(['c1']);
  });
});

describe('insights rhythm token scope', () => {
  const week = { ...CUBE.window, from: 0, to: 7 * 86_400_000 - 1 };
  // Monday 09:00 sent 400 tokens, all of them cache; Monday 10:00 sent 60, 50 of them net.
  const cells = (hasNet: boolean): InsightsRhythmCell[] => Array.from({ length: 168 }, (_, index) => {
    const total = index === 33 ? 400 : index === 34 ? 60 : 0;
    const net = index === 34 ? 50 : 0;
    return { weekday: Math.floor(index / 24), hour: index % 24, requests: total > 0 ? 1 : 0, total_tokens: total, cost_nanos: 0, ...(hasNet ? { net_tokens: net } : {}) };
  });
  const tips = (data: InsightsRhythmResponse) => {
    renderWithOmc(<ThemeProvider><RhythmGrid data={data} measure="tokens" tokenScope="net" isLoading={false} isUncaptured={false} /></ThemeProvider>);
    fireEvent.click(within(screen.getByTestId('insights-rhythm')).getByText('By weekday'));
    return screen.getAllByRole('gridcell').map((cell) => cell.getAttribute('data-tip') ?? '');
  };

  it('reads a zero net column as zero, under the net label', () => {
    const read = tips({ window: week, cells: cells(true) });
    expect(read.every((tip) => tip.includes('Net tokens: '))).toBe(true);
    expect(read.some((tip) => /Net tokens: 50$/.test(tip))).toBe(true);
    expect(read.some((tip) => /: 400$/.test(tip))).toBe(false);
  });

  it('reads every token, labelled so, when the reply has no net column', () => {
    const read = tips({ window: week, cells: cells(false) });
    expect(read.some((tip) => tip.includes('Net tokens'))).toBe(false);
    expect(read.some((tip) => /\nTokens: 400$/.test(tip))).toBe(true);
  });
});
