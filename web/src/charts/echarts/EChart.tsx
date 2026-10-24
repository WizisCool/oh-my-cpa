import React from 'react';
import { ChartMount } from '../ChartMount';
import { useTheme } from '../../theme/ThemeContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { currentFontStack } from '../../theme/fontLibrary';
import { echarts, type ECharts, type EChartsCoreOption } from './core';
import { buildEchartsTheme, echartsMotion } from './echartsTheme';
import './echarts.css';

/** ECharts events the page listens to, by name. */
export type EChartHandlers = Partial<Record<'click' | 'backgroundClick' | 'brushEnd' | 'mouseover' | 'mouseout', (params: unknown, chart: ECharts) => void>>;

export interface EChartProps {
  option: EChartsCoreOption;
  height: number;
  className?: string;
  /** The chart's accessible name; ECharts' aria module describes the series under it. */
  label: string;
  handlers?: EChartHandlers;
  /** Called after every option is applied, for a caller that drives the instance (arming a brush, say). */
  onApplied?: (chart: ECharts) => void;
  testId?: string;
}

/**
 * EChart is the one place an ECharts instance is created, updated and disposed.
 *
 * The instance outlives every option change: a new option is merged into it, so the marks the reader
 * is looking at morph to their next value instead of being redrawn (`notMerge` only when the series
 * set itself changes, which ECharts detects by series id). A theme change repaints the same instance
 * with `setTheme`. The container is sized by the caller and observed, so the chart follows its panel
 * rather than the window.
 */
const EChartView: React.FC<EChartProps> = ({ option, height, className, label, handlers, onApplied, testId }) => {
  const container = React.useRef<HTMLDivElement>(null);
  const chart = React.useRef<ECharts | null>(null);
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
    const instance = echarts.init(element, themeObject, { renderer: 'svg' });
    chart.current = instance;
    for (const name of ['click', 'brushEnd', 'mouseover', 'mouseout'] as const) {
      instance.on(name, (...args: unknown[]) => { handlerRef.current?.[name]?.(args[0], instance); });
    }
    // ECharts' click only reaches painted elements. A click on the empty plot is a ZRender event
    // with no target, which is the gesture that clears a chart selection.
    const backgroundClick = (event: { target?: unknown }) => {
      if (event.target === undefined || event.target === null) handlerRef.current?.backgroundClick?.(event, instance);
    };
    instance.getZr().on('click', backgroundClick);
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      instance.getZr().off('click', backgroundClick);
      instance.dispose();
      chart.current = null;
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
    instance.setOption({ ...echartsMotion(isReducedMotion), aria: { enabled: true, label: { description: label } }, ...option }, {
      replaceMerge: ['series', 'xAxis', 'yAxis', 'grid'],
    });
    appliedRef.current?.(instance);
  }, [option, isReducedMotion, label]);

  return (
    <div
      ref={container}
      className={['omc-echart', className].filter(Boolean).join(' ')}
      style={{ height }}
      role="img"
      aria-label={label}
      data-testid={testId}
    />
  );
};

/** Deferred through the console's chart mount queue, so several charts never initialise in one task. */
export const EChart: React.FC<EChartProps> = (props) => (
  <div className="omc-echart-slot" style={{ height: props.height }}>
    <ChartMount>
      <EChartView {...props} />
    </ChartMount>
  </div>
);
