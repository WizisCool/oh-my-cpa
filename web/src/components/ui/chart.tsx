import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import { TooltipReadout, type TooltipReadoutRow } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { sharedResizeObserverHub } from '@/performance/resizeObserverHub';
import { useMotionPreference } from '@/utils/motionPreference';

const THEMES = { dark: ':root', light: ":root[data-theme-mode='light']" } as const;
const INITIAL_DIMENSION = { width: 320, height: 200 } as const;

function isSyntheticDomEnvironment(): boolean {
  return (
    typeof ResizeObserver === 'undefined' ||
    (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent))
  );
}

/** Ensures at most one chart across the page holds an active touch tooltip at any time. */
let activeTouchChartDismiss: (() => void) | null = null;

export function claimTouchChartDismiss(dismiss: () => void): void {
  if (activeTouchChartDismiss && activeTouchChartDismiss !== dismiss) {
    activeTouchChartDismiss();
  }
  activeTouchChartDismiss = dismiss;
}

export function releaseTouchChartDismiss(dismiss: () => void): void {
  if (activeTouchChartDismiss === dismiss) {
    activeTouchChartDismiss = null;
  }
}

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
>;

interface ChartContextValue {
  config: ChartConfig;
  isReducedMotion: boolean;
  isTooltipDismissed: boolean;
  noteActiveTooltipKey: (key: string) => void;
}

const ChartContext = React.createContext<ChartContextValue | null>(null);

export function useChart(): ChartContextValue {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

export interface ChartContainerProps extends React.ComponentProps<'div'> {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
  responsive?: boolean;
  initialDimension?: { width: number; height: number };
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  responsive = true,
  initialDimension = INITIAL_DIMENSION,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ref,
  ...props
}: ChartContainerProps) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`;
  const { isReducedMotion } = useMotionPreference();

  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [isTooltipDismissed, setIsTooltipDismissed] = React.useState(false);
  const [isTouchEngaged, setIsTouchEngaged] = React.useState(false);
  const [measuredDimension, setMeasuredDimension] = React.useState<{ width: number; height: number } | null>(
    () => (isSyntheticDomEnvironment() ? initialDimension : null),
  );
  const lastActiveKeyRef = React.useRef<string>('');
  const touchGestureRef = React.useRef<{
    x: number;
    y: number;
    wasVisible: boolean;
    keyBeforeTap: string;
    moved: boolean;
  } | null>(null);

  const attachRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );

  const dismissTouchTooltip = React.useCallback(() => {
    setIsTooltipDismissed(true);
    setIsTouchEngaged(false);
    lastActiveKeyRef.current = '';
  }, []);

  React.useEffect(() => {
    return () => {
      releaseTouchChartDismiss(dismissTouchTooltip);
    };
  }, [dismissTouchTooltip]);

  // Subscribe to the shared ResizeObserver hub without reading `clientWidth` inside `useLayoutEffect`:
  // ResizeObserver delivers the post-layout `contentRect` directly from the browser's normal layout pass
  // with zero forced synchronous layout, so Recharts mounts once at exact pixel dimensions.
  // If a caller forgets an explicit height (yielding `h === 0` while `w > 0`), fall back to
  // `initialDimension.height` so the chart remains visible instead of staying blank.
  const fallbackHeight = initialDimension.height;
  React.useEffect(() => {
    if (!responsive) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    return sharedResizeObserverHub.observe(
      host,
      ({ width, height }) => {
        const w = Math.round(width);
        const h = Math.round(height);
        if (w <= 0) return;
        const resolvedHeight = h > 0 ? h : fallbackHeight;
        if (resolvedHeight <= 0) return;
        setMeasuredDimension((prev) =>
          prev && prev.width === w && prev.height === resolvedHeight
            ? prev
            : { width: w, height: resolvedHeight },
        );
      },
      { freezeOnTransition: true, epsilonPx: 1 },
    );
  }, [responsive, fallbackHeight]);

  React.useEffect(() => {
    if (!isTouchEngaged) return;

    const onOutsideTouchOrPointer = (event: Event) => {
      const host = hostRef.current;
      if (!host || !(event.target instanceof Node) || !host.contains(event.target)) {
        dismissTouchTooltip();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissTouchTooltip();
    };

    document.addEventListener('pointerdown', onOutsideTouchOrPointer, true);
    document.addEventListener('touchstart', onOutsideTouchOrPointer, { capture: true, passive: true });
    document.addEventListener('scroll', dismissTouchTooltip, { capture: true, passive: true });
    document.addEventListener('visibilitychange', dismissTouchTooltip);
    window.addEventListener('blur', dismissTouchTooltip);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onOutsideTouchOrPointer, true);
      document.removeEventListener('touchstart', onOutsideTouchOrPointer, true);
      document.removeEventListener('scroll', dismissTouchTooltip, true);
      document.removeEventListener('visibilitychange', dismissTouchTooltip);
      window.removeEventListener('blur', dismissTouchTooltip);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dismissTouchTooltip, isTouchEngaged]);

  const noteActiveTooltipKey = React.useCallback((key: string) => {
    lastActiveKeyRef.current = key;
  }, []);

  const contextValue = React.useMemo<ChartContextValue>(
    () => ({
      config,
      isReducedMotion,
      isTooltipDismissed,
      noteActiveTooltipKey,
    }),
    [config, isReducedMotion, isTooltipDismissed, noteActiveTooltipKey],
  );

  return (
    <ChartContext.Provider value={contextValue}>
      <div
        ref={attachRef}
        data-slot="chart"
        data-chart={chartId}
        onPointerDown={(event) => {
          if (event.pointerType === 'touch') {
            claimTouchChartDismiss(dismissTouchTooltip);
            touchGestureRef.current = {
              x: event.clientX,
              y: event.clientY,
              wasVisible: isTouchEngaged && !isTooltipDismissed && lastActiveKeyRef.current !== '',
              keyBeforeTap: lastActiveKeyRef.current,
              moved: false,
            };
            setIsTouchEngaged(true);
            setIsTooltipDismissed(false);
          } else {
            touchGestureRef.current = null;
            if (isTooltipDismissed) setIsTooltipDismissed(false);
          }
          onPointerDown?.(event);
        }}
        onPointerMove={(event) => {
          if (event.pointerType === 'touch' && touchGestureRef.current) {
            const dx = Math.abs(event.clientX - touchGestureRef.current.x);
            const dy = Math.abs(event.clientY - touchGestureRef.current.y);
            if (dx > 6 || dy > 6) touchGestureRef.current.moved = true;
            // Vertical page scroll over the chart: dismiss immediately so no tooltip lingers.
            if (dy > 10 && dy > dx) {
              touchGestureRef.current = null;
              dismissTouchTooltip();
            }
          } else if (event.pointerType !== 'touch' && isTooltipDismissed) {
            setIsTooltipDismissed(false);
          }
          onPointerMove?.(event);
        }}
        onPointerUp={(event) => {
          if (event.pointerType === 'touch' && touchGestureRef.current) {
            const gesture = touchGestureRef.current;
            touchGestureRef.current = null;
            // Repeat tap on the same already-visible bucket toggles the tooltip closed.
            if (
              !gesture.moved &&
              gesture.wasVisible &&
              gesture.keyBeforeTap !== '' &&
              gesture.keyBeforeTap === lastActiveKeyRef.current
            ) {
              dismissTouchTooltip();
            }
          }
          onPointerUp?.(event);
        }}
        className={cn(
          'relative flex w-full min-w-0 justify-center text-sm tabular-nums select-none touch-pan-y',
          '[&_.recharts-cartesian-axis-tick_text]:fill-[var(--muted)] [&_.recharts-cartesian-axis-tick_text]:text-sm',
          '[&_.recharts-cartesian-grid_line]:stroke-[var(--border-soft)] [&_.recharts-cartesian-grid_line]:[stroke-width:var(--hairline)]',
          '[&_.recharts-curve.recharts-tooltip-cursor]:stroke-[var(--border)] [&_.recharts-curve.recharts-tooltip-cursor]:[stroke-width:1px]',
          '[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-[color-mix(in_srgb,var(--fg)_4%,transparent)]',
          className,
        )}
        {...props}
      >
        {responsive ? (
          measuredDimension ? (
            <RechartsPrimitive.ResponsiveContainer
              width={measuredDimension.width}
              height={measuredDimension.height}
            >
              {children}
            </RechartsPrimitive.ResponsiveContainer>
          ) : null
        ) : (
          children
        )}
      </div>
    </ChartContext.Provider>
  );
}

/**
 * The readout follows the pointer closely: a short decelerating glide between buckets, on a
 * layer of its own so the move is composited instead of repainted. The library's default - a
 * 400ms symmetric ease - trailed the pointer by a whole bucket on a quick sweep.
 *
 * It keeps clear of what the reader is looking at. It stands well off the pointer, and a chart
 * read along its x axis rides it along the top of the plot (`isPinnedTop`): the readout then only
 * slides sideways beside the hovered bucket, instead of sitting on the marks at the pointer's
 * height and chasing it up and down.
 */
export function ChartTooltip({
  isPinnedTop = false,
  ...props
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> & { isPinnedTop?: boolean }) {
  const { isReducedMotion } = useMotionPreference();
  return (
    <RechartsPrimitive.Tooltip
      allowEscapeViewBox={{ x: false, y: false }}
      offset={TOOLTIP_OFFSET}
      position={isPinnedTop ? { y: 0 } : undefined}
      useTranslate3d
      isAnimationActive={!isReducedMotion}
      animationDuration={TOOLTIP_GLIDE_MS}
      // The library concatenates this into `transition`, so a token reads as it does in CSS.
      animationEasing={'var(--ease-out)' as 'ease-out'}
      {...props}
      wrapperStyle={{ pointerEvents: 'none', maxWidth: 'calc(100vw - 24px)', zIndex: 30, willChange: 'transform', ...props.wrapperStyle }}
    />
  );
}

const TOOLTIP_OFFSET = 18;
const TOOLTIP_GLIDE_MS = 110;

export const ChartLegend = RechartsPrimitive.Legend;

export interface ChartTooltipPayloadItem {
  name?: string | number;
  dataKey?: string | number;
  value?: number | string | ReadonlyArray<number | string> | null;
  color?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipContentProps {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadItem[];
  label?: string | number;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  indicator?: 'dot' | 'line' | 'dashed';
  nameKey?: string;
  labelFormatter?: (label: string | number | undefined, payload: readonly ChartTooltipPayloadItem[]) => React.ReactNode;
  valueFormatter?: (value: number, key: string, item: ChartTooltipPayloadItem) => React.ReactNode;
  buildRows?: (payload: readonly ChartTooltipPayloadItem[], label: string | number | undefined) => {
    heading?: React.ReactNode;
    rows: readonly TooltipReadoutRow[];
  } | null;
  className?: string;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  hideLabel = false,
  hideIndicator = false,
  indicator = 'dot',
  nameKey,
  labelFormatter,
  valueFormatter,
  buildRows,
  className,
}: ChartTooltipContentProps) {
  const { config, isTooltipDismissed, noteActiveTooltipKey } = useChart();

  const payloadIdentity = React.useMemo(() => {
    if (!active || !payload?.length) return '';
    const first = payload[0];
    const p = first?.payload;
    if (p && typeof p === 'object') {
      const candidate = p.bucketIndex ?? p.t ?? p.hour ?? p.rowId ?? p.id ?? label;
      if (candidate !== undefined) return String(candidate);
    }
    return String(label ?? first?.name ?? 'active');
  }, [active, label, payload]);

  React.useEffect(() => {
    if (payloadIdentity && !isTooltipDismissed) {
      noteActiveTooltipKey(payloadIdentity);
    }
  }, [isTooltipDismissed, noteActiveTooltipKey, payloadIdentity]);

  if (isTooltipDismissed || !active || !payload?.length) {
    return null;
  }

  if (buildRows) {
    const custom = buildRows(payload, label);
    if (!custom || custom.rows.length === 0) return null;
    return (
      <div
        data-slot="chart-tooltip"
        className={cn(
          'omc-float-surface max-w-[min(300px,calc(100vw-24px))] rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-float pointer-events-none',
          className,
        )}
      >
        <TooltipReadout heading={hideLabel ? undefined : custom.heading} rows={custom.rows} />
      </div>
    );
  }

  const heading = hideLabel
    ? undefined
    : labelFormatter
      ? labelFormatter(label, payload)
      : typeof label === 'string' && config[label]?.label
        ? config[label].label
        : label;

  const rows: TooltipReadoutRow[] = payload
    .filter((item) => item.type !== 'none' && item.value !== null && item.value !== undefined)
    .map((item, index) => {
      const key = String(nameKey ?? item.dataKey ?? item.name ?? index);
      const itemConfig = config[key];
      const numeric = typeof item.value === 'number' ? item.value : Number(item.value);
      const formatted = valueFormatter && Number.isFinite(numeric)
        ? valueFormatter(numeric, key, item)
        : typeof item.value === 'number'
          ? item.value.toLocaleString()
          : String(item.value);

      return {
        key: `${key}-${index}`,
        name: itemConfig?.label ?? item.name,
        color: hideIndicator ? undefined : (itemConfig && 'color' in itemConfig ? itemConfig.color : undefined) ?? (item.payload?.fill as string | undefined) ?? item.color,
        indicator,
        value: formatted,
      };
    });

  if (rows.length === 0) return null;

  return (
    <div
      data-slot="chart-tooltip"
      className={cn(
        'omc-float-surface max-w-[min(300px,calc(100vw-24px))] rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-float pointer-events-none',
        className,
      )}
    >
      <TooltipReadout heading={heading} rows={rows} />
    </div>
  );
}
