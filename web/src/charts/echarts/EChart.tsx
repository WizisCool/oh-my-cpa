import React from 'react';
import { ChartSurface } from '../ChartSurface';
import { useTheme } from '../../theme/ThemeContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { currentFontStack } from '../../theme/fontLibrary';
import { sharedResizeObserverHub, type ObservedBoxSize } from '../../performance/resizeObserverHub';
import type { MountPriority } from '../../performance/frameScheduler';
import { echarts, type ECharts, type EChartsCoreOption } from './core';
import { buildEchartsTheme, applyEchartsMotion } from './echartsTheme';
import './echarts.css';

/** ECharts events the page listens to, by name. */
export type EChartHandlers = Partial<Record<'click' | 'backgroundClick' | 'brushEnd' | 'mouseover' | 'mouseout', (params: unknown, chart: ECharts) => void>>;

export interface EChartProps {
  option: EChartsCoreOption;
  height?: number;
  className?: string;
  /** The chart's accessible name; ECharts' aria module describes the series under it. */
  label: string;
  handlers?: EChartHandlers;
  /** Called after every option is applied, for a caller that drives the instance (arming a brush, say). */
  onApplied?: (chart: ECharts) => void;
  /** Frame-budget scheduling priority (`p0` for hero sparklines, `p1` for analytical charts). */
  priority?: MountPriority;
  /** Freeze resize recalculations while a route transition is active. Defaults to `true`. */
  freezeOnTransition?: boolean;
  testId?: string;
}

/**
 * EChart is the one place an ECharts instance is created, updated and disposed.
 *
 * The instance outlives every option change: a new option is merged into it, so the marks the reader
 * is looking at morph to their next value instead of being redrawn (`notMerge` only when the series
 * set itself changes, which ECharts detects by series id). A theme change repaints the same instance
 * with `setTheme`. Container dimensions come from `sharedResizeObserverHub`, passing explicit
 * `{ width, height }` to `instance.resize` to avoid interleaved DOM layout queries and skipping
 * redundant initial resize callbacks when the box matches the size already passed to `echarts.init`.
 */
const EChartView: React.FC<EChartProps> = ({
  option,
  height,
  className,
  label,
  handlers,
  onApplied,
  freezeOnTransition = true,
  testId,
}) => {
  const container = React.useRef<HTMLDivElement>(null);
  const chart = React.useRef<ECharts | null>(null);
  const lastSizeRef = React.useRef<ObservedBoxSize | null>(null);
  const { theme } = useTheme();
  const isReducedMotion = usePrefersReducedMotion();
  const handlerRef = React.useRef(handlers);
  handlerRef.current = handlers;
  const appliedRef = React.useRef(onApplied);
  appliedRef.current = onApplied;

  const themeObject = React.useMemo(() => buildEchartsTheme(theme.palette, currentFontStack('mono')), [theme.palette]);

  React.useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const initialWidth = element.clientWidth;
    const initialHeight = element.clientHeight;
    const hasInitialBox = initialWidth > 0 && initialHeight > 0;
    const instance = echarts.init(element, themeObject, {
      renderer: 'svg',
      ...(hasInitialBox ? { width: initialWidth, height: initialHeight } : {}),
    });
    chart.current = instance;
    lastSizeRef.current = hasInitialBox ? { width: initialWidth, height: initialHeight } : null;

    for (const name of ['click', 'brushEnd', 'mouseover', 'mouseout'] as const) {
      instance.on(name, (...args: unknown[]) => { handlerRef.current?.[name]?.(args[0], instance); });
    }
    // ECharts' click only reaches painted elements. A click on the empty plot is a ZRender event
    // with no target, which is the gesture that clears a chart selection.
    const backgroundClick = (event: { target?: unknown }) => {
      if (event.target === undefined || event.target === null) handlerRef.current?.backgroundClick?.(event, instance);
    };
    instance.getZr().on('click', backgroundClick);
    const unsubscribeResize = sharedResizeObserverHub.observe(
      element,
      ({ width, height }) => {
        const previous = lastSizeRef.current;
        if (previous && Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5) {
          return;
        }
        lastSizeRef.current = { width, height };
        instance.resize({ width, height });
      },
      { freezeOnTransition },
    );
    return () => {
      unsubscribeResize();
      instance.getZr().off('click', backgroundClick);
      instance.dispose();
      chart.current = null;
      lastSizeRef.current = null;
    };
    // The instance is created once per mount; theme and option changes are applied to it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    chart.current?.setTheme(themeObject);
  }, [themeObject]);

  React.useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    instance.setOption(applyEchartsMotion({ aria: { enabled: true, label: { description: label } }, ...option }, isReducedMotion), {
      replaceMerge: ['series', 'xAxis', 'yAxis', 'grid'],
    });
    appliedRef.current?.(instance);
  }, [option, isReducedMotion, label]);

  return (
    <div
      ref={container}
      className={['omc-echart', className].filter(Boolean).join(' ')}
      style={{ height: height ?? '100%' }}
      role="img"
      aria-label={label}
      data-testid={testId}
    />
  );
};

/** Deferred through the console's priority frame-budget scheduler inside a Zero-CLS `ChartSurface`. */
export const EChart: React.FC<EChartProps> = ({ priority = 'p1', ...props }) => (
  <ChartSurface height={props.height ?? '100%'} priority={priority}>
    <EChartView {...props} priority={priority} />
  </ChartSurface>
);
