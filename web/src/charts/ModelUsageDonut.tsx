import React from 'react';
import { useTheme } from '../theme/ThemeContext';
import { EChart, type EChartHandlers } from './echarts/EChart';
import type { EChartsCoreOption } from './echarts/core';
import { seriesColorRange, seriesDomainKey, seriesTrackColor, seriesGroupLabel } from './chartTheme';
import { formatModelShare, formatModelTokens, type DashboardModelUsage } from '../types/dashboardModels';
import { formatTokens, formatTokensFull } from '../types/tokenDisplay';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import { renderChartTooltip } from './chartTooltip';

export interface ModelUsageDonutProps {
  groups: DashboardModelUsage[];
  totalTokens: number;
  /** A pinned group stays fully opaque and owns the centre; every other slice remains in context. */
  focusedKey?: string | null;
  foldedLabel: string;
  unnamedLabel: string;
  tokenUnitLabel: string;
  /** A painted slice toggles its group; the background clears the focus. */
  onFocusGroup?: (key: string) => void;
  onClearFocus?: () => void;
}

/** The square frame and DOM readout share a centre, independent of the ranked list's height. */
export const ModelUsageDonut = React.memo<ModelUsageDonutProps>(({ groups, totalTokens, focusedKey = null, foldedLabel, unnamedLabel, tokenUnitLabel, onFocusGroup, onClearFocus }) => {
  const { theme } = useTheme();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);
  // A zero-token group stays in the ranked list but has no arc to emphasise. Dimming the whole ring
  // for it would turn a valid zero reading into what looks like a chart-wide disabled state.
  const hasFocusedSlice = focusedKey !== null && groups.some((group) => seriesDomainKey(group) === focusedKey && group.tokens > 0);
  // Zero-angle arcs carry no reading; zero groups still remain in the DOM ranking.
  const data = React.useMemo(() => groups.filter((group) => group.tokens > 0).map((group) => ({
    id: seriesDomainKey(group), name: seriesDomainKey(group), value: group.tokens,
    itemStyle: { color: range[groups.indexOf(group)], opacity: hasFocusedSlice && seriesDomainKey(group) !== focusedKey ? 0.35 : 1 },
  })), [groups, focusedKey, hasFocusedSlice, range]);
  const activeGroup = groups.find((group) => seriesDomainKey(group) === focusedKey);
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
      itemStyle: { borderRadius: 3 }, emphasis: { scaleSize: 4, itemStyle: { opacity: 1 } },
      animationDuration: 0,
    }],
  }), [data, labelOf, tokenStyle, tokenUnitLabel, totalTokens]);

  const handlers = React.useMemo<EChartHandlers>(() => ({
    click: (event) => {
      const key = (event as { name?: string }).name;
      if (key !== undefined) onFocusGroup?.(key);
    },
    backgroundClick: () => onClearFocus?.(),
  }), [onClearFocus, onFocusGroup]);

  const value = activeGroup?.tokens ?? totalTokens;
  const share = activeGroup ? formatModelShare(value, totalTokens) : undefined;
  const centerLabel = `${activeGroup ? `${labelOf(seriesDomainKey(activeGroup))}: ` : ''}${formatTokensFull(value)} ${tokenUnitLabel}${share ? ` · ${share}` : ''}`;
  return (
    <div className="model-ring" role="img" aria-label={centerLabel}>
      <div className="model-ring-frame">
        {data.length > 0 && <EChart option={option} label={`${formatTokensFull(totalTokens)} ${tokenUnitLabel}`} handlers={handlers} />}
        <div className="model-ring-center">
          <span className="model-ring-total">{formatModelTokens(value, tokenStyle)}</span>
          <span className="model-ring-unit" aria-hidden="true">{share ?? tokenUnitLabel}</span>
        </div>
      </div>
      {data.length === 0 && <span className="model-ring-track" style={{ borderColor: seriesTrackColor(theme.palette) }} aria-hidden="true" />}
    </div>
  );
});
