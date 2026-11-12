import React from 'react';
import { Cell, Pie, PieChart } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { useTheme } from '../theme/ThemeContext';
import { RADIUS } from '../theme/radius';
import { ChartSurface } from './ChartSurface';
import { seriesColorRange, seriesDomainKey, seriesTrackColor, seriesGroupLabel } from './chartTheme';
import { formatModelShare, formatModelTokens, type DashboardModelUsage } from '../types/dashboardModels';
import { formatTokens, formatTokensFull } from '../types/tokenDisplay';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';

export interface ModelUsageDonutProps {
  groups: DashboardModelUsage[];
  totalTokens: number;
  focusedKey?: string | null;
  foldedLabel: string;
  unnamedLabel: string;
  tokenUnitLabel: string;
  onFocusGroup?: (key: string) => void;
  onClearFocus?: () => void;
}

export const ModelUsageDonut = React.memo<ModelUsageDonutProps>(({
  groups,
  totalTokens,
  focusedKey = null,
  foldedLabel,
  unnamedLabel,
  tokenUnitLabel,
  onFocusGroup,
  onClearFocus,
}) => {
  const { theme } = useTheme();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);

  const hasFocusedSlice =
    focusedKey !== null &&
    groups.some((group) => seriesDomainKey(group) === focusedKey && group.tokens > 0);

  const labelOf = React.useCallback(
    (key: string) =>
      seriesGroupLabel({ folded: key === 'folded', model: key.replace(/^model:/, '') }, foldedLabel, unnamedLabel),
    [foldedLabel, unnamedLabel],
  );

  const data = React.useMemo(
    () =>
      groups
        .map((group, index) => ({
          id: seriesDomainKey(group),
          name: labelOf(seriesDomainKey(group)),
          value: group.tokens,
          color: range[index],
        }))
        .filter((entry) => entry.value > 0),
    [groups, labelOf, range],
  );

  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    for (const item of data) {
      out[item.id] = { label: item.name, color: item.color };
    }
    return out;
  }, [data]);

  const activeGroup = groups.find((group) => seriesDomainKey(group) === focusedKey);
  const value = activeGroup?.tokens ?? totalTokens;
  const share = activeGroup ? formatModelShare(value, totalTokens) : undefined;
  const centerLabel = `${activeGroup ? `${labelOf(seriesDomainKey(activeGroup))}: ` : ''}${formatTokensFull(value)} ${tokenUnitLabel}${share ? ` (${share})` : ''}`;
  const didClickSliceRef = React.useRef(false);

  return (
    <div className="model-ring" role="img" aria-label={centerLabel}>
      <div
        className="model-ring-frame"
        onClick={() => {
          if (didClickSliceRef.current) {
            didClickSliceRef.current = false;
            return;
          }
          onClearFocus?.();
        }}
      >
        {data.length > 0 && (
          <ChartSurface height="100%" className="h-full w-full">
            <ChartContainer
              config={config}
              className="h-full w-full"
              initialDimension={{ width: 220, height: 220 }}
            >
              <PieChart>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      hideLabel
                      buildRows={(payload) => {
                        const slice = payload[0]?.payload as
                          | { id: string; name: string; value: number; color: string }
                          | undefined;
                        if (!slice) return null;
                        return {
                          rows: [
                            {
                              key: slice.id,
                              name: slice.name,
                              color: slice.color,
                              value: `${formatTokens(slice.value, tokenStyle)} ${tokenUnitLabel}`,
                              share: formatModelShare(slice.value, totalTokens),
                            },
                          ],
                        };
                      }}
                    />
                  }
                />
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="66%"
                  outerRadius="92%"
                  paddingAngle={data.length > 1 ? 1.5 : 0}
                  cornerRadius={RADIUS.xs}
                  stroke="none"
                  isAnimationActive={false}
                  onClick={(_, index) => {
                    const picked = data[index];
                    if (picked) {
                      didClickSliceRef.current = true;
                      onFocusGroup?.(picked.id);
                    }
                  }}
                >
                  {data.map((entry) => (
                    <Cell
                      key={entry.id}
                      fill={entry.color}
                      fillOpacity={hasFocusedSlice && entry.id !== focusedKey ? 0.32 : 1}
                      className="cursor-pointer"
                    />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
          </ChartSurface>
        )}
        <div className="model-ring-center">
          <span className="model-ring-total">{formatModelTokens(value, tokenStyle)}</span>
          <span className="model-ring-unit" aria-hidden="true">
            {share ?? tokenUnitLabel}
          </span>
        </div>
      </div>
      {data.length === 0 && (
        <span
          className="model-ring-track"
          style={{ borderColor: seriesTrackColor(theme.palette) }}
          aria-hidden="true"
        />
      )}
    </div>
  );
});
