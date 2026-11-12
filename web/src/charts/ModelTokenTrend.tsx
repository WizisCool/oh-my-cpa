import React from 'react';
import { Bar, BarChart, CartesianGrid, usePlotArea, useXAxisScale, useYAxisScale, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import dayjs from '../utils/time';
import { useTimeZone } from '../utils/TimeZoneProvider';
import { useTheme } from '../theme/ThemeContext';
import { ChartSurface } from './ChartSurface';
import { buildModelTrendSeries } from './modelTrendData';
import { seriesColorRange, seriesDomainKey, seriesGroupLabel } from './chartTheme';
import { formatTokensFull } from '../types/tokenDisplay';
import { formatModelShare, type DashboardModelUsage } from '../types/dashboardModels';
import { RADIUS } from '../theme/radius';
import { useChartMorph } from './useChartMorph';

interface TrendRow {
  t: string;
  total: number;
  [series: string]: string | number;
}

export interface ModelTokenTrendProps {
  groups: DashboardModelUsage[];
  focusedKey?: string | null;
  foldedLabel: string;
  unnamedLabel: string;
  /** The tooltip's last row: the whole bar, every model together. */
  totalLabel: string;
  tokenUnitLabel?: string;
  height?: number;
  onFocusGroup?: (key: string) => void;
  onClearFocus?: () => void;
}

/**
 * The plot takes its groups through `useChartMorph`, so a new set is one render of the bars inside
 * a cross-fade; the arrival itself re-renders only this shell, not the plot with the old data.
 */
export const ModelTokenTrend = React.memo<ModelTokenTrendProps>(({ groups, ...rest }) => {
  const { shown, scopeRef } = useChartMorph(groups);
  return (
    <div ref={scopeRef} className="model-trend omc-chart-morph">
      <TrendPlot groups={shown} {...rest} />
    </div>
  );
});

const TrendPlot = React.memo<ModelTokenTrendProps>(({
  groups,
  focusedKey = null,
  foldedLabel,
  unnamedLabel,
  totalLabel,
  tokenUnitLabel = '',
  height,
  onFocusGroup,
  onClearFocus,
}) => {
  useTimeZone();
  const { theme } = useTheme();

  const { categories, series } = React.useMemo(() => buildModelTrendSeries(groups), [groups]);
  const domain = React.useMemo(() => groups.map(seriesDomainKey), [groups]);
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);

  const labelOf = React.useCallback(
    (key: string) =>
      seriesGroupLabel({ folded: key === 'folded', model: key.replace(/^model:/, '') }, foldedLabel, unnamedLabel),
    [foldedLabel, unnamedLabel],
  );

  const labelFormat =
    categories.length > 1 && Number(categories.at(-1)) - Number(categories[0]) > 24 * 60 * 60 * 1000
      ? 'MM-DD'
      : 'HH:mm';

  const tickValues = React.useMemo(() => {
    if (categories.length === 0) return [];
    const count = Math.min(4, categories.length);
    const indices = new Set(
      Array.from({ length: count }, (_, idx) =>
        Math.round((idx * (categories.length - 1)) / Math.max(1, count - 1)),
      ),
    );
    return Array.from(indices).map((i) => categories[i]!);
  }, [categories]);

  // Rank one stacks at the foot of each bar and the fold at its head, the order the legend reads in.
  const stackOrder = React.useMemo(() => [...series].reverse(), [series]);
  const data = React.useMemo(
    () =>
      categories.map((cat, idx) => {
        const row: TrendRow = { t: cat, total: 0 };
        for (const item of stackOrder) {
          const value = item.values[idx] ?? 0;
          row[item.id] = value;
          row.total += value;
        }
        return row;
      }),
    [categories, stackOrder],
  );

  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    groups.forEach((group, idx) => {
      const key = seriesDomainKey(group);
      out[key] = { label: labelOf(key), color: range[idx] };
    });
    return out;
  }, [groups, labelOf, range]);

  const hasFocus = focusedKey !== null;
  const didClickSeriesRef = React.useRef(false);

  return (
    <>
      <ChartSurface height={height ?? '100%'}>
        <ChartContainer
          config={config}
          role="img"
          aria-label={groups.map((group) => seriesGroupLabel(group, foldedLabel, unnamedLabel)).join(', ')}
          className="h-full w-full"
          style={height ? { height } : undefined}
          initialDimension={{ width: 480, height: height ?? 210 }}
          onClick={() => {
            if (didClickSeriesRef.current) {
              didClickSeriesRef.current = false;
              return;
            }
            onClearFocus?.();
          }}
        >
          <BarChart data={data} margin={{ top: 10, right: 4, bottom: 4, left: 4 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="t"
              ticks={tickValues}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value: string) => dayjs(Number(value)).format(labelFormat)}
            />
            <YAxis domain={[0, 'auto']} hide />
            <ChartTooltip
              isPinnedTop
              cursor={{ fill: 'var(--hover-inset)', radius: RADIUS.xs }}
              content={
                <ChartTooltipContent
                  buildRows={(payload) => {
                    const row = payload[0]?.payload as TrendRow | undefined;
                    if (!row) return null;
                    const suffix = tokenUnitLabel ? ` ${tokenUnitLabel}` : '';
                    // Only the models that moved in this bucket, largest first: a column of zeros
                    // buried the one or two rows the reader was hovering for.
                    const moved = domain
                      .map((key, idx) => ({ key, idx, value: Number(row[key] ?? 0) }))
                      .filter((entry) => entry.value > 0)
                      .sort((left, right) => right.value - left.value);
                    return {
                      heading: dayjs(Number(row.t)).format('MM-DD HH:mm'),
                      rows: [
                        ...moved.map(({ key, idx, value }) => ({
                          key,
                          name: labelOf(key),
                          color: range[idx],
                          // A tooltip is where a reader goes for the number itself, so it prints the
                          // exact count; the cards keep the compact form.
                          value: formatTokensFull(value),
                          share: moved.length > 1 ? formatModelShare(value, row.total) : undefined,
                        })),
                        { key: 'total', name: totalLabel, value: `${formatTokensFull(row.total)}${suffix}`, isTotal: true },
                      ],
                    };
                  }}
                />
              }
            />
            {/* The whole bar, drawn by nothing: it gives the axis its domain and the tooltip its bucket,
                while the segments are drawn by `StackLayer` below. */}
            <Bar dataKey="total" fill="none" activeBar={false} isAnimationActive={false} />
            <StackLayer
              data={data}
              order={stackOrder.map((item) => item.id)}
              colorOf={(id) => (config[id] && 'color' in config[id]! ? config[id]!.color : undefined) ?? theme.palette.accent}
              focusedKey={hasFocus ? focusedKey : null}
              onPick={(id) => {
                didClickSeriesRef.current = true;
                onFocusGroup?.(id);
              }}
            />
          </BarChart>
        </ChartContainer>
      </ChartSurface>
    </>
  );
});

/** The share of each bucket's band left empty between bars, as the chart's `barCategoryGap`. */
const BAR_GAP = 0.22;

/**
 * StackLayer draws the stacked segments: one path per model holding all of its segments, rather
 * than one component per segment. A grouping of five models over a day is a hundred and fifty
 * segments; drawn by the chart library each was a component rendered twice per data change, and
 * a new grouping took two dropped frames to land. Five paths are computed and painted at once.
 *
 * Each bucket's top segment takes the bar's cap, whichever model that is in that bucket.
 */
function StackLayer({
  data,
  order,
  colorOf,
  focusedKey,
  onPick,
}: {
  data: readonly TrendRow[];
  order: readonly string[];
  colorOf: (id: string) => string;
  focusedKey: string | null;
  onPick: (id: string) => void;
}) {
  const plot = usePlotArea();
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const paths = React.useMemo(() => {
    const out = new Map<string, string>(order.map((id) => [id, '']));
    if (!plot || !xScale || !yScale || data.length === 0) return out;
    const band = plot.width / data.length;
    const width = band * (1 - BAR_GAP);
    for (const row of data) {
      const start = Number(xScale(row.t));
      if (!Number.isFinite(start)) continue;
      const left = start + (band - width) / 2;
      const right = left + width;
      let cap = '';
      for (const id of order) if (Number(row[id]) > 0) cap = id;
      let base = 0;
      for (const id of order) {
        const value = Number(row[id]) || 0;
        if (value <= 0) continue;
        const bottom = Number(yScale(base));
        const top = Number(yScale(base + value));
        base += value;
        if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom - top <= 0) continue;
        const r = id === cap ? Math.min(RADIUS.xs, width / 2, bottom - top) : 0;
        out.set(
          id,
          out.get(id)! +
            (r > 0
              ? `M${left},${bottom}V${top + r}A${r},${r} 0 0 1 ${left + r},${top}H${right - r}A${r},${r} 0 0 1 ${right},${top + r}V${bottom}Z`
              : `M${left},${bottom}V${top}H${right}V${bottom}Z`),
        );
      }
    }
    return out;
  }, [data, order, plot, xScale, yScale]);

  return (
    <g className="omc-stack">
      {order.map((id) => (
        <path
          key={id}
          d={paths.get(id) || undefined}
          fill={colorOf(id)}
          fillOpacity={focusedKey !== null && focusedKey !== id ? 0.28 : 1}
          className="omc-stack-series cursor-pointer"
          onClick={() => onPick(id)}
        />
      ))}
    </g>
  );
}
