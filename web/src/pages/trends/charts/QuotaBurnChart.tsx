import React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ReferenceDot,
  XAxis,
  YAxis,
  usePlotArea,
} from 'recharts';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { TooltipReadout } from '../../../components/common/Tooltip';
import { useMorphedProps } from '../../../charts/useChartMorph';
import { clampSparklineTooltipX } from '../../../charts/monotoneSparkline';
import { sharedResizeObserverHub } from '../../../performance/resizeObserverHub';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatTokens } from '../../../types/tokenDisplay';
import {
  QUOTA_AXIS_MAX,
  formatPercent,
  nearestPointIndex,
  stepPointIndex,
  type QuotaBurnPoint,
} from '../trendsLogic';
import styles from '../trends.module.css';

export interface QuotaBurnChartProps {
  /** Identifies the drawing, so another credential or window is a new picture rather than the same line moving. */
  drawingKey: string;
  points: readonly QuotaBurnPoint[];
  cycleStart: number;
  cycleReset: number;
  /** Where measurement ends and the projection begins. */
  divider: number;
  /** Wall-clock instant (`as_of_ms`) drawn by the "Now" marker when inside the cycle. */
  nowMs?: number;
  projectedExhaustAtMs?: number;
  projectedEndPercent?: number;
  isPhysicalUnavailable?: boolean;
  label: string;
  height?: number;
}

/** How far the readout stands off the hovered bucket's x position. */
const READOUT_OFFSET = 18;
/** Pixel radius around the projected-exhaustion marker that snaps straight onto the milestone. */
const MILESTONE_SNAP_PX = 10;
/** The readout's size before it has been measured once. */
const READOUT_FALLBACK = { width: 220, height: 136 };

type PlotBox = { x: number; y: number; width: number; height: number };

type OverlayRefs = {
  crosshair: SVGLineElement | null;
  halo: SVGCircleElement | null;
  dot: SVGCircleElement | null;
};

/** Reads the plot box the chart laid out, so pointer and active-point positions map directly. */
function PlotProbe({
  boxRef,
  onPlotChange,
}: {
  boxRef: React.MutableRefObject<PlotBox | null>;
  onPlotChange: (box: PlotBox | null) => void;
}) {
  const plot = usePlotArea();
  const next = plot ? { x: plot.x, y: plot.y, width: plot.width, height: plot.height } : null;
  React.useLayoutEffect(() => {
    const prev = boxRef.current;
    if (
      prev?.x === next?.x &&
      prev?.y === next?.y &&
      prev?.width === next?.width &&
      prev?.height === next?.height
    ) {
      return;
    }
    boxRef.current = next;
    onPlotChange(next);
  });
  return null;
}

/**
 * Lightweight SVG overlay elements inside `<ComposedChart>`. Positions update through DOM refs so
 * hovering never re-renders the chart SVG, hatch pattern, or axes.
 */
function QuotaChartOverlay({ overlayRef, strokeBg }: { overlayRef: React.MutableRefObject<OverlayRefs>; strokeBg: string }) {
  return (
    <g aria-hidden="true">
      <line
        ref={(node) => { overlayRef.current.crosshair = node; }}
        strokeWidth={1}
        strokeOpacity={0.55}
        display="none"
      />
      <circle
        ref={(node) => { overlayRef.current.halo = node; }}
        r={9}
        fillOpacity={0.2}
        stroke="none"
        display="none"
      />
      <circle
        ref={(node) => { overlayRef.current.dot = node; }}
        r={4.5}
        stroke={strokeBg}
        strokeWidth={2}
        display="none"
      />
    </g>
  );
}

const Y_TICKS = [0, 50, 100, 150];

function clampAxis(value: number | null): number | null {
  return value === null ? null : Math.min(QUOTA_AXIS_MAX, Math.max(0, value));
}

type BurnRow = QuotaBurnPoint & { actualShown: number | null; forecastShown: number | null };

interface QuotaBurnPlotProps {
  id: string;
  data: readonly BurnRow[];
  cycleStart: number;
  cycleReset: number;
  isSameDay: boolean;
  tickFormat: string;
  hasForecast: boolean;
  divider: number;
  nowMs?: number;
  projectedExhaustAtMs?: number;
  lastForecast: BurnRow | null;
  projectedEndPercent?: number;
  plotRef: React.MutableRefObject<PlotBox | null>;
  overlayRef: React.MutableRefObject<OverlayRefs>;
  onPlotChange: (box: PlotBox | null) => void;
}

const QuotaBurnPlot = React.memo<QuotaBurnPlotProps>(({
  id,
  data,
  cycleStart,
  cycleReset,
  isSameDay,
  tickFormat,
  hasForecast,
  divider,
  nowMs,
  projectedExhaustAtMs,
  lastForecast,
  projectedEndPercent,
  plotRef,
  overlayRef,
  onPlotChange,
}) => {
  const t = useT();
  const { theme } = useTheme();
  const span = Math.max(1, cycleReset - cycleStart);
  const nowMarker = nowMs ?? divider;
  const showExhaustMilestone = Boolean(
    hasForecast &&
    lastForecast !== null &&
    projectedExhaustAtMs !== undefined &&
    projectedExhaustAtMs > divider &&
    projectedExhaustAtMs < lastForecast.t &&
    projectedExhaustAtMs >= cycleStart &&
    projectedExhaustAtMs <= cycleReset,
  );
  const showEndDot = Boolean(
    lastForecast &&
    projectedEndPercent !== undefined &&
    lastForecast.t >= cycleStart &&
    lastForecast.t <= cycleReset,
  );

  return (
    <ComposedChart data={data as BurnRow[]} margin={{ top: 16, right: 48, bottom: 4, left: 4 }}>
      <defs>
        <linearGradient id={`${id}-measured`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.palette.success} stopOpacity={0.28} />
          <stop offset="100%" stopColor={theme.palette.success} stopOpacity={0.02} />
        </linearGradient>
        <pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={theme.palette.warn} fillOpacity={0.06} />
          <line x1="0" y1="0" x2="0" y2="6" stroke={theme.palette.warn} strokeWidth={1.4} strokeOpacity={0.42} />
        </pattern>
      </defs>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="t"
        type="number"
        scale="time"
        domain={[cycleStart, cycleReset]}
        allowDataOverflow
        tickLine={false}
        axisLine={false}
        tickMargin={6}
        minTickGap={32}
        tickFormatter={(value: number) => dayjs(value).format(isSameDay ? 'HH:mm' : tickFormat)}
      />
      <YAxis
        domain={[0, QUOTA_AXIS_MAX]}
        ticks={Y_TICKS}
        allowDataOverflow
        width={44}
        tickLine={false}
        axisLine={false}
        tickFormatter={(value: number) => `${value}%`}
      />
      <ReferenceLine
        y={100}
        stroke={theme.palette.danger}
        strokeOpacity={0.7}
        strokeDasharray="5 4"
        label={{ value: t('trends.quota.limit_line'), position: 'right', fill: theme.palette.danger, fontSize: 11 }}
      />
      <Area
        dataKey="actualShown"
        type="monotone"
        stroke="none"
        fill={`url(#${id}-measured)`}
        connectNulls={false}
        isAnimationActive={false}
      />
      {hasForecast && (
        <Area
          dataKey="forecastShown"
          type="monotone"
          stroke="none"
          fill={`url(#${id}-hatch)`}
          connectNulls={false}
          isAnimationActive={false}
        />
      )}
      <Line
        dataKey="actualShown"
        type="monotone"
        stroke={theme.palette.success}
        strokeWidth={2}
        dot={false}
        activeDot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
      {hasForecast && (
        <Line
          dataKey="forecastShown"
          type="monotone"
          stroke={theme.palette.warn}
          strokeWidth={1.75}
          strokeDasharray="5 3"
          dot={false}
          activeDot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      )}
      {nowMarker > cycleStart && nowMarker < cycleReset && (
        <ReferenceLine
          x={nowMarker}
          stroke={theme.palette.muted}
          strokeDasharray="2 3"
          label={{ value: t('trends.quota.now_line'), position: 'insideTopRight', fill: theme.palette.fg2, fontSize: 11 }}
        />
      )}
      {showExhaustMilestone && projectedExhaustAtMs !== undefined && (
        <ReferenceLine
          segment={[{ x: projectedExhaustAtMs, y: 0 }, { x: projectedExhaustAtMs, y: 100 }]}
          stroke={theme.palette.warn}
          strokeOpacity={0.5}
          strokeDasharray="2 3"
          ifOverflow="discard"
        />
      )}
      {showExhaustMilestone && projectedExhaustAtMs !== undefined && (
        <ReferenceDot
          x={projectedExhaustAtMs}
          y={100}
          r={4}
          fill={theme.palette.warn}
          stroke={theme.palette.bg}
          strokeWidth={2}
          label={({ viewBox }: { viewBox?: { x?: number; y?: number } }) => {
            const vx = viewBox?.x;
            const vy = viewBox?.y;
            if (vx === undefined || vy === undefined) return null;
            const ratio = (projectedExhaustAtMs - cycleStart) / span;
            const anchor = ratio >= 0.85 ? 'end' : ratio <= 0.12 ? 'start' : 'middle';
            const dx = anchor === 'end' ? -6 : anchor === 'start' ? 6 : 0;
            const timeLabel = dayjs(projectedExhaustAtMs).format(isSameDay ? 'HH:mm' : 'MM-DD HH:mm');
            return (
              <text
                x={vx + dx}
                y={vy - 10}
                textAnchor={anchor}
                fill={theme.palette.warn}
                fontSize={11}
                fontWeight={600}
              >
                {t('trends.quota.exhaust_marker', { at: timeLabel })}
              </text>
            );
          }}
        />
      )}
      {showEndDot && lastForecast && projectedEndPercent !== undefined && (
        <ReferenceDot
          x={lastForecast.t}
          y={lastForecast.forecastShown ?? 0}
          r={3}
          fill={theme.palette.warn}
          stroke="none"
          label={({ viewBox }: { viewBox?: { x?: number; y?: number } }) => {
            const vx = viewBox?.x;
            const vy = viewBox?.y;
            if (vx === undefined || vy === undefined) return null;
            const yShown = lastForecast.forecastShown ?? 0;
            // Keep the end percentage clear of the horizontal 100% line and the "Limit" margin label.
            const dy = yShown >= 100 ? -10 : yShown >= 90 ? 15 : 4;
            return (
              <text
                x={vx + 6}
                y={vy + dy}
                textAnchor="start"
                fill={theme.palette.warn}
                fontSize={11}
                fontWeight={600}
              >
                {formatPercent(projectedEndPercent, 0)}
              </text>
            );
          }}
        />
      )}
      <QuotaChartOverlay overlayRef={overlayRef} strokeBg={theme.palette.bg} />
      <PlotProbe boxRef={plotRef} onPlotChange={onPlotChange} />
    </ComposedChart>
  );
});
QuotaBurnPlot.displayName = 'QuotaBurnPlot';

const QuotaBurnChartView: React.FC<QuotaBurnChartProps> = ({
  points,
  cycleStart,
  cycleReset,
  divider,
  nowMs,
  projectedExhaustAtMs,
  projectedEndPercent,
  isPhysicalUnavailable = false,
  label,
  height = 260,
}) => {
  useTimeZone();
  const t = useT();
  const { theme } = useTheme();
  const { style } = useTokenDisplayStyle();
  const id = React.useId().replace(/:/g, '');
  const plotRef = React.useRef<PlotBox | null>(null);
  const [plotBox, setPlotBox] = React.useState<PlotBox | null>(null);
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const hostWidthRef = React.useRef<number>(760);
  const readoutRef = React.useRef<HTMLDivElement | null>(null);
  const [readoutSize, setReadoutSize] = React.useState(READOUT_FALLBACK);
  const [activeState, setActiveState] = React.useState<{ t: number; isExhaustMilestone: boolean; follow: 'pointer' | 'key' } | null>(null);
  const [isReadoutAnimated, setIsReadoutAnimated] = React.useState(false);
  const isTouchReadingRef = React.useRef(false);

  const overlayRef = React.useRef<OverlayRefs>({ crosshair: null, halo: null, dot: null });

  const span = Math.max(1, cycleReset - cycleStart);
  const isSameDay = dayjs(cycleStart).isSame(dayjs(cycleReset), 'day');
  const tickFormat = span <= 2 * 86_400_000 ? 'HH:mm' : 'MM-DD';

  const data = React.useMemo<BurnRow[]>(
    () => points.map((point) => ({ ...point, actualShown: clampAxis(point.actual), forecastShown: clampAxis(point.forecast) })),
    [points],
  );
  const lastForecast = React.useMemo(() => {
    for (let index = data.length - 1; index >= 0; index -= 1) {
      if (data[index]!.forecastShown !== null && data[index]!.isForecast) return data[index]!;
    }
    return null;
  }, [data]);
  const hasForecast = lastForecast !== null;

  const config = React.useMemo<ChartConfig>(() => ({
    actualShown: { label: t('trends.quota.measured'), color: theme.palette.success },
    forecastShown: { label: t('trends.quota.forecast'), color: theme.palette.warn },
  }), [t, theme.palette.success, theme.palette.warn]);

  // The points inside the cycle: the crosshair and the arrow keys only ever land on what is drawn.
  const visible = React.useMemo(
    () => data.flatMap((point, index) => (point.t >= cycleStart && point.t <= cycleReset ? [index] : [])),
    [cycleReset, cycleStart, data],
  );
  const visiblePoints = React.useMemo(() => visible.map((index) => data[index]!), [data, visible]);
  const milestoneVisibleIndex = React.useMemo(
    () => visiblePoints.findIndex((point) => point.isExhaustMilestone),
    [visiblePoints],
  );

  const activePoint = React.useMemo(() => {
    if (!activeState) return null;
    return data.find((point) => (
      point.t === activeState.t && Boolean(point.isExhaustMilestone) === activeState.isExhaustMilestone
    )) ?? null;
  }, [activeState, data]);

  React.useEffect(() => {
    if (activeState && !activePoint) {
      isTouchReadingRef.current = false;
      setActiveState(null);
    }
  }, [activePoint, activeState]);

  const active = activePoint && activePoint.t >= cycleStart && activePoint.t <= cycleReset ? activePoint : null;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    return sharedResizeObserverHub.observe(host, ({ width }) => {
      if (width > 0) hostWidthRef.current = Math.round(width);
    }, { epsilonPx: 1 });
  }, []);

  React.useEffect(() => {
    const node = readoutRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width <= 0 || box.height <= 0) return;
      const w = Math.round(box.width);
      const h = Math.round(box.height);
      setReadoutSize((curr) => (curr.width === w && curr.height === h ? curr : { width: w, height: h }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Enable compositor transform glide only after the readout has opened at its initial coordinates.
  React.useEffect(() => {
    if (!active) {
      setIsReadoutAnimated(false);
      return undefined;
    }
    if (isReadoutAnimated) return undefined;
    const frame = window.requestAnimationFrame(() => setIsReadoutAnimated(true));
    return () => window.cancelAnimationFrame(frame);
  }, [active, isReadoutAnimated]);

  // Keep SVG crosshair, halo, and active dot synchronized via direct DOM attributes (0 chart re-renders).
  React.useLayoutEffect(() => {
    const { crosshair, halo, dot } = overlayRef.current;
    const plot = plotRef.current;
    if (!crosshair || !halo || !dot) return;
    if (!active || !plot || plot.width <= 0 || plot.height <= 0) {
      crosshair.setAttribute('display', 'none');
      halo.setAttribute('display', 'none');
      dot.setAttribute('display', 'none');
      return;
    }
    const cx = plot.x + ((active.t - cycleStart) / span) * plot.width;
    const cy = plot.y + (1 - (clampAxis(active.used) ?? 0) / QUOTA_AXIS_MAX) * plot.height;
    const color = active.isForecast ? theme.palette.warn : theme.palette.success;

    crosshair.setAttribute('x1', String(cx));
    crosshair.setAttribute('x2', String(cx));
    crosshair.setAttribute('y1', String(plot.y));
    crosshair.setAttribute('y2', String(plot.y + plot.height));
    crosshair.setAttribute('stroke', theme.palette.fg2);
    crosshair.removeAttribute('display');

    halo.setAttribute('cx', String(cx));
    halo.setAttribute('cy', String(cy));
    halo.setAttribute('fill', color);
    halo.removeAttribute('display');

    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('fill', color);
    dot.removeAttribute('display');
  }, [active, cycleStart, plotBox, span, theme.palette.fg2, theme.palette.success, theme.palette.warn]);

  const instantAt = (clientX: number): number | null => {
    const plot = plotRef.current;
    const host = hostRef.current;
    if (!plot || !host || plot.width <= 0) return null;
    const x = clientX - host.getBoundingClientRect().left;
    return cycleStart + ((x - plot.x) / plot.width) * span;
  };

  const snapPointForInstant = (instant: number): number => {
    if (milestoneVisibleIndex >= 0 && plotRef.current && plotRef.current.width > 0) {
      const milestone = visiblePoints[milestoneVisibleIndex]!;
      const pxDistance = (Math.abs(instant - milestone.t) / span) * plotRef.current.width;
      if (pxDistance <= MILESTONE_SNAP_PX) return visible[milestoneVisibleIndex]!;
    }
    const index = nearestPointIndex(visiblePoints, instant);
    return index < 0 ? -1 : visible[index]!;
  };

  const clearReading = React.useCallback(() => {
    isTouchReadingRef.current = false;
    setActiveState((curr) => (curr === null ? null : null));
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    const instant = instantAt(event.clientX);
    if (instant === null) return;
    const index = snapPointForInstant(instant);
    const point = index >= 0 ? data[index] : undefined;
    if (point) {
      isTouchReadingRef.current = true;
      setActiveState({ t: point.t, isExhaustMilestone: Boolean(point.isExhaustMilestone), follow: 'pointer' });
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    const instant = instantAt(event.clientX);
    if (instant === null) return;
    const index = snapPointForInstant(instant);
    const point = index >= 0 ? data[index] : undefined;
    if (!point) {
      clearReading();
      return;
    }
    const isMilestone = Boolean(point.isExhaustMilestone);
    isTouchReadingRef.current = false;
    setActiveState((curr) => (
      curr && curr.t === point.t && curr.isExhaustMilestone === isMilestone && curr.follow === 'pointer'
        ? curr
        : { t: point.t, isExhaustMilestone: isMilestone, follow: 'pointer' }
    ));
  };

  // Dismiss touch tooltips on outside tap or scroll so mobile never leaves a stuck overlay.
  const isTouchShowing = Boolean(active && isTouchReadingRef.current);
  React.useEffect(() => {
    if (!isTouchShowing) return undefined;
    const onOutside = (event: Event) => {
      const host = hostRef.current;
      if (!host || !(event.target instanceof Node) || !host.contains(event.target)) clearReading();
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('scroll', clearReading, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('scroll', clearReading, true);
    };
  }, [clearReading, isTouchShowing]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      clearReading();
      return;
    }
    const position = active
      ? visiblePoints.findIndex((point) => (
        point.t === active.t && Boolean(point.isExhaustMilestone) === Boolean(active.isExhaustMilestone)
      ))
      : -1;
    const next = stepPointIndex(position < 0 ? null : position, event.key, visiblePoints.length);
    if (next === position || (next === null && position < 0)) return;
    event.preventDefault();
    isTouchReadingRef.current = false;
    const nextPoint = next === null ? null : visiblePoints[next];
    setActiveState(nextPoint ? { t: nextPoint.t, isExhaustMilestone: Boolean(nextPoint.isExhaustMilestone), follow: 'key' } : null);
  };

  const formatSpan = (point: QuotaBurnPoint) => {
    const from = dayjs(point.startMs);
    const to = dayjs(point.endMs);
    if (point.startMs === point.endMs) return from.format('MM-DD HH:mm');
    return `${from.format('MM-DD HH:mm')} – ${from.isSame(to, 'day') ? to.format('HH:mm') : to.format('MM-DD HH:mm')}`;
  };

  // Pin the readout along the top of the plot like `PerformanceChart` (`isPinnedTop`), gliding smoothly
  // horizontally on the compositor between points instead of chasing pointer Y across the curve.
  const readoutAt = React.useMemo(() => {
    if (!active) return { x: 0, y: 0 };
    const plot = plotBox ?? plotRef.current;
    const anchorX = plot && plot.width > 0
      ? plot.x + ((active.t - cycleStart) / span) * plot.width
      : 0;
    const hostWidth = hostRef.current?.clientWidth || hostWidthRef.current || 760;
    const x = clampSparklineTooltipX(anchorX, hostWidth, readoutSize.width, READOUT_OFFSET);
    const y = Math.max(8, Math.round((plot?.y ?? 16) - 4));
    return { x, y };
  }, [active, cycleStart, plotBox, readoutSize.width, span]);

  return (
    <div className={styles['burn-chart']} ref={hostRef}>
      <ChartContainer
        config={config}
        role="group"
        aria-roledescription={t('trends.quota.chart_role')}
        aria-label={label}
        tabIndex={0}
        data-testid="trends-quota-chart"
        className={styles['burn-chart-host']}
        style={{ height }}
        initialDimension={{ width: 760, height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerCancel={(event) => {
          if (event.pointerType === 'touch') clearReading();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'touch') clearReading();
        }}
        onKeyDown={onKeyDown}
        onBlur={clearReading}
      >
        <QuotaBurnPlot
          id={id}
          data={data}
          cycleStart={cycleStart}
          cycleReset={cycleReset}
          isSameDay={isSameDay}
          tickFormat={tickFormat}
          hasForecast={hasForecast}
          divider={divider}
          nowMs={nowMs}
          projectedExhaustAtMs={projectedExhaustAtMs}
          lastForecast={lastForecast}
          projectedEndPercent={projectedEndPercent}
          plotRef={plotRef}
          overlayRef={overlayRef}
          onPlotChange={setPlotBox}
        />
      </ChartContainer>
      <div
        ref={readoutRef}
        className={styles['burn-readout']}
        data-follow={activeState?.follow ?? 'pointer'}
        data-ready={isReadoutAnimated ? 'true' : undefined}
        style={{ transform: `translate3d(${readoutAt.x}px, ${readoutAt.y}px, 0)` }}
        data-testid="trends-quota-readout"
        aria-live="polite"
        hidden={!active}
      >
        {active && (
          active.isExhaustMilestone ? (
            <TooltipReadout
              heading={dayjs(active.t).format('MM-DD HH:mm')}
              rows={[
                { key: 'used', name: t('trends.quota.used'), value: formatPercent(active.used), tone: 'danger' },
              ]}
              notes={[
                t('trends.quota.projected_exhaust', { at: dayjs(active.t).format('MM-DD HH:mm') }),
                t('trends.quota.forecast_note'),
              ]}
            />
          ) : (() => {
            const notes = [
              ...(active.isForecast ? [t('trends.quota.forecast_note')] : []),
              ...(isPhysicalUnavailable ? [t('trends.quota.physical_unavailable')] : []),
            ];
            return (
              <TooltipReadout
                heading={formatSpan(active)}
                rows={[
                  { key: 'used', name: t('trends.quota.used'), value: formatPercent(active.used), tone: active.used >= 100 ? 'danger' : undefined },
                  { key: 'delta', name: t('trends.quota.delta'), value: `+${formatPercent(active.delta)}` },
                  ...(isPhysicalUnavailable
                    ? []
                    : [
                        { key: 'requests', name: t('trends.metric.requests'), value: active.requests.toLocaleString('en') },
                        { key: 'net', name: t('trends.metric.net_tokens'), value: formatTokens(active.netTokens, style) },
                        { key: 'total', name: t('trends.metric.total_tokens'), value: formatTokens(active.totalTokens, style), tone: 'muted' as const },
                      ]),
                ]}
                notes={notes.length > 0 ? notes : undefined}
              />
            );
          })()
        )}
      </div>
    </div>
  );
};

const QuotaBurnChartPlot = React.memo(QuotaBurnChartView);

/** A new credential or window cross-fades in; the same cycle advancing is redrawn in place. */
export const QuotaBurnChart = React.memo<QuotaBurnChartProps>((props) => {
  const { shown, scopeRef } = useMorphedProps(props);
  return (
    <div ref={scopeRef} className="omc-chart-morph">
      <QuotaBurnChartPlot key={shown.drawingKey} {...shown} />
    </div>
  );
});
QuotaBurnChart.displayName = 'QuotaBurnChart';
export default QuotaBurnChart;
