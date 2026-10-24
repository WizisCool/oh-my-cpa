import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { InsightsPage } from '../src/pages/insights/InsightsPage';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { echarts, type ECharts } from '../src/charts/echarts/core';
import type { EChartProps } from '../src/charts/echarts/EChart';
import type { InsightsCubeResponse } from '../src/types/insights';

/**
 * The Insights page against the typed client: one cube read per window, and every narrowing,
 * regrouping and metric switch answered from that snapshot and written to the URL.
 *
 * ECharts' SVG SSR renderer exercises the real trend options without jsdom layout or canvas.
 * Browser probes own geometry and pointer interaction; these tests own option application.
 */
vi.mock('../src/charts/echarts/EChart', () => ({
  EChart: ({ option, label, testId, handlers }: EChartProps) => {
    if (testId === 'insights-trend-chart') {
      trendOption = option;
      trendHandlers = handlers;
    }
    const chart = React.useRef<ECharts | null>(null);
    const [svg, setSvg] = React.useState('');
    React.useEffect(() => {
      const instance = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 800, height: 280 });
      chart.current = instance;
      return () => { instance.dispose(); chart.current = null; };
    }, []);
    React.useEffect(() => {
      const instance = chart.current;
      if (!instance) return;
      instance.setOption({ ...option, animation: false }, { replaceMerge: ['series', 'xAxis', 'yAxis', 'grid'] });
      setSvg(instance.renderToSVGString());
    }, [option]);
    const series = option.series as Array<{ id: string; name: string }>;
    return <>
      <div role="img" aria-label={label} data-testid={testId} dangerouslySetInnerHTML={{ __html: svg }} />
      {testId === 'insights-trend-chart' && <ol data-testid="trend-series">{series.map((item) => <li key={item.id}>{item.name}</li>)}</ol>}
    </>;
  },
}));
vi.mock('../src/pages/insights/charts/InsightsFlowChart', () => ({ default: () => null }));
// The rolling readout animates through custom elements jsdom does not implement; its printed digits
// are the formatter's, which is all a tile's claim is about.
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
  previous_rows: [row(0, 0, 0, 20, 2000).slice(1)],
  coverage: { fact_requests: 45, detail_requests: 0 },
};

let trendOption: EChartProps['option'];
let trendHandlers: EChartProps['handlers'];
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
  // Use ECharts' built-in text metrics when the SSR host has no canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  api = installOmcApi();
  api.on('GET', '/management/insights/cube', () => CUBE);
  api.on('GET', '/management/insights/rhythm', () => ({
    window: CUBE.window,
    cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, requests: index === 9 ? 4 : 0, total_tokens: 0, cost_nanos: 0 })),
  }));
});

describe('insights page', () => {
  it('reads one cube for the stored window and states the window totals against the previous period', async () => {
    api.state.preferences.insights_range = { preset: 'this_week' };
    mount();
    await waitFor(() => expect(within(tile('requests')).getByText('45')).toBeTruthy());
    expect(within(tile('requests')).getByText('125%')).toBeTruthy();
    const cubeReads = api.requests.filter((request) => request.path === '/management/insights/cube');
    expect(cubeReads).toHaveLength(1);
    expect(cubeReads[0].query.get('preset')).toBe('this_week');
  });

  it('narrows to a ranked key, puts the narrowing in the URL, and never reads the cube again', async () => {
    mount();
    const ranking = await screen.findByTestId('insights-ranking-key');
    fireEvent.click(within(ranking).getByText('Design team'));
    await waitFor(() => expect(within(tile('requests')).getByText('40')).toBeTruthy());
    expect(new URLSearchParams(lastSearch).getAll('key')).toEqual(['hmac:a']);
    const chip = screen.getByTestId('insights-filter-bar');
    expect(within(chip).getByText('Design team')).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button', { name: 'Remove filter' }));
    await waitFor(() => expect(within(tile('requests')).getByText('45')).toBeTruthy());
    expect(api.requests.filter((request) => request.path === '/management/insights/cube')).toHaveLength(1);
    // The rhythm cannot be pivoted from day buckets, so a narrowing reads it with the request list's vocabulary.
    expect(api.requests.some((request) => request.path === '/management/insights/rhythm' && request.query.get('api_key') === 'hmac:a')).toBe(true);
  });

  it.each([['', 'tokens'], ['&metric=cost', 'cost'], ['&metric=cache_rate', 'tokens'], ['&metric=success_rate', 'tokens']])('opens metric tiles in reading order and resolves selection %s', async (query, selected) => {
    mount(`/insights?group=key${query}`);
    await screen.findByTestId('trend-series');
    expect(within(screen.getByTestId('trend-series')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Design team', 'sk-…bbbb']);
    expect(within(screen.getByTestId('insights-tiles')).getAllByRole('tab')).toEqual(
      ['tokens', 'cost', 'requests', 'latency'].map(tile),
    );
    expect(screen.queryByTestId('insights-tile-cache_rate')).toBeNull();
    expect(screen.queryByTestId('insights-tile-success_rate')).toBeNull();
    expect(tile(selected).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tile('cost'));
    expect(tile('cost').getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(lastSearch).get('metric')).toBe('cost');
  });

  it('renders latency from the URL and across bar/line metric switches', async () => {
    mount('/insights?metric=latency');
    const chart = await screen.findByTestId('insights-trend-chart');
    for (const nextMetric of ['latency', 'requests', 'latency']) {
      fireEvent.click(tile(nextMetric));
      await waitFor(() => {
        expect(tile(nextMetric).getAttribute('aria-selected')).toBe('true');
        expect(chart.querySelectorAll('svg path').length).toBeGreaterThan(0);
      });
      expect(new URLSearchParams(lastSearch).get('metric')).toBe(nextMetric);
    }
  });

  it.each([
    { metric: 'tokens', all: ['Design team', 'sk-…bbbb'], isolated: ['Design team'], tipAll: ['Design team', 'sk-…bbbb', 'Total'], tipIsolated: ['Design team', 'Total'] },
    { metric: 'latency', all: ['Design team', 'sk-…bbbb', 'Total'], isolated: ['Design team', 'Total'], tipAll: ['Design team', 'sk-…bbbb', 'Total'], tipIsolated: ['Design team', 'Total'] },
  ])('isolates $metric from the legend or a painted series, then clears from the background', async ({ metric, all, isolated, tipAll, tipIsolated }) => {
    mount(`/insights?metric=${metric}&group=key`);
    await screen.findByTestId('insights-trend-chart');
    const series = () => trendOption.series as Array<{ id: string; name: string }>;
    const names = () => series().map((item) => item.name);
    const tipNames = (dataIndex: number) => {
      const formatter = (trendOption.tooltip as { formatter: (items: unknown) => string }).formatter;
      const output = document.createElement('div');
      output.innerHTML = formatter(series().map((item) => ({ seriesId: item.id, dataIndex })));
      return [...output.querySelectorAll('.omc-tip-name')].map((element) => element.textContent);
    };
    const legend = screen.getByTestId('insights-trend-legend');
    const buttons = within(legend).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(names()).toEqual(all);

    fireEvent.click(buttons[0]);
    await waitFor(() => expect(names()).toEqual(isolated));
    expect(within(legend).getAllByRole('button')[0].getAttribute('aria-pressed')).toBe('true');
    expect(tipNames(1)).toEqual(tipIsolated);

    fireEvent.click(within(legend).getAllByRole('button')[0]);
    await waitFor(() => expect(names()).toEqual(all));
    expect(tipNames(1)).toEqual(tipAll);

    const fakeChart = { convertFromPixel: () => [0, 0], dispatchAction: vi.fn() } as unknown as ECharts;
    trendHandlers?.click?.({ seriesId: series()[0].id, seriesIndex: 0 }, fakeChart);
    await waitFor(() => expect(names()).toEqual(isolated));
    trendHandlers?.backgroundClick?.({}, fakeChart);
    await waitFor(() => expect(names()).toEqual(all));
  });

  it.each([
    { metric: 'requests', values: ['70', '60', '50', '40', '30', '20', '10'], total: '280', zero: '0', active: '1' },
    { metric: 'tokens', values: ['7K', '6K', '5K', '4K', '3K', '2K', '1K'], total: '28K', zero: '0', active: '100' },
    { metric: 'cost', values: ['$0.07', '$0.06', '$0.05', '$0.04', '$0.03', '$0.02', '$0.01'], total: '$0.28', zero: '$0.00', active: '$0.0010' },
    { metric: 'latency', values: ['700ms', '600ms', '500ms', '400ms', '300ms', '200ms', '100ms'], total: '500ms', zero: '—', active: '200ms' },
  ])('shows the hovered $metric bucket or segment with its nonzero contributors and aggregate', async ({ metric, values, total, zero, active }) => {
    const models = Array.from({ length: 7 }, (_, index) => `model-${index + 1}`);
    api.on('GET', '/management/insights/cube', () => ({
      ...CUBE,
      window: { ...CUBE.window, to: 3 * 86_400_000 - 1 },
      bucket_starts: [0, 86_400_000, 2 * 86_400_000],
      dims: { ...CUBE.dims, models, call_points: models },
      rows: [...models.map((_, index) => {
        const count = index + 1;
        const cells = row(0, 0, index, count * 10, count * 1000);
        cells[COLUMNS.indexOf('failures')] = index;
        cells[COLUMNS.indexOf('latency_sum_ms')] = count * 10 * count * 100;
        return cells;
      }), row(1, 0, 6, 1, 100)],
    }));
    mount('/insights?metric=cost&group=model');
    await screen.findByTestId('insights-trend-chart');
    fireEvent.click(tile(metric));
    const series = trendOption.series as Array<{
      id: string; name: string; type: string; data: Array<number | null | { value: number; symbol?: string }>;
      markArea?: { data: unknown[] }; triggerEvent?: string; emphasis?: { focus?: string }; showSymbol?: boolean;
      lineStyle?: { width?: number; opacity?: number; type?: string };
    }>;
    const tooltip = trendOption.tooltip as { formatter: (items: unknown) => string };
    const readRows = (dataIndex: number, seriesId?: string) => {
      const output = document.createElement('div');
      output.innerHTML = tooltip.formatter(seriesId === undefined
        ? series.map((item) => ({ seriesId: item.id, dataIndex }))
        : { seriesId, dataIndex });
      return [...output.querySelectorAll('.omc-tip-row')].map((element) => [
        element.querySelector('.omc-tip-name')?.textContent,
        element.querySelector('.omc-tip-value')?.textContent,
      ]);
    };
    const readNotes = (dataIndex: number) => {
      const output = document.createElement('div');
      output.innerHTML = tooltip.formatter(series.map((item) => ({ seriesId: item.id, dataIndex })));
      return [...output.querySelectorAll('.omc-tip-note')].map((element) => element.textContent);
    };
    const names = [...models].reverse();
    const isLine = !['requests', 'tokens', 'cost'].includes(metric);
    const shownNames = isLine ? names.slice(0, 5) : names;
    expect(readRows(0)).toEqual([...shownNames.map((name, index) => [name, values[index]]), ['Total', total]]);
    expect(readRows(1)).toEqual([['model-7', active], ['Total', active]]);
    expect((trendOption.tooltip as { trigger?: string }).trigger).toBe('item');
    expect(readRows(2)).toEqual(isLine ? [[undefined, 'No requests in this bucket']] : [['Total', zero]]);
    if (isLine) {
      expect(readNotes(1).at(-1)).toBe('n=1');
      expect(readRows(0, series[0].id)).toEqual([[names[0], values[0]]]);
      const fakeChart = { convertFromPixel: () => [0, 0], dispatchAction: vi.fn() } as unknown as ECharts;
      trendHandlers?.mouseover?.({ componentSubType: 'line', selfType: 'line', seriesIndex: 0, event: { offsetX: 0, offsetY: 0 } }, fakeChart);
      expect(readRows(0)).toEqual([[names[0], values[0]]]);
      expect(fakeChart.dispatchAction).toHaveBeenCalledWith({ type: 'highlight', seriesIndex: 0 });
      trendHandlers?.mouseout?.({ componentSubType: 'line', selfType: 'line', seriesIndex: 0, event: { offsetX: 0, offsetY: 0 } }, fakeChart);
      expect(fakeChart.dispatchAction).toHaveBeenCalledWith({ type: 'downplay', seriesIndex: 0 });
      expect(readRows(0)).toEqual([...shownNames.map((name, index) => [name, values[index]]), ['Total', total]]);
      expect(series).toHaveLength(6);
      const totalSeries = series.find((item) => item.name === 'Total');
      expect(totalSeries).toMatchObject({ type: 'line', triggerEvent: 'line', emphasis: { focus: 'series' }, showSymbol: false });
      expect(totalSeries?.lineStyle).toMatchObject({ type: 'dashed', width: 1.25 });
      expect(totalSeries?.data).toHaveLength(3);
      expect(totalSeries?.data[2]).toBeNull();
      expect(totalSeries?.markArea?.data).toHaveLength(1);
      expect(series[0]).toMatchObject({ triggerEvent: 'line', emphasis: { focus: 'series' } });
      expect(series.find((item) => item.name === 'model-7')?.data[1]).toMatchObject({ symbol: 'emptyCircle' });
    } else {
      expect(readRows(0, series[0].id)).toEqual([['model-7', values[0]], ['Total', total]]);
    }
  });

  it('keeps the page frame and says what failed when the cube cannot be read', async () => {
    api.on('GET', '/management/insights/cube', () => json({ error: 'hour buckets cover at most 14 days' }, 400));
    mount();
    expect(await screen.findByText('Insights could not be loaded')).toBeTruthy();
    expect(screen.getByText(/hour buckets cover at most 14 days/)).toBeTruthy();
  });
});
