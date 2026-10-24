import React from 'react';
import { useTheme } from '../theme/ThemeContext';
import { EChart, type EChartHandlers } from './echarts/EChart';
import type { ECharts, EChartsCoreOption } from './echarts/core';
import { seriesColorRange, seriesDomainKey, seriesTrackColor, seriesGroupLabel } from './chartTheme';
import { formatModelShare, formatModelTokens, type DashboardModelUsage } from '../types/dashboardModels';
import { formatTokens, formatTokensFull } from '../types/tokenDisplay';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import { renderChartTooltip } from './chartTooltip';

export interface ModelUsageDonutProps {
  groups: DashboardModelUsage[];
  totalTokens: number;
  foldedLabel: string;
  unnamedLabel: string;
  tokenUnitLabel: string;
  activeKey: string | null;
  onHover: (key: string | null) => void;
}

/** The square frame and DOM readout share a centre, independent of the ranked list's height. */
export const ModelUsageDonut = React.memo<ModelUsageDonutProps>(({ groups, totalTokens, foldedLabel, unnamedLabel, tokenUnitLabel, activeKey, onHover }) => {
  const { theme } = useTheme();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const chartRef = React.useRef<ECharts | null>(null);
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);
  // Zero-angle arcs carry no reading; zero groups still remain in the DOM ranking.
  const data = React.useMemo(() => groups.filter((group) => group.tokens > 0).map((group) => ({
    id: seriesDomainKey(group), name: seriesDomainKey(group), value: group.tokens,
    itemStyle: { color: range[groups.indexOf(group)] },
  })), [groups, range]);
  const activeGroup = groups.find((group) => seriesDomainKey(group) === activeKey);
  const labelOf = React.useCallback((key: string) => seriesGroupLabel({ folded: key === 'folded', model: key.replace(/^model:/, '') }, foldedLabel, unnamedLabel), [foldedLabel, unnamedLabel]);
  const option = React.useMemo<EChartsCoreOption>(() => ({
    tooltip: {
      trigger: 'item', className: 'omc-echart-tip', confine: true,
      formatter: (item: { name: string; value: number; color: string }) => renderChartTooltip(undefined, [{
        name: labelOf(item.name), color: item.color,
        value: `${formatTokens(item.value, tokenStyle)} ${tokenUnitLabel}`,
        exact: `${formatTokensFull(item.value)} ${tokenUnitLabel}`,
        share: formatModelShare(item.value, totalTokens),
      }]),
    },
    series: [{
      id: 'model-usage', type: 'pie', data, radius: ['66%', '92%'], padAngle: 1.5,
      left: 16, right: 16, top: 16, bottom: 16, clockwise: false,
      label: { show: false }, labelLine: { show: false },
      itemStyle: { borderRadius: 3 }, emphasis: { scaleSize: 4 },
      animationDuration: 0,
    }],
  }), [data, labelOf, tokenStyle, tokenUnitLabel, totalTokens]);

  const highlight = React.useCallback((chart: ECharts) => {
    chart.dispatchAction({ type: 'downplay', seriesId: 'model-usage' });
    const dataIndex = data.findIndex((item) => item.id === activeKey);
    if (dataIndex >= 0) chart.dispatchAction({ type: 'highlight', seriesId: 'model-usage', dataIndex });
  }, [activeKey, data]);
  const onApplied = React.useCallback((chart: ECharts) => {
    chartRef.current = chart;
    highlight(chart);
  }, [highlight]);
  React.useEffect(() => {
    if (chartRef.current && !chartRef.current.isDisposed()) highlight(chartRef.current);
  }, [highlight]);
  const handlers = React.useMemo<EChartHandlers>(() => ({
    mouseover: (event) => {
      const key = (event as { name?: string }).name;
      if (key !== undefined) onHover(key);
    },
    mouseout: () => onHover(null),
  }), [onHover]);

  const value = activeGroup?.tokens ?? totalTokens;
  const share = activeGroup ? formatModelShare(value, totalTokens) : undefined;
  const centerLabel = `${activeGroup ? `${labelOf(seriesDomainKey(activeGroup))}: ` : ''}${formatTokensFull(value)} ${tokenUnitLabel}${share ? ` · ${share}` : ''}`;
  return (
    <div className="model-ring" role="img" aria-label={centerLabel}>
      <div className="model-ring-frame">
        {data.length > 0 && <EChart option={option} label={`${formatTokensFull(totalTokens)} ${tokenUnitLabel}`} handlers={handlers} onApplied={onApplied} />}
        <div className="model-ring-center">
          <span className="model-ring-total">{formatModelTokens(value, tokenStyle)}</span>
          <span className="model-ring-unit" aria-hidden="true">{share ?? tokenUnitLabel}</span>
        </div>
      </div>
      {data.length === 0 && <span className="model-ring-track" style={{ borderColor: seriesTrackColor(theme.palette) }} aria-hidden="true" />}
    </div>
  );
});
