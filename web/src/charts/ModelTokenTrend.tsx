import React from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { useMotionPreference } from '@/utils/motionPreference';
import dayjs from '../utils/time';
import { useTimeZone } from '../utils/TimeZoneProvider';
import { useTheme } from '../theme/ThemeContext';
import { ChartSurface } from './ChartSurface';
import { buildModelTrendSeries } from './modelTrendData';
import { seriesColorRange, seriesDomainKey, seriesGroupLabel } from './chartTheme';
import { formatTokens, formatTokensFull } from '../types/tokenDisplay';
import type { DashboardModelUsage } from '../types/dashboardModels';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';

export interface ModelTokenTrendProps {
  groups: DashboardModelUsage[];
  focusedKey?: string | null;
  foldedLabel: string;
  unnamedLabel: string;
  tokenUnitLabel?: string;
  height?: number;
  onFocusGroup?: (key: string) => void;
  onClearFocus?: () => void;
}

export const ModelTokenTrend = React.memo<ModelTokenTrendProps>(({
  groups,
  focusedKey = null,
  foldedLabel,
  unnamedLabel,
  tokenUnitLabel = '',
  height,
  onFocusGroup,
  onClearFocus,
}) => {
  useTimeZone();
  const { theme } = useTheme();
  const { isReducedMotion } = useMotionPreference();
  const { style: tokenStyle } = useTokenDisplayStyle();

  const { categories, series } = React.useMemo(() => buildModelTrendSeries(groups), [groups]);
  const domain = React.useMemo(() => groups.map(seriesDomainKey), [groups]);
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);

  const labelOf = React.useCallback(
    (key: string) =>
      seriesGroupLabel({ folded: key === 'folded', model: key.replace(/^model:/, '') }, foldedLabel, unnamedLabel),
    [foldedLabel, unnamedLabel],
  );

  const labelFormat =
    categories.length > 1 && Number(categories.at(-1)) - Number(categories[0]) > 24 * 60 * 60 * 1000
      ? 'MM-DD'
      : 'HH:mm';

  const tickValues = React.useMemo(() => {
    if (categories.length === 0) return [];
    const count = Math.min(4, categories.length);
    const indices = new Set(
      Array.from({ length: count }, (_, idx) =>
        Math.round((idx * (categories.length - 1)) / Math.max(1, count - 1)),
      ),
    );
    return Array.from(indices).map((i) => categories[i]!);
  }, [categories]);

  const data = React.useMemo(
    () =>
      categories.map((cat, idx) => {
        const row: Record<string, string | number> = { t: cat };
        for (const item of series) {
          row[item.id] = item.values[idx] ?? 0;
        }
        return row;
      }),
    [categories, series],
  );

  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    groups.forEach((group, idx) => {
      const key = seriesDomainKey(group);
      out[key] = { label: labelOf(key), color: range[idx] };
    });
    return out;
  }, [groups, labelOf, range]);

  const hasFocus = focusedKey !== null;
  const didClickSeriesRef = React.useRef(false);

  return (
    <div className="model-trend">
      <ChartSurface height={height ?? '100%'}>
        <ChartContainer
          config={config}
          role="img"
          aria-label={groups.map((group) => seriesGroupLabel(group, foldedLabel, unnamedLabel)).join(', ')}
          className="h-full w-full"
          style={height ? { height } : undefined}
          initialDimension={{ width: 480, height: height ?? 210 }}
          onClick={() => {
            if (didClickSeriesRef.current) {
              didClickSeriesRef.current = false;
              return;
            }
            onClearFocus?.();
          }}
        >
          <LineChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="t"
              ticks={tickValues}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              tickFormatter={(value: string) => dayjs(Number(value)).format(labelFormat)}
            />
            <YAxis domain={[0, 'auto']} hide />
            <ChartTooltip
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              content={
                <ChartTooltipContent
                  buildRows={(payload) => {
                    const row = payload[0]?.payload as Record<string, string | number> | undefined;
                    if (!row) return null;
                    const suffix = tokenUnitLabel ? ` ${tokenUnitLabel}` : '';
                    return {
                      heading: dayjs(Number(row.t)).format('MM-DD HH:mm'),
                      rows: domain.map((key, idx) => {
                        const val = Number(row[key] ?? 0);
                        const display = `${formatTokens(val, tokenStyle)}${suffix}`;
                        const exact = `${formatTokensFull(val)}${suffix}`;
                        return {
                          key,
                          name: labelOf(key),
                          color: range[idx],
                          value: display,
                          note: exact !== display ? exact : undefined,
                        };
                      }),
                    };
                  }}
                />
              }
            />
            {series.map((item) => {
              const color = config[item.id] && 'color' in config[item.id]! ? config[item.id]!.color : theme.palette.accent;
              const isFocused = item.id === focusedKey;
              const isDimmed = hasFocus && !isFocused;
              return (
                <Line
                  key={item.id}
                  type="monotone"
                  dataKey={item.id}
                  name={labelOf(item.id)}
                  stroke={color}
                  strokeWidth={isFocused ? 2.5 : 1.75}
                  strokeOpacity={isDimmed ? 0.28 : 1}
                  dot={false}
                  activeDot={{
                    r: 3.5,
                    fill: color,
                    strokeWidth: 0,
                    onClick: () => {
                      didClickSeriesRef.current = true;
                      onFocusGroup?.(item.id);
                    },
                  }}
                  onClick={() => {
                    didClickSeriesRef.current = true;
                    onFocusGroup?.(item.id);
                  }}
                  isAnimationActive={!isReducedMotion}
                  animationDuration={180}
                />
              );
            })}
          </LineChart>
        </ChartContainer>
      </ChartSurface>
    </div>
  );
});
