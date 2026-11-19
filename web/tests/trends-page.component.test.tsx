import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';
import { TrendsPage } from '../src/pages/trends/TrendsPage';
import { QuotaBurnChart } from '../src/pages/trends/charts/QuotaBurnChart';
import { buildQuotaBurnSeries } from '../src/pages/trends/trendsLogic';
import { ChartContainer, ChartTooltipContent } from '../src/components/ui/chart';
import { sharedResizeObserverHub } from '../src/performance/resizeObserverHub';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type {
  TrendsQuotaResponse,
  TrendsQuotaWindow,
  TrendsTelemetryBucket,
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
  const result = renderWithOmc(
    <Routes>
      <Route path="/trends" element={<ThemeProvider><TrendsPage /><LocationProbe /></ThemeProvider>} />
      <Route path="/usage/events" element={<LocationProbe />} />
      <Route path="/oauth-management" element={<LocationProbe />} />
    </Routes>,
    { route, client },
  );
  return { ...result, client };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  api = installOmcApi();
  api.on('GET', '/management/trends/quota', () => QUOTA);
  api.on('GET', '/management/trends/usage', () => USAGE);
  api.on('GET', '/management/trends/telemetry', () => TELEMETRY);
});

describe('trends page', () => {
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

  it('zooms and pans the quota chart via wheel modifiers and starts each window on its whole cycle', async () => {
    mount();
    const chart = await screen.findByTestId('trends-quota-chart', {}, { timeout: 5000 });
    expect(screen.queryByTestId('trends-quota-lens')).toBeNull();
    expect(screen.queryByTestId('trends-perf-window')).toBeNull();
    const readout = screen.getByTestId('trends-quota-readout');

    // A plain wheel is left to scroll the page.
    expect(fireEvent.wheel(chart, { deltaY: 100 })).toBe(true);

    // Ctrl with the wheel zooms in around the pointer: only 2h (60.0%) and the 3h milestone (100%) stay visible.
    expect(fireEvent.wheel(chart, { deltaY: -460, clientX: 400, ctrlKey: true })).toBe(false);
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(within(readout).getByText('60.0%')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'End' });
    expect(within(readout).getByText('100%')).toBeTruthy();
    expect(within(readout).getByText(/Projected to hit the limit/)).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });

    // Shift with the wheel pans toward the end of the cycle without zooming out to 0h.
    expect(fireEvent.wheel(chart, { deltaY: 200, shiftKey: true })).toBe(false);
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(within(readout).getByText('100%')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'End' });
    expect(within(readout).getByText('140%')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });

    // Ctrl with positive wheel delta zooms back out to the whole cycle.
    expect(fireEvent.wheel(chart, { deltaY: 1000, clientX: 400, ctrlKey: true })).toBe(false);
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(within(readout).getByText('0.0%')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });

    // Another window opens on its own whole cycle even if the previous window was zoomed in.
    expect(fireEvent.wheel(chart, { deltaY: -460, clientX: 400, ctrlKey: true })).toBe(false);
    fireEvent.click(within(screen.getByTestId('trends-quota-window')).getByRole('radio', { name: 'Weekly' }));
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('12.0%'));
    const weeklyChart = await screen.findByTestId('trends-quota-chart');
    const weeklyReadout = screen.getByTestId('trends-quota-readout');
    fireEvent.keyDown(weeklyChart, { key: 'Home' });
    expect(within(weeklyReadout).getByText('0.0%')).toBeTruthy();
    fireEvent.keyDown(weeklyChart, { key: 'End' });
    expect(within(weeklyReadout).getByText('140%')).toBeTruthy();
    fireEvent.keyDown(weeklyChart, { key: 'Escape' });
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
    fireEvent.click(await screen.findByRole('button', { name: 'Provider' }));
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

  it('shows a quiet notice with reset for filter-only uncaptured demo views and does not retry them', async () => {
    api.on('GET', '/management/trends/usage', (request) => (
      request.query.has('model') ? json({ error: 'not captured', code: 'demo_uncaptured' }, 404) : USAGE
    ));
    api.on('GET', '/management/trends/telemetry', (request) => (
      request.query.has('model') ? json({ error: 'not captured', code: 'demo_uncaptured' }, 404) : TELEMETRY
    ));
    mount('/trends?model=gpt-5');
    const notice = await screen.findByTestId('trends-uncaptured');
    await waitFor(() => expect(screen.getByTestId('trends-quota-used')).toBeTruthy());
    // The panels that read the uncaptured window say so instead of loading forever.
    expect(within(await screen.findByTestId('trends-movers')).getByText('The demo does not hold this view')).toBeTruthy();
    expect(within(screen.getByTestId('trends-stability')).getByText('The demo does not hold this view')).toBeTruthy();
    expect(api.requests.filter((request) => request.path === '/management/trends/usage')).toHaveLength(1);

    fireEvent.click(within(notice).getByRole('button', { name: 'Reset range and filters' }));
    await waitFor(() => expect(new URLSearchParams(lastSearch).has('model')).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('trends-uncaptured')).toBeNull());
    expect(await screen.findByTestId('trends-movers-risers')).toBeTruthy();
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

    const { client } = mount();
    await waitFor(() => {
      for (const key of ['trends-usage', 'trends-telemetry', 'trends-quota'] as const) {
        const queries = client.getQueryCache().findAll({ queryKey: [key] });
        expect(queries.length).toBeGreaterThan(0);
        for (const q of queries) {
          expect(q.state.status).toBe('error');
          expect(q.state.fetchStatus).toBe('idle');
        }
      }
    });
    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    shouldFail = false;
    fireEvent.click(retryBtn);
    await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('60.0%'));
    await waitFor(() => expect(screen.getByTestId('trends-tile-movers').textContent).toContain('4.5K'));
    await waitFor(() => expect(screen.getByTestId('trends-tile-delivery').textContent).toContain('90.0%'));
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

    const heldUsage = api.hold('GET', '/management/trends/usage');
    const heldTelemetry = api.hold('GET', '/management/trends/telemetry');
    fireEvent.click(screen.getAllByRole('button', { name: /Last 7 days/ })[0]!);
    fireEvent.click(await screen.findByText('Last 24 hours'));

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

  it('steps stability lane buckets with arrow keys and exposes bucket time and count to assistive tech', async () => {
    mount();
    const lane = await screen.findByTestId('trends-lane-rate_limited_429', {}, { timeout: 5000 });
    const cells = within(lane).getAllByRole('img');
    expect(cells).toHaveLength(3);
    expect(cells[0]!.tabIndex).toBe(0);
    expect(cells[1]!.tabIndex).toBe(-1);
    expect(cells[1]!.getAttribute('aria-label')).toContain('01-01 01:00');
    expect(cells[1]!.getAttribute('aria-label')).toContain('1');

    cells[0]!.focus();
    fireEvent.keyDown(cells[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[1]);
    expect(cells[1]!.tabIndex).toBe(0);
    expect(cells[0]!.tabIndex).toBe(-1);
  });

  it('keeps the selected quota burn point by timestamp across forecast milestone shifts and forwards tooltip notes', () => {
    const winBefore = quotaWindow('5h', {
      projected_exhaust_at_ms: 2.5 * HOUR,
      buckets: [
        { start_ms: 0, end_ms: HOUR, used_percent: 25, delta_percent: 25, requests: 10, net_tokens: 3000, total_tokens: 4000, is_forecast: false },
        { start_ms: HOUR, end_ms: 2 * HOUR, used_percent: 60, delta_percent: 35, requests: 20, net_tokens: 6000, total_tokens: 8000, is_forecast: false },
        { start_ms: 2 * HOUR, end_ms: 3 * HOUR, used_percent: 115, delta_percent: 55, requests: 0, net_tokens: 0, total_tokens: 0, is_forecast: true },
        { start_ms: 3 * HOUR, end_ms: 5 * HOUR, used_percent: 140, delta_percent: 25, requests: 0, net_tokens: 0, total_tokens: 0, is_forecast: true },
      ],
    });
    const winAfter = quotaWindow('5h', {
      projected_exhaust_at_ms: 3.5 * HOUR,
      buckets: winBefore.buckets,
    });
    let setWin!: (next: TrendsQuotaWindow) => void;
    const Host = () => {
      const [win, setState] = React.useState(winBefore);
      setWin = setState;
      return (
        <ThemeProvider>
          <QuotaBurnChart
            drawingKey="c1:5h"
            points={buildQuotaBurnSeries(win)}
            cycleStart={0}
            cycleReset={5 * HOUR}
            divider={2 * HOUR}
            nowMs={NOW}
            projectedExhaustAtMs={win.projected_exhaust_at_ms}
            projectedEndPercent={140}
            label="Quota trend"
            viewStart={0}
            viewEnd={5 * HOUR}
            minSpan={HOUR}
            onLensChange={() => undefined}
          />
        </ThemeProvider>
      );
    };
    renderWithOmc(<Host />);
    const chart = screen.getByTestId('trends-quota-chart');
    const readout = screen.getByTestId('trends-quota-readout');
    // Points: [0, 1h, 2h, 2.5h (milestone), 3h (115%), 5h (140%)]. ArrowRight 5 times lands on 3h (115%).
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(within(readout).getByText('115%')).toBeTruthy();

    // Moving the milestone past 3h changes array indices, yet the 3h point keeps its reading.
    act(() => setWin(winAfter));
    expect(readout.hidden).toBe(false);
    expect(within(readout).getByText('115%')).toBeTruthy();

    // Moving a selected milestone point away clears the stale reading rather than selecting a neighbor.
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(within(readout).getByText('100%')).toBeTruthy();
    act(() => setWin(winBefore));
    expect(readout.hidden).toBe(true);

    // ChartTooltipContent forwards custom notes (such as quota cycle approximation hints) to TooltipReadout.
    renderWithOmc(
      <ThemeProvider>
        <ChartContainer config={{}}>
          <ChartTooltipContent
            active
            payload={[{ payload: {} }]}
            buildRows={() => ({
              heading: '01-01 00:00 – 01-01 05:00',
              rows: [{ key: 'used', name: 'Used', value: '50.0%' }],
              notes: ['Approximated from rolled-up 15-minute usage facts'],
            })}
          />
        </ChartContainer>
      </ThemeProvider>,
    );
    expect(screen.getByText('Approximated from rolled-up 15-minute usage facts')).toBeTruthy();
  });

  it('rejects stale placeholder filter options on range changes and bounds quota drill on advancing clock', async () => {
    api.on('GET', '/management/trends/usage', (request) => {
      const groupBy = request.query.get('group_by') ?? 'model';
      if (groupBy === 'provider') {
        return { ...USAGE, group_by: 'provider', groups: [{ id: 'codex', label: 'codex', requests: 15 }] };
      }
      return { ...USAGE, group_by: groupBy };
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const mountNow = Date.now();
      mount();
      await waitFor(() => expect(screen.getByTestId('trends-quota-used').textContent).toBe('60.0%'));

      // Switch range to 24h while the 24h usage reads stay pending; opening provider filter must wait
      // rather than exposing stale 7d placeholder options.
      const heldUsage24h = api.hold('GET', '/management/trends/usage');
      const heldProviderOptions24h = api.hold('GET', '/management/trends/usage');
      fireEvent.click(screen.getAllByRole('button', { name: /Last 7 days/ })[0]!);
      fireEvent.click(await screen.findByText('Last 24 hours'));
      await heldUsage24h.arrived;

      fireEvent.click(screen.getByTestId('trends-filter-add'));
      fireEvent.click(await screen.findByRole('button', { name: 'Provider' }));
      await heldProviderOptions24h.arrived;
      expect(within(screen.getByTestId('trends-filter-values')).queryByText('Codex')).toBeNull();

      heldUsage24h.release({ ...USAGE, window: { ...WINDOW, preset: '24h' } });
      heldProviderOptions24h.release({ ...USAGE, window: { ...WINDOW, preset: '24h' }, group_by: 'provider', groups: [{ id: 'anthropic', label: 'anthropic', requests: 3 }] });
      expect(await within(await screen.findByTestId('trends-filter-values')).findByText('anthropic')).toBeTruthy();
      expect(within(screen.getByTestId('trends-filter-values')).queryByText('Codex')).toBeNull();

      // Advance the clock past the 5h quota reset without another quota poll; clicking the quota
      // drill must bound `to = 5 * HOUR` at navigation time instead of leaving the drill open.
      await act(async () => {
        vi.setSystemTime(mountNow + 3 * HOUR + 60_000);
        vi.advanceTimersByTime(15_000);
      });
      await waitFor(() => expect(screen.getByTestId('trends-quota-stale-notice')).toBeTruthy());
      fireEvent.click(screen.getByTestId('trends-quota-events'));
      await waitFor(() => expect(lastPath).toBe('/usage/events'));
      expect(new URLSearchParams(lastSearch).get('to')).toBe(String(5 * HOUR));
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for unfiltered demo options when usage is filtered and sizes aggregated stability cells proportionally', async () => {
    const win = window as unknown as { __OMCPA_CONFIG__?: { demo?: boolean } };
    const previousConfig = win.__OMCPA_CONFIG__;
    const observeSpy = vi.spyOn(sharedResizeObserverHub, 'observe').mockImplementation((_el, callback) => {
      callback({ width: 8, height: 20 });
      return () => {};
    });
    win.__OMCPA_CONFIG__ = { ...previousConfig, demo: true };
    try {
      const buckets10h = Array.from({ length: 10 }, (_, index) =>
        telemetryBucket(index * HOUR, { rate_limited_429: index === 9 ? 4 : 1 }),
      );
      api.on('GET', '/management/trends/telemetry', () => ({
        ...TELEMETRY,
        window: { ...WINDOW, to: 10 * HOUR - 1 },
        buckets: buckets10h,
      }));
      api.on('GET', '/management/trends/usage', (request) => {
        if (request.query.get('group_by') === 'provider' && request.query.getAll('provider').includes('codex')) {
          return { ...USAGE, group_by: 'provider', groups: [{ id: 'codex', label: 'codex', requests: 10 }] };
        }
        return USAGE;
      });

      mount('/trends?group=provider&provider=codex');
      const lane = await screen.findByTestId('trends-lane-rate_limited_429', {}, { timeout: 5000 });
      const cells = within(lane).getAllByRole('img');
      expect(cells).toHaveLength(3);
      const track = lane.querySelector('[role="group"]') as HTMLElement;
      expect(track.style.gridTemplateColumns).toBe(`${3 * HOUR}fr ${3 * HOUR}fr ${4 * HOUR}fr`);
      const stability = screen.getByTestId('trends-stability');
      expect(within(stability).getByText('01-01 00:00')).toBeTruthy();
      expect(within(stability).getByText('01-01 05:00')).toBeTruthy();
      expect(within(stability).getByText('01-01 10:00')).toBeTruthy();

      // In demo mode with ?group=provider&provider=codex, opening Provider filter waits for the
      // unfiltered options read rather than reusing the filtered usage response.
      const heldDemoOptions = api.hold('GET', '/management/trends/usage');
      fireEvent.click(screen.getByTestId('trends-filter-add'));
      fireEvent.click(await screen.findByRole('button', { name: /^Provider/ }));
      const optionsRequest = await heldDemoOptions.arrived;
      expect(optionsRequest.query.getAll('provider')).toEqual([]);
      expect(within(screen.getByTestId('trends-filter-values')).queryByText('Codex')).toBeNull();

      heldDemoOptions.release({
        ...USAGE,
        group_by: 'provider',
        groups: [
          { id: 'codex', label: 'codex', requests: 10 },
          { id: 'anthropic', label: 'anthropic', requests: 5 },
        ],
      });
      expect(await within(await screen.findByTestId('trends-filter-values')).findByText('anthropic')).toBeTruthy();
      expect(within(screen.getByTestId('trends-filter-values')).getByText('Codex')).toBeTruthy();
    } finally {
      win.__OMCPA_CONFIG__ = previousConfig;
      observeSpy.mockRestore();
    }
  });
});
