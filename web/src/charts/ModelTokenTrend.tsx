import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import dayjs from '../utils/time';
import { renderChartTooltip } from './chartTooltip';
import { buildModelTrendSeries } from './modelTrendData';
import { useTheme } from '../theme/ThemeContext';
import { EChart } from './echarts/EChart';
import type { ECharts, EChartsCoreOption } from './echarts/core';
import { seriesColorRange, seriesDomainKey } from './chartTheme';
import { currentFontStack } from '../theme/fontLibrary';
import { formatTokens, formatTokensFull } from '../types/tokenDisplay';
import type { DashboardModelUsage } from '../types/dashboardModels';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';

export interface ModelTokenTrendProps {
  groups: DashboardModelUsage[];
  foldedLabel: string;
  tokenUnitLabel?: string;
  height?: number;
  onApplied?: (chart: ECharts) => void;
}

/** Lines separate overlapping model readings; their DOM legend owns the ranked color assignment. */
export const ModelTokenTrend = React.memo<ModelTokenTrendProps>(({ groups, foldedLabel, tokenUnitLabel = '', height = 260, onApplied }) => {
  const timeZone = useTimeZone();
  const { theme } = useTheme();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const option = React.useMemo<EChartsCoreOption>(() => {
    const { categories, series } = buildModelTrendSeries(groups);
    const domain = groups.map(seriesDomainKey);
    const range = seriesColorRange(theme.palette, groups);
    const labelOf = (key: string) => key === 'folded' ? foldedLabel : key.replace(/^model:/, '');
    const labelFormat = Number(categories.at(-1)) - Number(categories[0]) > 24 * 60 * 60 * 1000 ? 'MM-DD' : 'HH:mm';
    const ticks = new Set(Array.from({ length: Math.min(4, categories.length) }, (_, index) =>
      Math.round(index * (categories.length - 1) / Math.max(1, Math.min(4, categories.length) - 1))));
    return {
      grid: { left: 56, right: 56, top: 26, bottom: 48 },
      xAxis: {
        type: 'category', data: categories, boundaryGap: false,
        axisLabel: {
          interval: (index: number) => ticks.has(index),
          formatter: (value: string) => dayjs(Number(value)).format(labelFormat),
          showMinLabel: true, showMaxLabel: true, color: theme.palette.fg2,
          fontFamily: currentFontStack('mono'), fontSize: 10,
        },
        axisTick: { show: true, interval: (index: number) => ticks.has(index) },
        axisLine: { lineStyle: { color: theme.palette.border } },
      },
      yAxis: {
        type: 'value', min: 0, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { show: false },
        splitLine: { lineStyle: { color: theme.palette.border } },
      },
      tooltip: {
        trigger: 'axis', className: 'omc-echart-tip', confine: true, axisPointer: { type: 'line' },
        formatter: (items: Array<{ seriesId: string; dataIndex: number; value: number }>) => {
          const index = items[0]?.dataIndex;
          if (index === undefined) return '';
          const byKey = new Map(items.map((item) => [item.seriesId, item.value]));
          return renderChartTooltip(dayjs(Number(categories[index])).format('MM-DD HH:mm'), domain.map((key, rank) => {
            const value = byKey.get(key) ?? 0;
            return {
              name: labelOf(key), color: range[rank],
              value: `${formatTokens(value, tokenStyle)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}`,
              exact: `${formatTokensFull(value)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}`,
            };
          }));
        },
      },
      series: series.map((item) => ({
        id: item.id, name: labelOf(item.id), type: 'line', data: item.values,
        smooth: true, smoothMonotone: 'x', showSymbol: false, symbol: 'circle', symbolSize: 5,
        lineStyle: { color: range[domain.indexOf(item.id)], width: 1.75, cap: 'round', join: 'round' },
        itemStyle: { color: range[domain.indexOf(item.id)] },
        emphasis: { focus: 'series', lineStyle: { width: 2.5 } },
        blur: { lineStyle: { opacity: 0.15 }, itemStyle: { opacity: 0.15 } },
      })),
    };
  }, [groups, theme.palette, foldedLabel, tokenUnitLabel, tokenStyle, timeZone]);
  return <div className="model-trend"><EChart option={option} height={height} label={groups.map((group) => group.folded ? foldedLabel : group.model).join(', ')} onApplied={onApplied} /></div>;
});
