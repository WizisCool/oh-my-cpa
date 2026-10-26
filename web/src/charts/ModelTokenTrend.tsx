import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import dayjs from '../utils/time';
import { renderChartTooltip } from './chartTooltip';
import { buildModelTrendSeries } from './modelTrendData';
import { useTheme } from '../theme/ThemeContext';
import { EChart } from './echarts/EChart';
import type { EChartsCoreOption } from './echarts/core';
import { seriesColorRange, seriesDomainKey, seriesGroupLabel } from './chartTheme';
import { currentFontStack } from '../theme/fontLibrary';
import { formatTokens, formatTokensFull } from '../types/tokenDisplay';
import type { DashboardModelUsage } from '../types/dashboardModels';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';

export interface ModelTokenTrendProps {
  groups: DashboardModelUsage[];
  /** A pinned group is emphasised while every other line stays painted for comparison. */
  focusedKey?: string | null;
  foldedLabel: string;
  unnamedLabel: string;
  tokenUnitLabel?: string;
  height?: number;
  /** A painted line toggles its group; the background clears the focus. */
  onFocusGroup?: (key: string) => void;
  onClearFocus?: () => void;
}

/** Lines separate overlapping model readings; their DOM legend owns the ranked color assignment. */
export const ModelTokenTrend = React.memo<ModelTokenTrendProps>(({
  groups, focusedKey = null, foldedLabel, unnamedLabel, tokenUnitLabel = '', height = 260, onFocusGroup, onClearFocus,
}) => {
  const timeZone = useTimeZone();
  const { theme } = useTheme();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const option = React.useMemo<EChartsCoreOption>(() => {
    const { categories, series } = buildModelTrendSeries(groups);
    const domain = groups.map(seriesDomainKey);
    const range = seriesColorRange(theme.palette, groups);
    const colorIndex = new Map(groups.map((group, index) => [seriesDomainKey(group), index]));
    const hasFocus = focusedKey !== null;
    const labelOf = (key: string) => seriesGroupLabel({ folded: key === 'folded', model: key.replace(/^model:/, '') }, foldedLabel, unnamedLabel);
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
          return renderChartTooltip(dayjs(Number(categories[index])).format('MM-DD HH:mm'), domain.map((key) => {
            const value = byKey.get(key) ?? 0;
            return {
              name: labelOf(key), color: range[colorIndex.get(key) ?? 0],
              value: `${formatTokens(value, tokenStyle)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}`,
              exact: `${formatTokensFull(value)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}`,
            };
          }));
        },
      },
      series: series.map((item) => {
        const isFocused = item.id === focusedKey;
        const isDimmed = hasFocus && !isFocused;
        return {
          id: item.id, name: labelOf(item.id), type: 'line', data: item.values,
          smooth: true, smoothMonotone: 'x', showSymbol: false, symbol: 'circle', symbolSize: 5,
          triggerEvent: 'line',
          lineStyle: {
            color: range[colorIndex.get(item.id) ?? 0], width: isFocused ? 2.75 : 1.75,
            opacity: isDimmed ? 0.35 : 1, cap: 'round', join: 'round',
          },
          itemStyle: { color: range[colorIndex.get(item.id) ?? 0], opacity: isDimmed ? 0.4 : 1 },
          emphasis: { focus: 'series', lineStyle: { width: 2.5, opacity: 1 }, itemStyle: { opacity: 1 } },
          blur: { lineStyle: { opacity: 0.15 }, itemStyle: { opacity: 0.15 } },
        };
      }),
    };
  }, [groups, focusedKey, theme.palette, foldedLabel, unnamedLabel, tokenUnitLabel, tokenStyle, timeZone]);
  const seriesIds = React.useMemo(
    () => (option.series as Array<{ id: string }>).map((series) => series.id),
    [option],
  );
  const handlers = React.useMemo(() => ({
    backgroundClick: () => onClearFocus?.(),
    click: (params: unknown) => {
      const item = params as { seriesId?: string; seriesIndex?: number };
      const key = item.seriesId ?? (item.seriesIndex === undefined ? undefined : seriesIds[item.seriesIndex]);
      if (key !== undefined) onFocusGroup?.(key);
    },
  }), [onClearFocus, onFocusGroup, seriesIds]);
  return <div className="model-trend"><EChart option={option} height={height} label={groups.map((group) => seriesGroupLabel(group, foldedLabel, unnamedLabel)).join(', ')} handlers={handlers} /></div>;
});
