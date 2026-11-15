import React from 'react';
import { claimTouchChartDismiss, releaseTouchChartDismiss } from '@/components/ui/chart';
import { TooltipReadout } from '../components/common/Tooltip';
import { useMotionPreference } from '@/utils/motionPreference';
import dayjs from '../utils/time';
import { useTimeZone } from '../utils/TimeZoneProvider';
import { useTheme } from '../theme/ThemeContext';
import { sharedResizeObserverHub } from '../performance/resizeObserverHub';
import { sparkColor, type ChartTone } from './chartTheme';
import {
  buildMonotoneSparkline,
  clampSparklineTooltipX,
  resolveSparklineIndex,
  sparklineViewBoxToHostX,
} from './monotoneSparkline';
import { useChartMorph } from './useChartMorph';
import type { DashboardSeriesPoint } from '../types/dashboard';

export interface DashboardTrendChartProps {
  points: DashboardSeriesPoint[];
  ariaLabel: string;
  pick: (point: DashboardSeriesPoint) => number;
  tone?: ChartTone;
  height?: number;
  label?: (timeMs: number) => string;
  format?: (value: number) => string;
}

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');
const LOGICAL_WIDTH = 240;
const TOOLTIP_FALLBACK_WIDTH = 136;

export const DashboardTrendChart: React.FC<DashboardTrendChartProps> = React.memo(function DashboardTrendChart({
  points,
  pick,
  ariaLabel,
  tone = 'accent',
  height = 46,
  label,
  format,
}) {
  useTimeZone();
  const { theme } = useTheme();
  const { isReducedMotion } = useMotionPreference();
  const gradientId = React.useId().replace(/:/g, '');
  const color = sparkColor(theme.palette, tone);

  const samples = React.useMemo(
    () =>
      points.map((point) => ({
        t: point.t,
        value: Math.max(0, pick(point) ?? 0),
      })),
    [points, pick],
  );

  const { shown, scopeRef } = useChartMorph(samples);

  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const tooltipRef = React.useRef<HTMLDivElement | null>(null);
  const [hoverState, setHoverState] = React.useState<{ index: number; hostWidth: number } | null>(null);
  const [isTouchEngaged, setIsTouchEngaged] = React.useState(false);
  const [tooltipWidth, setTooltipWidth] = React.useState(TOOLTIP_FALLBACK_WIDTH);
  const touchGestureRef = React.useRef<{
    x: number;
    y: number;
    wasVisible: boolean;
    indexBeforeTap: number | null;
    moved: boolean;
  } | null>(null);

  const dismissTouchTooltip = React.useCallback(() => {
    setHoverState(null);
    setIsTouchEngaged(false);
  }, []);

  React.useEffect(() => () => releaseTouchChartDismiss(dismissTouchTooltip), [dismissTouchTooltip]);

  React.useEffect(() => {
    if (!isTouchEngaged) return undefined;

    const onOutsidePointer = (event: Event) => {
      const host = hostRef.current;
      if (!host || !(event.target instanceof Node) || !host.contains(event.target)) {
        dismissTouchTooltip();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissTouchTooltip();
    };

    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('touchstart', onOutsidePointer, { capture: true, passive: true });
    document.addEventListener('scroll', dismissTouchTooltip, { capture: true, passive: true });
    document.addEventListener('visibilitychange', dismissTouchTooltip);
    window.addEventListener('blur', dismissTouchTooltip);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      document.removeEventListener('touchstart', onOutsidePointer, true);
      document.removeEventListener('scroll', dismissTouchTooltip, true);
      document.removeEventListener('visibilitychange', dismissTouchTooltip);
      window.removeEventListener('blur', dismissTouchTooltip);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dismissTouchTooltip, isTouchEngaged]);

  // Pure logical coordinate geometry (`viewBox="0 0 240 H"` + `preserveAspectRatio="none"` +
  // `vectorEffect="non-scaling-stroke"`): zero DOM layout reads and zero ResizeObservers on mount.
  const geometry = React.useMemo(
    () => buildMonotoneSparkline(shown, LOGICAL_WIDTH, height),
    [shown, height],
  );

  const clampedActiveIndex =
    hoverState !== null && hoverState.index >= 0 && hoverState.index < geometry.points.length
      ? hoverState.index
      : null;

  const activePoint = clampedActiveIndex !== null ? geometry.points[clampedActiveIndex] ?? null : null;
  const singlePoint = geometry.isSinglePoint ? geometry.points[0] ?? null : null;
  const formatHeading = label ?? ((at: number) => dayjs(at).format('MM-DD HH:mm'));
  const formatValue = (val: number) => format?.(val) ?? PLAIN_NUMBER_FORMAT.format(val);
  const activeHeading = activePoint ? formatHeading(activePoint.t) : '';
  const activeValueText = activePoint ? formatValue(activePoint.value) : '';

  React.useLayoutEffect(() => {
    if (clampedActiveIndex === null) return;
    const tip = tooltipRef.current;
    if (!tip) return;
    const w = Math.round(tip.offsetWidth);
    if (w > 0 && w !== tooltipWidth) {
      setTooltipWidth(w);
    }
  }, [clampedActiveIndex, activeHeading, activeValueText, tooltipWidth]);

  // Observe host width only while a tooltip is actively shown so initial mount and idle charts
  // pay zero ResizeObserver registration cost, while window/layout resizes keep `tooltipX` exact.
  const isTooltipActive = clampedActiveIndex !== null;
  React.useEffect(() => {
    if (!isTooltipActive) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    return sharedResizeObserverHub.observe(
      host,
      ({ width }) => {
        if (width <= 0) return;
        setHoverState((prev) =>
          prev && Math.abs(prev.hostWidth - width) >= 1
            ? { index: prev.index, hostWidth: width }
            : prev,
        );
      },
      { freezeOnTransition: true, epsilonPx: 1 },
    );
  }, [isTooltipActive]);

  if (shown.length === 0) {
    return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
  }

  const readHostWidth = (): number => {
    const host = hostRef.current;
    if (!host) return LOGICAL_WIDTH;
    const width = host.getBoundingClientRect().width;
    return width > 0 ? width : LOGICAL_WIDTH;
  };

  const pickHoverFromEvent = (clientX: number): { index: number; hostWidth: number } | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const hostWidth = rect.width > 0 ? rect.width : LOGICAL_WIDTH;
    const idx = resolveSparklineIndex(clientX - rect.left, hostWidth, geometry.points.length, undefined, LOGICAL_WIDTH);
    return idx === null ? null : { index: idx, hostWidth };
  };

  const hostWidth = hoverState?.hostWidth ?? LOGICAL_WIDTH;
  const activeCursorPx = activePoint
    ? sparklineViewBoxToHostX(activePoint.x, hostWidth, LOGICAL_WIDTH)
    : hostWidth / 2;
  const activeLeftPct = activePoint ? `${(activePoint.x / LOGICAL_WIDTH) * 100}%` : '50%';
  const tooltipX = activePoint
    ? clampSparklineTooltipX(activeCursorPx, hostWidth, tooltipWidth)
    : 0;

  return (
    <div className="chart-slot" style={{ minHeight: height }}>
      <div
        ref={scopeRef}
        className="omc-chart-slot omc-chart-morph relative w-full min-w-0"
        style={{ height }}
      >
        <div
          ref={hostRef}
          data-slot="chart"
          role="img"
          aria-label={ariaLabel}
          tabIndex={geometry.points.length > 0 ? 0 : undefined}
          className="relative flex h-full w-full min-w-0 justify-center rounded-sm text-sm tabular-nums select-none touch-pan-y focus-visible:outline-none focus-visible:shadow-focus"
          onFocus={(event) => {
            if (hoverState !== null || geometry.points.length === 0) return;
            // Keyboard focus reveals the latest bucket readout without stealing pointer hover.
            if (typeof event.currentTarget.matches === 'function' && !event.currentTarget.matches(':focus-visible')) {
              return;
            }
            setHoverState({ index: geometry.points.length - 1, hostWidth: readHostWidth() });
          }}
          onBlur={() => {
            if (!isTouchEngaged) setHoverState(null);
          }}
          onKeyDown={(event) => {
            const count = geometry.points.length;
            if (count === 0) return;
            if (event.key === 'Escape') {
              if (hoverState !== null) {
                event.preventDefault();
                setHoverState(null);
              }
              return;
            }
            let nextIndex: number | null = null;
            if (event.key === 'ArrowLeft') {
              nextIndex = clampedActiveIndex === null ? count - 1 : Math.max(0, clampedActiveIndex - 1);
            } else if (event.key === 'ArrowRight') {
              nextIndex = clampedActiveIndex === null ? 0 : Math.min(count - 1, clampedActiveIndex + 1);
            } else if (event.key === 'Home') {
              nextIndex = 0;
            } else if (event.key === 'End') {
              nextIndex = count - 1;
            }
            if (nextIndex !== null) {
              event.preventDefault();
              setHoverState({ index: nextIndex, hostWidth: readHostWidth() });
            }
          }}
          onPointerDown={(event) => {
            if (event.pointerType === 'touch') {
              claimTouchChartDismiss(dismissTouchTooltip);
              const next = pickHoverFromEvent(event.clientX);
              touchGestureRef.current = {
                x: event.clientX,
                y: event.clientY,
                wasVisible: isTouchEngaged && clampedActiveIndex !== null,
                indexBeforeTap: clampedActiveIndex,
                moved: false,
              };
              setIsTouchEngaged(true);
              setHoverState(next);
            } else {
              touchGestureRef.current = null;
            }
          }}
          onPointerMove={(event) => {
            if (event.pointerType === 'touch') {
              const gesture = touchGestureRef.current;
              if (!gesture) return;
              const dx = Math.abs(event.clientX - gesture.x);
              const dy = Math.abs(event.clientY - gesture.y);
              if (dx > 6 || dy > 6) gesture.moved = true;
              if (dy > 10 && dy > dx) {
                touchGestureRef.current = null;
                dismissTouchTooltip();
                return;
              }
              const next = pickHoverFromEvent(event.clientX);
              setHoverState((prev) =>
                prev && next && prev.index === next.index && Math.abs(prev.hostWidth - next.hostWidth) < 1
                  ? prev
                  : next,
              );
              return;
            }
            const next = pickHoverFromEvent(event.clientX);
            setHoverState((prev) =>
              prev && next && prev.index === next.index && Math.abs(prev.hostWidth - next.hostWidth) < 1
                ? prev
                : next,
            );
          }}
          onPointerUp={(event) => {
            if (event.pointerType === 'touch' && touchGestureRef.current) {
              const gesture = touchGestureRef.current;
              touchGestureRef.current = null;
              if (
                !gesture.moved &&
                gesture.wasVisible &&
                gesture.indexBeforeTap !== null &&
                gesture.indexBeforeTap === clampedActiveIndex
              ) {
                dismissTouchTooltip();
              }
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') {
              setHoverState(null);
            }
          }}
        >
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${LOGICAL_WIDTH} ${height}`}
            preserveAspectRatio="none"
            className="omc-sparkline-surface block h-full w-full overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.2} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {(geometry.isSinglePoint || !geometry.hasPositiveValue) && (
              <line
                x1={geometry.x0}
                x2={geometry.x1}
                y1={geometry.yBottom}
                y2={geometry.yBottom}
                stroke="var(--border-soft)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {singlePoint && geometry.hasPositiveValue && (
              <line
                x1={singlePoint.x}
                x2={singlePoint.x}
                y1={geometry.yTop}
                y2={geometry.yBottom}
                stroke={color}
                strokeOpacity={0.28}
                strokeDasharray="2 2"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {!geometry.isSinglePoint && (
              <>
                {geometry.hasPositiveValue && (
                  <path d={geometry.areaPath} fill={`url(#${gradientId})`} />
                )}
                <path
                  d={geometry.linePath}
                  fill="none"
                  stroke={geometry.hasPositiveValue ? color : 'var(--border)'}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
            {activePoint && (
              <line
                x1={activePoint.x}
                x2={activePoint.x}
                y1={geometry.yTop}
                y2={geometry.yBottom}
                stroke="var(--border)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {singlePoint && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '50%',
                top: singlePoint.y,
                width: geometry.hasPositiveValue ? 7 : 5,
                height: geometry.hasPositiveValue ? 7 : 5,
                borderRadius: '50%',
                background: geometry.hasPositiveValue ? color : 'var(--muted)',
                boxShadow: geometry.hasPositiveValue
                  ? `0 0 0 6px color-mix(in srgb, ${color} 24%, transparent)`
                  : undefined,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
              }}
            />
          )}
          {activePoint && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: activeLeftPct,
                top: activePoint.y,
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: color,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
              }}
            />
          )}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {activePoint ? `${activeHeading}: ${activeValueText}` : ''}
          </span>
          {activePoint && (
            <div
              ref={tooltipRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                transform: `translate3d(${tooltipX}px, 0, 0)`,
                transition: isReducedMotion ? 'none' : 'transform 110ms var(--ease-out)',
                pointerEvents: 'none',
                maxWidth: 'calc(100vw - 24px)',
                zIndex: 30,
                willChange: 'transform',
              }}
            >
              <div
                data-slot="chart-tooltip"
                className="omc-float-surface max-w-[min(300px,calc(100vw-24px))] rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-float pointer-events-none"
              >
                <TooltipReadout
                  heading={activeHeading}
                  rows={[
                    {
                      color,
                      value: activeValueText,
                    },
                  ]}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
