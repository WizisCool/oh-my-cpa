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
  /** A non-empty subset draws only those slices, while every group keeps its ranked colour. */
  visibleKeys: readonly string[];
  foldedLabel: string;
  unnamedLabel: string;
  tokenUnitLabel: string;
  /** A painted slice selects its group; the background clears the selection. */
  onSelectGroup?: (key: string | null) => void;
}

/** The square frame and DOM readout share a centre, independent of the ranked list's height. */
export const ModelUsageDonut = React.memo<ModelUsageDonutProps>(({ groups, visibleKeys, foldedLabel, unnamedLabel, tokenUnitLabel, onSelectGroup }) => {
  const { theme } = useTheme();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null);
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);
  const visibleGroups = React.useMemo(
    () => (visibleKeys.length ? groups.filter((group) => visibleKeys.includes(seriesDomainKey(group))) : groups),
    [groups, visibleKeys],
  );
  const visibleTotal = React.useMemo(() => visibleGroups.reduce((sum, group) => sum + group.tokens, 0), [visibleGroups]);
  // Zero-angle arcs carry no reading; zero groups still remain in the DOM ranking.
  const data = React.useMemo(() => visibleGroups.filter((group) => group.tokens > 0).map((group) => ({
    id: seriesDomainKey(group), name: seriesDomainKey(group), value: group.tokens,
    itemStyle: { color: range[groups.indexOf(group)] },
  })), [visibleGroups, groups, range]);
  const activeGroup = visibleGroups.find((group) => seriesDomainKey(group) === hoveredKey);
  const labelOf = React.useCallback((key: string) => seriesGroupLabel({ folded: key === 'folded', model: key.replace(/^model:/, '') }, foldedLabel, unnamedLabel), [foldedLabel, unnamedLabel]);
  const option = React.useMemo<EChartsCoreOption>(() => ({
    tooltip: {
      trigger: 'item', className: 'omc-echart-tip', confine: true,
      formatter: (item: { name: string; value: number; color: string }) => renderChartTooltip(undefined, [{
        name: labelOf(item.name), color: item.color,
        value: `${formatTokens(item.value, tokenStyle)} ${tokenUnitLabel}`,
        exact: `${formatTokensFull(item.value)} ${tokenUnitLabel}`,
        share: formatModelShare(item.value, visibleTotal),
      }]),
    },
    series: [{
      id: 'model-usage', type: 'pie', data, radius: ['66%', '92%'], padAngle: 1.5,
      left: 16, right: 16, top: 16, bottom: 16, clockwise: false,
      label: { show: false }, labelLine: { show: false },
      itemStyle: { borderRadius: 3 }, emphasis: { scaleSize: 4 },
      animationDuration: 0,
    }],
  }), [data, labelOf, tokenStyle, tokenUnitLabel, visibleTotal]);

  React.useEffect(() => {
    if (hoveredKey && !visibleGroups.some((group) => seriesDomainKey(group) === hoveredKey)) setHoveredKey(null);
  }, [hoveredKey, visibleGroups]);
  const handlers = React.useMemo<EChartHandlers>(() => ({
    mouseover: (event) => {
      const key = (event as { name?: string }).name;
      if (key !== undefined) setHoveredKey(key);
    },
    mouseout: () => setHoveredKey(null),
    click: (event) => {
      const key = (event as { name?: string }).name;
      if (key !== undefined) onSelectGroup?.(key);
    },
    backgroundClick: () => onSelectGroup?.(null),
  }), [onSelectGroup]);

  const value = activeGroup?.tokens ?? visibleTotal;
  const share = activeGroup ? formatModelShare(value, visibleTotal) : undefined;
  const centerLabel = `${activeGroup ? `${labelOf(seriesDomainKey(activeGroup))}: ` : ''}${formatTokensFull(value)} ${tokenUnitLabel}${share ? ` · ${share}` : ''}`;
  return (
    <div className="model-ring" role="img" aria-label={centerLabel}>
      <div className="model-ring-frame">
        {data.length > 0 && <EChart option={option} label={`${formatTokensFull(visibleTotal)} ${tokenUnitLabel}`} handlers={handlers} />}
        <div className="model-ring-center">
          <span className="model-ring-total">{formatModelTokens(value, tokenStyle)}</span>
          <span className="model-ring-unit" aria-hidden="true">{share ?? tokenUnitLabel}</span>
        </div>
      </div>
      {data.length === 0 && <span className="model-ring-track" style={{ borderColor: seriesTrackColor(theme.palette) }} aria-hidden="true" />}
    </div>
  );
});
