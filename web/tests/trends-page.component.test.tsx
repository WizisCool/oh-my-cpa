import type React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';
import { TrendsPage } from '../src/pages/trends/TrendsPage';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type {
  TrendsQuotaResponse,
  TrendsQuotaWindow,
  TrendsTelemetryBucket,
  TrendsTelemetrySummary,
  TrendsTelemetryResponse,
  TrendsUsageResponse,
} from '../src/types/trends';

vi.mock('../src/components/dashboard/RollingNumber', () => ({
  RollingNumberGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  RollingNumber: ({ readout }: { readout?: { number: number; prefix?: string; suffix: string; format: Intl.NumberFormatOptions } }) =>
    <>{readout ? `${readout.prefix ?? ''}${new Intl.NumberFormat('en', readout.format).format(readout.number)}${readout.suffix}` : '—'}</>,
}));

const HOUR = 3_600_000;
const NOW = 2 * HOUR;
const WINDOW = { preset: '7d', from: 0, to: 3 * HOUR - 1, open_end: true, bucket: 'hour' as const, timezone: 'UTC', widened: false };

function quotaWindow(id: string, patch: Partial<TrendsQuotaWindow> = {}): TrendsQuotaWindow {
  return {
    window_id: id, label: id === '5h' ? '5-hour' : 'Weekly', period_hours: id === '5h' ? 5 : 168,
    cycle_start_ms: 0, cycle_reset_ms: 5 * HOUR, used_percent: 60, remaining_percent: 40,
    status: 'projected_exhaust', projected_exhaust_at_ms: 3 * HOUR, projected_end_percent: 140, burn_rate_per_hour: 30,
    current_requests: 30, current_net_tokens: 9000, current_total_tokens: 12000, current_cost_nanos: 0,
    buckets: [
      { start_ms: 0, end_ms: HOUR, used_percent: 25, delta_percent: 25, requests: 10, net_tokens: 3000, total_tokens: 4000, is_forecast: false },
      { start_ms: HOUR, end_ms: 2 * HOUR, used_percent: 60, delta_percent: 35, requests: 20, net_tokens: 6000, total_tokens: 8000, is_forecast: false },
      { start_ms: 2 * HOUR, end_ms: 5 * HOUR, used_percent: 140, delta_percent: 80, requests: 0, net_tokens: 0, total_tokens: 0, is_forecast: true },
    ],
    cycles: [],
    ...patch,
  };
}

const QUOTA: TrendsQuotaResponse = {
  as_of_ms: NOW,
  summary: { active_credentials: 1, observable_windows: 2, healthy_windows: 1, limit_reached_windows: 0, projected_exhaust_windows: 1, underutilized_windows: 0 },
  items: [{
    auth_index: 'c1', provider: 'codex', display_name: 'Team Codex', account_label: 'te…@x.com', status: 'active', observed_at_ms: NOW,
    // The weekly window burns slowly: its exhaustion instant falls after the reset, so it is no warning.
    windows: [quotaWindow('5h'), quotaWindow('weekly', { used_percent: 12, status: 'normal', projected_exhaust_at_ms: 8 * HOUR, projected_end_percent: 30 })],
  }],
};

function usageBucket(start: number, net: number, cum: number) {
  return {
    start_ms: start, requests: 5, net_tokens: net, total_tokens: net * 2, cost_nanos: 0, cum_net_tokens: cum, cum_total_tokens: cum * 2,
    cum_requests: 5, cum_cost_nanos: 0, compare_cum_net_tokens: cum / 2, prompt_tokens: net, completion_tokens: 0, reasoning_tokens: 0,
    cache_read_tokens: 0, cache_rate: 50, reasoning_share: 20,
  };
}

const USAGE: TrendsUsageResponse = {
  window: WINDOW,
  compare_window: { from: -3 * HOUR, to: -1 },
  group_by: 'call_point',
  totals: {
    requests: 15, failures: 1, net_tokens: 4500, total_tokens: 9000, cost_nanos: 0, prompt_tokens: 4500, completion_tokens: 0,
    reasoning_tokens: 0, cache_read_tokens: 4500, cache_creation_tokens: 0, cache_rate: 50, reasoning_share: null, priced_requests: 0, costed_requests: 0,
  },
  compare_totals: { requests: 10, net_tokens: 3000, total_tokens: 6000, cost_nanos: 0, baseline_requests: 12, baseline_net_tokens: 3600, baseline_total_tokens: 6000, baseline_cost_nanos: 0 },
  buckets: [usageBucket(0, 1000, 1000), usageBucket(HOUR, 1500, 2500), usageBucket(2 * HOUR, 2000, 4500)],
  series: [{ id: 'sonnet', label: 'sonnet', folded: false, requests: 15, net_tokens: 4500, total_tokens: 9000, cost_nanos: 0, buckets: [] }],
  movers: {
    metric: 'net_tokens',
    risers: [{
      id: 'sonnet', label: 'sonnet', net_tokens: 4500, requests: 15, baseline_net_tokens: 3000, baseline_requests: 10,
      delta_net_tokens: 1500, delta_requests: 5, delta_percent: 50, z_score: 2.4, status: 'rising',
    }],
    fallers: [],
  },
  coverage: { fact_requests: 15, detail_requests: 15 },
};

function telemetryBucket(start: number, patch: Partial<TrendsTelemetryBucket> = {}): TrendsTelemetryBucket {
  return {
    start_ms: start, total_requests: 5, success_requests: 5, failed_requests: 0, rate_limited_429: 0, upstream_5xx: 0,
    stream_truncated: 0, force_cooldown: 0, other_failures: 0, model_substituted: 0, tps_mean: 40, tps_p50: 40, tps_samples: 5,
    ttft_p50_ms: 700, ttft_p95_ms: 1400, ttft_samples: 5, latency_p50_ms: 3000, latency_p95_ms: 6000, latency_samples: 5, ...patch,
  };
}

const TELEMETRY: TrendsTelemetryResponse = {
  window: WINDOW,
  tps_mode: 'exclude_ttft',
  group_by: 'call_point',
  summary: { ...telemetryBucket(0), total_requests: 20, success_requests: 18, failed_requests: 2, rate_limited_429: 1, upstream_5xx: 1, model_substituted: 3, tps_p50: 42.3 },
  buckets: [telemetryBucket(0), telemetryBucket(HOUR, { rate_limited_429: 1, model_substituted: 3 }), telemetryBucket(2 * HOUR, { upstream_5xx: 1 })],
  series: [{ ...telemetryBucket(0), id: 'sonnet', label: 'sonnet', buckets: [telemetryBucket(0)] }],
  scatter: [],
  substitution_pairs: [{ requested_model: 'gpt-5', served_model: 'gpt-5-mini', provider: 'codex', count: 3 }],
  coverage: { fact_requests: 20, retained_requests: 12, retention_start_ms: HOUR, is_truncated_by_retention: true },
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

function mount(route = '/trends') {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } });
  return renderWithOmc(
    <Routes>
      <Route path="/trends" element={<ThemeProvider><TrendsPage /><LocationProbe /></ThemeProvider>} />
      <Route path="/usage/events" element={<LocationProbe />} />
      <Route path="/oauth-management" element={<LocationProbe />} />
    </Routes>,
    { route, client },
  );
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  api = installOmcApi();
  api.on('GET', '/management/trends/quota', () => QUOTA);
  api.on('GET', '/management/trends/usage', () => USAGE);
  api.on('GET', '/management/trends/telemetry', () => TELEMETRY);
});

describe('trends page', () => {
  it('reads the three trends and leads with the most pressing quota window', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('60.0%'));
    await waitFor(() => expect(screen.getByTestId('trends-tile-movers').textContent).toContain('4.5K'));
    // The tiles read in the order of the panels they open; the net token flow has no panel of its own.
    const tiles = within(screen.getByTestId('trends-tiles')).getAllByTestId(/^trends-tile-/).map((tile) => tile.getAttribute('data-testid'));
    expect(tiles).toEqual(['trends-tile-quota', 'trends-tile-speed', 'trends-tile-movers', 'trends-tile-delivery']);
    expect(screen.queryByTestId('trends-throughput')).toBeNull();
    const quota = screen.getByTestId('trends-quota');
    expect(within(quota).getByText('Subscription quota trends')).toBeTruthy();
    // The head reads the cycle as figures, each a label over its value.
    const figure = (label: string) => within(quota).getByText(label).nextElementSibling?.textContent;
    expect(figure('Hits limit')).toBe('03:00');
    expect(figure('Resets in')).toBe('3h 0m');
    expect(figure('Burn rate')).toBe('30.00%/h');
    // This period's net tokens against the previous period's robust baseline, not the previous total.
    const movers = screen.getByTestId('trends-tile-movers');
    expect(within(movers).getByText('Net tokens')).toBeTruthy();
    expect(within(movers).getByText('+25.0% vs baseline')).toBeTruthy();
    expect(within(movers).queryByText(/sonnet|rising|falling/)).toBeNull();
    // The quota tile counts the credentials it can project and how many are at risk.
    const quotaTile = screen.getByTestId('trends-tile-quota');
    expect(within(quotaTile).getByText('1')).toBeTruthy();
    expect(within(quotaTile).getByText('1 heading for limit')).toBeTruthy();
    expect(within(quotaTile).queryByText(/at limit|within limits/)).toBeNull();
    const speed = screen.getByTestId('trends-tile-speed');
    expect(within(speed).getByText('TTFT P95 1.40s')).toBeTruthy();
    expect(within(speed).queryByText('Excludes TTFT')).toBeNull();
    const delivery = screen.getByTestId('trends-tile-delivery');
    expect(within(delivery).getByText('1 rate limited (429)')).toBeTruthy();
    expect(within(delivery).getByText('1 upstream 5xx')).toBeTruthy();
    // Two causes at most, failures before substitutions.
    expect(within(delivery).queryByText(/substituted|truncated/)).toBeNull();
    // An overview strip opens with no tile picked.
    expect(screen.queryAllByRole('button', { pressed: true }).filter((button) => button.dataset.testid?.startsWith('trends-tile-'))).toEqual([]);
    // So is a mover's change.
    const riser = await screen.findByTestId('trends-movers-risers');
    expect(within(riser).getByText('+50.0%')).toBeTruthy();
    expect(within(screen.getByTestId('trends-tile-delivery')).getByText('90.0%')).toBeTruthy();
    // The usage read groups by the call name the console's model view names, and leaves the default range implicit.
    const usageRead = api.requests.find((request) => request.path === '/management/trends/usage')!;
    expect(usageRead.query.get('group_by')).toBe('call_point');
    expect(usageRead.query.get('preset')).toBe('7d');
  });

  it('switches the quota window and steps the burn curve with the arrow keys', async () => {
    mount();
    const chart = await screen.findByTestId('trends-quota-chart', {}, { timeout: 5000 });
    const readout = screen.getByTestId('trends-quota-readout');
    expect(readout.hidden).toBe(true);

    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(readout.hidden).toBe(false);
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    // The second reading: the first hour, at a quarter of the window.
    expect(within(readout).getByText('25.0%')).toBeTruthy();
    expect(within(readout).getByText('+25.0%')).toBeTruthy();
    expect(within(readout).getByText('10')).toBeTruthy();

    fireEvent.keyDown(chart, { key: 'End' });
    expect(within(readout).getByText('140%')).toBeTruthy();
    expect(within(readout).getByText('Projected from the current rate of use')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(readout.hidden).toBe(true);

    // The pointer drags the readout along with it, and leaving the chart puts it away.
    fireEvent.pointerMove(chart, { clientX: 120, clientY: 60 });
    expect(readout.hidden).toBe(false);
    expect(readout.dataset.follow).toBe('pointer');
    const near = readout.style.transform;
    expect(near).toMatch(/^translate3d\(/);
    fireEvent.pointerMove(chart, { clientX: 400, clientY: 140 });
    expect(readout.style.transform).not.toBe(near);
    fireEvent.pointerLeave(chart);
    expect(readout.hidden).toBe(true);
    // A keyboard step anchors it on the point instead.
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(readout.dataset.follow).toBe('key');
    fireEvent.keyDown(chart, { key: 'Escape' });

    // The credential picker names each credential beside its brand.
    expect(screen.getByTestId('trends-quota-credential').querySelector('[data-value-mark]')).not.toBeNull();
    // A window heading for its limit carries a dot even while selected; the closed credential control does not repeat what the figures say.
    expect(screen.getByTestId('trends-quota-credential').querySelector('.attention-dot')).toBeNull();
    const windows = screen.getByTestId('trends-quota-window');
    const fiveHourRadio = within(windows).getByRole('radio', { name: /5 hours/ });
    expect(fiveHourRadio.getAttribute('aria-checked')).toBe('true');
    expect(within(fiveHourRadio).getByRole('img', { name: 'Hits limit' })).toBeTruthy();
    expect(within(within(windows).getByRole('radio', { name: 'Weekly' })).queryByRole('img')).toBeNull();

    fireEvent.click(within(screen.getByTestId('trends-quota-window')).getByRole('radio', { name: 'Weekly' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).get('quota_window')).toBe('weekly'));
    expect(new URLSearchParams(lastSearch).get('quota_auth')).toBe('c1');
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('12.0%'));
    const quota = screen.getByTestId('trends-quota');
    expect(within(quota).getByText('At reset').nextElementSibling?.textContent).toBe('30.0%');
    expect(within(quota).queryByText('Hits limit')).toBeNull();
    expect(within(within(screen.getByTestId('trends-quota-window')).getByRole('radio', { name: /5 hours/ })).getByRole('img', { name: 'Hits limit' })).toBeTruthy();
  });

  it('zooms and pans the quota chart and starts each window on its whole cycle', async () => {
    mount();
    const chart = await screen.findByTestId('trends-quota-chart', {}, { timeout: 5000 });
    const lens = screen.getByTestId('trends-quota-lens');
    const view = () => [Number(lens.dataset.lensStart), Number(lens.dataset.lensEnd)];
    const whole = view();
    expect(within(lens).getByRole('button', { name: 'Show the whole cycle' })).toHaveProperty('disabled', true);
    expect(within(lens).getByRole('button', { name: 'Pan earlier' })).toHaveProperty('disabled', true);

    // Half the cycle about its middle: the reading at two hours and the projected exhaustion milestone stay in view.
    fireEvent.click(within(lens).getByRole('button', { name: 'Zoom in' }));
    expect(view()).toEqual([1.25 * HOUR, 3.75 * HOUR]);
    const readout = screen.getByTestId('trends-quota-readout');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(within(readout).getByText('60.0%')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'End' });
    expect(within(readout).getByText('100%')).toBeTruthy();
    expect(within(readout).getByText(/Projected to hit the limit/)).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });

    fireEvent.click(within(lens).getByRole('button', { name: 'Pan earlier' }));
    expect(view()[0]).toBeLessThan(1.25 * HOUR);
    fireEvent.click(within(lens).getByRole('button', { name: 'Pan later' }));
    fireEvent.click(within(lens).getByRole('button', { name: 'Pan later' }));
    fireEvent.click(within(lens).getByRole('button', { name: 'Pan later' }));
    fireEvent.click(within(lens).getByRole('button', { name: 'Pan later' }));
    expect(view()).toEqual([2.5 * HOUR, 5 * HOUR]);
    expect(within(lens).getByRole('button', { name: 'Pan later' })).toHaveProperty('disabled', true);

    // Ctrl with the wheel zooms; a plain wheel is left to scroll the page.
    const plain = fireEvent.wheel(chart, { deltaY: 100 });
    expect(plain).toBe(true);
    expect(view()).toEqual([2.5 * HOUR, 5 * HOUR]);
    expect(fireEvent.wheel(chart, { deltaY: 1000, ctrlKey: true })).toBe(false);
    expect(view()).toEqual(whole);

    fireEvent.click(within(lens).getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(within(lens).getByRole('button', { name: 'Zoom out' }));
    expect(view()).toEqual(whole);

    // Another window opens on its own whole cycle.
    fireEvent.click(within(lens).getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(within(screen.getByTestId('trends-quota-window')).getByRole('radio', { name: 'Weekly' }));
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('12.0%'));
    expect(within(screen.getByTestId('trends-quota-lens')).getByRole('button', { name: 'Show the whole cycle' })).toHaveProperty('disabled', true);
  });

  it('keeps each panel mode in the URL and drills into the request list', async () => {
    mount();
    await screen.findByTestId('trends-perf-chart');
    // Each series in the legend carries its model's mark beside its name and toggles highlight like the dashboard trend chart.
    const perf = screen.getByTestId('trends-performance');
    expect(within(perf).getByText('sonnet').closest('span')?.parentElement?.querySelector('[data-value-mark]')).not.toBeNull();
    const legendBtn = within(screen.getByTestId('trends-perf-legend')).getByRole('button', { name: 'sonnet' });
    expect(legendBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(legendBtn);
    expect(legendBtn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(legendBtn);
    expect(legendBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(screen.getByTestId('trends-perf-mode')).getByRole('radio', { name: 'Time to first token' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).get('perf')).toBe('ttft'));
    expect(screen.getByTestId('trends-perf-chart').getAttribute('data-mode')).toBe('ttft');
    // The group selector stays available and a model filter narrows TTFT and total duration to one item's band.
    expect(within(perf).getByTestId('trends-perf-group')).toBeTruthy();
    const itemSelect = within(perf).getByTestId('trends-perf-item');
    fireEvent.mouseDown(itemSelect);
    fireEvent.click(await screen.findByRole('option', { name: 'sonnet' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).get('perf_item')).toBe('sonnet'));
    fireEvent.click(within(screen.getByTestId('trends-perf-mode')).getByRole('radio', { name: 'Total duration' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).get('perf')).toBe('latency'));
    expect(new URLSearchParams(lastSearch).get('perf_item')).toBe('sonnet');
    fireEvent.mouseDown(within(perf).getByTestId('trends-perf-group'));
    fireEvent.click(await screen.findByRole('option', { name: 'Provider' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).has('perf_item')).toBe(false));

    // The movers pick their own grouping in their panel's head.
    const moversPanel = await screen.findByTestId('trends-movers');
    fireEvent.mouseDown(within(moversPanel).getByRole('combobox', { name: 'Group by' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Client key' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).get('group')).toBe('key'));
    await waitFor(() => expect(api.requests.some((request) => request.path === '/management/trends/usage' && request.query.get('group_by') === 'key')).toBe(true));
    fireEvent.mouseDown(within(moversPanel).getByRole('combobox', { name: 'Group by' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Model' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).has('group')).toBe(false));

    // A mover narrows the page by its own dimension.
    const riser = await within(await screen.findByTestId('trends-movers-risers')).findByRole('button', { name: /^sonnet/ });
    fireEvent.click(riser);
    await waitFor(() => expect(new URLSearchParams(lastSearch).getAll('model_alias')).toEqual(['sonnet']));
    await waitFor(() => expect(api.requests.some((request) => request.path === '/management/trends/usage' && request.query.get('model_alias') === 'sonnet')).toBe(true));

    fireEvent.click(screen.getByTestId('trends-quota-events'));
    await waitFor(() => expect(lastPath).toBe('/usage/events'));
    const drill = new URLSearchParams(lastSearch);
    expect(drill.getAll('auth_index')).toEqual(['c1']);
    expect(drill.get('from')).toBe('0');
    expect(drill.has('to')).toBe(false);
  });

  it('adds, searches, and clears filters from the explicit filter bar', async () => {
    api.on('GET', '/management/trends/usage', (request) => {
      const groupBy = request.query.get('group_by') ?? 'model';
      if (groupBy === 'provider') {
        return { ...USAGE, group_by: 'provider', groups: [{ id: 'codex', label: 'codex', requests: 15 }] };
      }
      return { ...USAGE, group_by: groupBy };
    });
    mount();
    const addBtn = await screen.findByTestId('trends-filter-add');
    fireEvent.click(addBtn);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Provider' }));
    const providerOpt = await within(await screen.findByTestId('trends-filter-values')).findByText('Codex');
    fireEvent.click(providerOpt);
    await waitFor(() => expect(new URLSearchParams(lastSearch).getAll('provider')).toEqual(['codex']));
    expect(screen.getByTestId('trends-filter-requests')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('trends-filters')).getByRole('button', { name: 'Clear all filters' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).has('provider')).toBe(false));
  });

  it('displays per-model legend and P50/P95 toggle in TTFT and total duration modes', async () => {
    mount();
    await screen.findByTestId('trends-perf-chart');
    const perf = screen.getByTestId('trends-performance');
    fireEvent.click(within(screen.getByTestId('trends-perf-mode')).getByRole('radio', { name: 'Time to first token' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).get('perf')).toBe('ttft'));
    const ttftLegendBtn = within(screen.getByTestId('trends-perf-legend')).getByRole('button', { name: 'sonnet' });
    fireEvent.click(ttftLegendBtn);
    expect(ttftLegendBtn.getAttribute('aria-pressed')).toBe('true');
    const quantileToggle = within(perf).getByTestId('trends-perf-quantile');
    fireEvent.click(within(quantileToggle).getByRole('radio', { name: 'P95' }));
    expect(within(quantileToggle).getByRole('radio', { name: 'P95' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(screen.getByTestId('trends-perf-mode')).getByRole('radio', { name: 'Total duration' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).get('perf')).toBe('latency'));
    expect(within(screen.getByTestId('trends-perf-legend')).getByRole('button', { name: 'sonnet' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('marks every grouping the movers rank by with the console\'s own identity', async () => {
    const MARKED: Record<string, { id: string; name: string }> = {
      call_point: { id: 'sonnet', name: 'sonnet' },
      key: { id: 'hmac:abc', name: 'ci-bot' },
      client_agent: { id: 'claude-code', name: 'Claude Code' },
      provider: { id: 'codex', name: 'Codex' },
      // An API-key credential is named by the provider that claims its index, not by a bare index tag.
      credential: { id: '8f32a1b4c5d6e7f8', name: 'Relay One' },
    };
    api.state.providers.push({ id: 'openai-compat-0', name: 'Relay One', auth_indexes: ['8f32a1b4c5d6e7f8'] } as unknown as (typeof api.state.providers)[number]);
    api.on('GET', '/management/trends/usage', (request) => {
      const groupBy = request.query.get('group_by') ?? 'model';
      const item = MARKED[groupBy]!;
      const riser = { ...USAGE.movers.risers[0]!, id: item.id, label: item.id, ...(groupBy === 'key' ? { alias: 'ci-bot', mask: 'sk-…abc' } : {}) };
      return { ...USAGE, group_by: groupBy, movers: { ...USAGE.movers, risers: [riser] } };
    });
    mount();
    for (const [group, option] of [['call_point', null], ['key', 'Client key'], ['client_agent', 'Client program'], ['provider', 'Provider'], ['credential', 'OAuth credential']] as const) {
      const panel = await screen.findByTestId('trends-movers');
      if (option) {
        fireEvent.mouseDown(within(panel).getByRole('combobox', { name: 'Group by' }));
        fireEvent.click(await screen.findByRole('option', { name: option }));
      }
      const name = MARKED[group]!.name;
      const button = await within(await screen.findByTestId('trends-movers-risers')).findByRole('button', { name: new RegExp(`^${name}`) });
      expect(button.querySelector('[data-value-mark]')?.childElementCount).toBeGreaterThan(0);
    }
  });

  it('steps the speed bench window back and returns to the default range', async () => {
    api.state.preferences.insights_range = { preset: '7d' };
    const past = { ...WINDOW, from: 10 * HOUR, to: 13 * HOUR - 1, open_end: false };
    api.on('GET', '/management/trends/quota', () => ({ ...QUOTA, as_of_ms: 20 * HOUR }));
    api.on('GET', '/management/trends/telemetry', () => ({ ...TELEMETRY, window: past }));
    mount();
    const tools = await screen.findByTestId('trends-perf-window');
    const reset = within(tools).getByRole('button', { name: 'Back to the default range' });
    expect(reset).toHaveProperty('disabled', true);
    fireEvent.click(within(tools).getByRole('button', { name: 'Previous span' }));
    await waitFor(() => expect(api.requests.some((request) => request.path === '/management/trends/telemetry' && request.query.get('from') === String(7 * HOUR))).toBe(true));
    await waitFor(() => expect(within(screen.getByTestId('trends-perf-window')).getByRole('button', { name: 'Back to the default range' })).toHaveProperty('disabled', false));
    fireEvent.click(within(screen.getByTestId('trends-perf-window')).getByRole('button', { name: 'Back to the default range' }));
    await waitFor(() => expect(api.state.preferences.insights_range).toEqual({ preset: '7d' }));
    await waitFor(() => expect(within(screen.getByTestId('trends-perf-window')).getByRole('button', { name: 'Back to the default range' })).toHaveProperty('disabled', true));
  });

  it('lists substitutions with a link to their requests and notes the retention horizon', async () => {
    mount();
    const pairs = await screen.findByTestId('trends-substitutions', {}, { timeout: 5000 });
    expect(within(pairs).getByText('gpt-5-mini')).toBeTruthy();
    // The provider is named and marked the way the rest of the console names it.
    expect(within(pairs).getByText('Codex')).toBeTruthy();
    expect(within(pairs).getAllByRole('listitem')[0]!.querySelectorAll('svg, img').length).toBeGreaterThanOrEqual(3);
    // Each lane reads against a time scale under the cells.
    expect(within(screen.getByTestId('trends-stability')).getByText('01-01 00:00')).toBeTruthy();
    expect(screen.getByTestId('trends-retention-notice')).toBeTruthy();
    expect(within(screen.getByTestId('trends-lane-model_substituted')).getByText('3')).toBeTruthy();
    // A lane that saw nothing is left out rather than drawn empty.
    expect(screen.queryByTestId('trends-lane-stream_truncated')).toBeNull();
    fireEvent.click(within(pairs).getByTestId('trends-substitution-events'));
    await waitFor(() => expect(lastPath).toBe('/usage/events'));
    const drill = new URLSearchParams(lastSearch);
    expect(drill.get('served')).toBe('substituted');
    expect(drill.getAll('model')).toEqual(['gpt-5']);
  });

  it('says a window without failures or substitutions ran clean instead of drawing empty lanes', async () => {
    const calm = <T extends TrendsTelemetrySummary>(bucket: T): T => ({
      ...bucket,
      success_requests: bucket.total_requests,
      failed_requests: 0,
      rate_limited_429: 0,
      upstream_5xx: 0,
      stream_truncated: 0,
      force_cooldown: 0,
      other_failures: 0,
      model_substituted: 0,
    });
    api.on('GET', '/management/trends/telemetry', () => ({
      ...TELEMETRY, summary: calm(TELEMETRY.summary), buckets: TELEMETRY.buckets.map(calm), substitution_pairs: [],
    }));
    mount();
    expect(await screen.findByTestId('trends-stability-clear', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByTestId('trends-lane-rate_limited_429')).toBeNull();
    expect(screen.queryByTestId('trends-substitutions')).toBeNull();
  });

  it('shows a quiet notice and does not retry a window the demonstration did not capture', async () => {
    api.on('GET', '/management/trends/usage', () => json({ error: 'not captured', code: 'demo_uncaptured' }, 404));
    api.on('GET', '/management/trends/telemetry', () => json({ error: 'not captured', code: 'demo_uncaptured' }, 404));
    mount('/trends?model=gpt-5');
    expect(await screen.findByTestId('trends-uncaptured')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('trends-quota-used')).toBeTruthy());
    // The panels that read the uncaptured window say so instead of loading forever.
    expect(within(await screen.findByTestId('trends-movers')).getByText('The demo does not hold this view')).toBeTruthy();
    expect(within(screen.getByTestId('trends-stability')).getByText('The demo does not hold this view')).toBeTruthy();
    expect(api.requests.filter((request) => request.path === '/management/trends/usage')).toHaveLength(1);
  });

  it('keeps touch quota readout open on pointerLeave', async () => {
    mount();
    const chart = await screen.findByTestId('trends-quota-chart', {}, { timeout: 5000 });
    const readout = screen.getByTestId('trends-quota-readout');
    fireEvent.pointerDown(chart, { clientX: 180, clientY: 80, pointerType: 'touch' });
    expect(readout.hidden).toBe(false);
    fireEvent.pointerLeave(chart, { pointerType: 'touch' });
    expect(readout.hidden).toBe(false);
    fireEvent.pointerCancel(chart, { pointerType: 'touch' });
    expect(readout.hidden).toBe(true);
  });

  it('scopes substitution links to telemetry.window and surfaces secondary telemetryItemQuery errors', async () => {
    const telemetryWindow = { ...WINDOW, from: 10 * HOUR, to: 12 * HOUR - 1, open_end: false };
    api.on('GET', '/management/trends/telemetry', (request) => {
      if (request.query.get('model_alias') === 'tail-model') {
        return json({ error: 'tail failed' }, 500);
      }
      return {
        ...TELEMETRY,
        window: telemetryWindow,
        groups: [{ id: 'sonnet', label: 'sonnet' }, { id: 'tail-model', label: 'tail-model' }],
      };
    });
    mount('/trends?perf=ttft&perf_item=tail-model');
    const perf = await screen.findByTestId('trends-performance', {}, { timeout: 5000 });
    await waitFor(() => expect(within(perf).getByRole('button', { name: 'Retry' })).toBeTruthy());

    const pairs = await screen.findByTestId('trends-substitutions');
    fireEvent.click(within(pairs).getByTestId('trends-substitution-events'));
    await waitFor(() => expect(lastPath).toBe('/usage/events'));
    const drill = new URLSearchParams(lastSearch);
    expect(drill.get('from')).toBe(String(telemetryWindow.from));
    expect(drill.get('to')).toBe(String(telemetryWindow.to));
  });

  it('retries all failed primary queries on page LoadFailure', async () => {
    let shouldFail = true;
    api.on('GET', '/management/trends/usage', () => (shouldFail ? json({ error: 'usage boom' }, 500) : USAGE));
    api.on('GET', '/management/trends/telemetry', () => (shouldFail ? json({ error: 'telemetry boom' }, 500) : TELEMETRY));
    api.on('GET', '/management/trends/quota', () => (shouldFail ? json({ error: 'quota boom' }, 500) : QUOTA));

    mount();
    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    shouldFail = false;
    fireEvent.click(retryBtn);
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('60.0%'));
    await waitFor(() => expect(screen.getByTestId('trends-tile-movers').textContent).toContain('4.5K'));
  });

  it('resets bucket=hour to auto when the active range exceeds 14 days', async () => {
    api.state.preferences.insights_range = { preset: '30d' };
    mount('/trends?bucket=hour');
    await screen.findByTestId('trends-perf-chart', {}, { timeout: 5000 });
    await waitFor(() => expect(new URLSearchParams(lastSearch).has('bucket')).toBe(false));
    const telemetryRead = api.requests.find((request) => request.path === '/management/trends/telemetry');
    expect(telemetryRead?.query.get('bucket')).toBeNull();
  });

  it('shows other_failures lane and stale quota reading notice, and disables substitution drill-down when redacted', async () => {
    api.on('GET', '/management/trends/quota', () => ({
      ...QUOTA,
      items: [{
        ...QUOTA.items[0]!,
        status: 'stale',
        windows: [{ ...QUOTA.items[0]!.windows[0]!, status: 'normal', projected_exhaust_at_ms: undefined, projected_end_percent: undefined }],
      }],
    }));
    api.on('GET', '/management/trends/telemetry', () => ({
      ...TELEMETRY,
      summary: { ...TELEMETRY.summary, rate_limited_429: 0, upstream_5xx: 0, stream_truncated: 0, force_cooldown: 0, other_failures: 2, model_substituted: 1 },
      buckets: TELEMETRY.buckets.map((b, i) => ({ ...b, rate_limited_429: 0, upstream_5xx: 0, stream_truncated: 0, force_cooldown: 0, other_failures: i === 0 ? 2 : 0 })),
      substitution_pairs: [{ requested_model: 'redacted:req', served_model: 'gpt-5-mini', provider: 'codex', drill_disabled: true, count: 1 }],
    }));

    mount();
    expect(await screen.findByTestId('trends-quota-stale-notice', {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByTestId('trends-lane-other_failures')).toBeTruthy();
    expect(screen.queryByTestId('trends-stability-clear')).toBeNull();
    const pairs = await screen.findByTestId('trends-substitutions');
    const drillBtn = within(pairs).getByTestId('trends-substitution-events') as HTMLButtonElement;
    expect(drillBtn.disabled).toBe(true);
  });

  it('ignores stale keepPreviousData placeholder windows when resolving shownWindow and drill-downs', async () => {
    const initialWindow = { ...WINDOW, from: 10 * HOUR, to: 13 * HOUR - 1, open_end: false };
    const shiftedWindow = { ...WINDOW, from: 7 * HOUR, to: 10 * HOUR - 1, open_end: false };
    api.on('GET', '/management/trends/quota', () => ({ ...QUOTA, as_of_ms: 20 * HOUR }));
    api.on('GET', '/management/trends/usage', () => ({ ...USAGE, window: initialWindow }));
    api.on('GET', '/management/trends/telemetry', () => ({ ...TELEMETRY, window: initialWindow }));

    mount();
    await waitFor(() => expect((screen.getByTestId('trends-events') as HTMLButtonElement).disabled).toBe(false));
    const tools = await screen.findByTestId('trends-perf-window');

    const heldUsage = api.hold('GET', '/management/trends/usage');
    const heldTelemetry = api.hold('GET', '/management/trends/telemetry');
    fireEvent.click(within(tools).getByRole('button', { name: 'Previous span' }));

    await heldUsage.arrived;
    await heldTelemetry.arrived;
    // While both queries hold keepPreviousData placeholders, charts stay visible and drill-down is disabled.
    expect(screen.getByTestId('trends-tile-movers').textContent).toContain('4.5K');
    expect((screen.getByTestId('trends-events') as HTMLButtonElement).disabled).toBe(true);

    // Once telemetry resolves with the new window while usage is still placeholder, shownWindow
    // uses the live telemetry window rather than the stale placeholder usage window.
    heldTelemetry.release({ ...TELEMETRY, window: shiftedWindow });
    await waitFor(() => expect((screen.getByTestId('trends-events') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('trends-events'));
    await waitFor(() => expect(lastPath).toBe('/usage/events'));
    expect(new URLSearchParams(lastSearch).get('from')).toBe(String(shiftedWindow.from));

    heldUsage.release({ ...USAGE, window: shiftedWindow });
  });

  it('shows physical-usage-unavailable empty state for feature quota windows', async () => {
    api.on('GET', '/management/trends/quota', () => ({
      ...QUOTA,
      items: [{
        ...QUOTA.items[0]!,
        windows: [quotaWindow('code_review_5h', {
          label: '代码审查',
          scope: 'code_review',
          is_physical_unavailable: true,
          current_requests: 0,
          current_net_tokens: 0,
          current_total_tokens: 0,
          cycles: [{ cycle_start_ms: 0, cycle_reset_ms: 5 * HOUR, is_current: true, used_percent: 60, actual_requests: 0, actual_net_tokens: 0, actual_total_tokens: 0 }],
        })],
      }],
    }));

    mount();
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('60.0%'));
    expect((screen.getByTestId('trends-quota-events') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Cycle capacity' }));
    expect(await screen.findByText('Feature quota usage is not tracked per request')).toBeTruthy();
  });

  it('reports membership and risk unknown when CPA is unavailable while keeping historical readings visible', async () => {
    api.on('GET', '/management/trends/quota', () => ({
      as_of_ms: 2 * HOUR,
      summary: { active_credentials: 0, is_membership_unknown: true, observable_windows: 1, healthy_windows: 0, limit_reached_windows: 0, projected_exhaust_windows: 0, underutilized_windows: 0 },
      items: [{
        ...QUOTA.items[0]!,
        status: 'unknown',
        windows: [quotaWindow('5h', { status: 'normal', burn_rate_per_hour: undefined, projected_exhaust_at_ms: undefined, projected_end_percent: undefined })],
      }],
    }));

    mount();
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('60.0%'));
    expect(await screen.findByTestId('trends-quota-stale-notice', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTestId('trends-tile-quota').textContent).toContain('—');
  });
});
