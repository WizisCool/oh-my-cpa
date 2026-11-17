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
import { buildModelTrendSeries, buildModelTrendTooltipRows } from './modelTrendData';
import { seriesColorRange, seriesDomainKey } from './chartTheme';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import type { DashboardModelUsage } from '../types/dashboardModels';
import { RADIUS } from '../theme/radius';
import { useChartMorph } from './useChartMorph';
import { MOTION_ROLL } from '../theme/themeConfig';
import { isMotionReduced } from '../utils/motionPreference';

interface TrendRow {
  t: string;
  total: number;
  [series: string]: string | number;
}

export interface ModelTokenTrendProps {
  groups: DashboardModelUsage[];
  focusedKey?: string | null;
  /** Names a group in the tooltip and the accessible label, the way the card's legend names it. */
  labelOf: (entry: { folded: boolean; model: string }) => string;
  /** The tooltip's last row: the whole bar, every model together. */
  totalLabel: string;
  tokenUnitLabel?: string;
  height?: number;
  onFocusGroup?: (key: string) => void;
  onClearFocus?: () => void;
}

/**
 * Whether two rankings lie on one bucket grid, so each bar can travel to its new split in place:
 * as many buckets, starting within half a bucket of each other. Two reads of one sliding window
 * taken moments apart are the same grid even when their instants differ by those moments.
 */
function isSameGrid(next: DashboardModelUsage[], current: DashboardModelUsage[]): boolean {
  const a = next[0]?.series ?? [];
  const b = current[0]?.series ?? [];
  if (a.length !== b.length || a.length === 0) return false;
  const bucket = a.length > 1 ? a[1]!.t - a[0]!.t : Infinity;
  return Math.abs(a[0]!.t - b[0]!.t) < bucket / 2;
}

/**
 * The plot takes its groups through `useChartMorph`. A ranking on the same grid - a regrouping, a
 * poll - lands at once and the stack layer slides each bar to its new split; a new grid is one
 * render inside a cross-fade. The arrival itself re-renders only this shell, not the plot with the
 * old data.
 */
export const ModelTokenTrend = React.memo<ModelTokenTrendProps>(({ groups, ...rest }) => {
  const { shown, scopeRef } = useChartMorph(groups, Object.is, isSameGrid);
  return (
    <div ref={scopeRef} className="model-trend omc-chart-morph">
      <TrendPlot groups={shown} {...rest} />
    </div>
  );
});

const TrendPlot = React.memo<ModelTokenTrendProps>(({
  groups,
  focusedKey = null,
  labelOf: groupLabelOf,
  totalLabel,
  tokenUnitLabel = '',
  height,
  onFocusGroup,
  onClearFocus,
}) => {
  useTimeZone();
  const { theme } = useTheme();
  const { style: tokenStyle } = useTokenDisplayStyle();

  const { categories, series } = React.useMemo(() => buildModelTrendSeries(groups), [groups]);
  const domain = React.useMemo(() => groups.map(seriesDomainKey), [groups]);
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);

  const labelOf = React.useCallback(
    (key: string) => groupLabelOf({ folded: key === 'folded', model: key.replace(/^model:/, '') }),
    [groupLabelOf],
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
          aria-label={groups.map(groupLabelOf).join(', ')}
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
                    return {
                      heading: dayjs(Number(row.t)).format('MM-DD HH:mm'),
                      rows: buildModelTrendTooltipRows({
                        row,
                        domain,
                        range,
                        labelOf,
                        totalLabel,
                        tokenUnitLabel,
                        tokenStyle,
                      }),
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

/** Caps bar width on sparse windows (e.g. 1-4 buckets right after midnight) so one bucket never fills the card. */
const MAX_BAR_WIDTH = 28;

/**
 * The rank slots the stack always draws: the endpoint's top five and the folded remainder. Fewer
 * groups leave the upper slots empty rather than removing them, so every drawing has the same paths.
 */
const STACK_SLOTS = 6;

/** The radius of a corner drawn square; see the stack layer's note on shape. */
const SQUARE_CORNER = 0.01;

/**
 * StackLayer draws the stacked segments: one path per rank holding all of its segments, rather
 * than one component per segment. A grouping of five models over a day is a hundred and fifty
 * segments; drawn by the chart library each was a component rendered twice per data change, and
 * a new grouping took two dropped frames to land. Six paths are computed and painted at once.
 *
 * Each bucket's top segment takes the bar's cap, whichever rank that is in that bucket.
 *
 * **Every drawing has one shape.** A path belongs to a rank, not to a group, and it always draws
 * one segment per bucket with the same commands: an empty rank, or a rank with nothing in a bucket,
 * draws a zero-height segment where its slot would start, and a segment without the cap draws its
 * corners at a radius too small to see. Two drawings on one grid therefore differ only in their
 * numbers, which is what lets each path be interpolated: a regrouping or a poll slides each bar's
 * split to the new one on the roll - the bars keep their heights where the totals agree - instead of
 * swapping one picture for another. The move is played explicitly, from the drawing on screen (or
 * wherever a running move has got to) to the new one, so it does not depend on when the browser
 * happens to recompute styles. Where `d` cannot be animated the new drawing simply lands.
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
  const layerRef = React.useRef<SVGGElement | null>(null);
  const drawnRef = React.useRef<string[] | null>(null);
  const movesRef = React.useRef(new WeakMap<Element, Animation>());
  const slots = React.useMemo(() => Array.from({ length: Math.max(STACK_SLOTS, order.length) }, (_, rank) => order[rank]), [order]);
  const drawing = React.useMemo(() => {
    const out = slots.map(() => '');
    if (!plot || !xScale || !yScale || data.length === 0) return out;
    const band = plot.width / data.length;
    const width = Math.min(band * (1 - BAR_GAP), MAX_BAR_WIDTH);
    const value = (row: TrendRow, id: string | undefined) => (id === undefined ? 0 : Math.max(0, Number(row[id]) || 0));
    for (const row of data) {
      const start = Number(xScale(row.t));
      if (!Number.isFinite(start)) continue;
      const left = start + (band - width) / 2;
      const right = left + width;
      let cap = -1;
      slots.forEach((id, rank) => {
        if (value(row, id) > 0) cap = rank;
      });
      let base = 0;
      slots.forEach((id, rank) => {
        const bottom = Number(yScale(base));
        base += value(row, id);
        const top = Number(yScale(base));
        if (!Number.isFinite(top) || !Number.isFinite(bottom)) return;
        // A square corner is drawn as an arc too small to see rather than one of zero radius: a
        // browser reduces a zero-radius arc to a line, which would break the shared shape.
        const r = Math.max(SQUARE_CORNER, rank === cap ? Math.min(RADIUS.xs, width / 2, bottom - top) : 0);
        out[rank] += `M${left},${bottom}V${top + r}A${r},${r} 0 0 1 ${left + r},${top}H${right - r}A${r},${r} 0 0 1 ${right},${top + r}V${bottom}Z`;
      });
    }
    return out;
  }, [data, slots, plot, xScale, yScale]);
  // A new data set renders once before the chart has rebuilt its scales, which would draw nothing;
  // the layer keeps its last drawing through that render, so the bars never blink out and the move
  // runs from the old drawing to the new one rather than from an empty one.
  const isDrawn = drawing.some(Boolean);
  const [lastDrawing, setLastDrawing] = React.useState(drawing);
  if (isDrawn && drawing !== lastDrawing) setLastDrawing(drawing);
  const paths = isDrawn ? drawing : lastDrawing;

  React.useLayoutEffect(() => {
    const previous = drawnRef.current;
    drawnRef.current = paths;
    if (!previous || isMotionReduced()) return;
    layerRef.current?.querySelectorAll('path').forEach((element, rank) => {
      const from = previous[rank];
      const to = paths[rank];
      if (!from || !to || from === to || !hasSameShape(from, to) || typeof element.animate !== 'function') return;
      const isMoving = movesRef.current.get(element)?.playState === 'running';
      const start = isMoving ? getComputedStyle(element).getPropertyValue('d') : `path("${from}")`;
      movesRef.current.get(element)?.cancel();
      movesRef.current.set(element, element.animate([{ d: start }, { d: `path("${to}")` }], { duration: MOTION_ROLL.duration, easing: MOTION_ROLL.easing }));
    });
  }, [paths]);

  return (
    <g ref={layerRef} className="omc-stack">
      {slots.map((id, rank) => (
        <path
          key={rank}
          d={paths[rank] || undefined}
          fill={id === undefined ? 'transparent' : colorOf(id)}
          fillOpacity={id !== undefined && focusedKey !== null && focusedKey !== id ? 0.28 : 1}
          className="omc-stack-series cursor-pointer"
          onClick={id === undefined ? undefined : () => onPick(id)}
        />
      ))}
    </g>
  );
}

/** Whether two drawings share their commands, which is what lets one be interpolated into the other. */
function hasSameShape(from: string, to: string): boolean {
  return from.replace(/[^A-Za-z]/g, '') === to.replace(/[^A-Za-z]/g, '');
}
