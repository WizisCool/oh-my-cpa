import React from 'react';
import { Area, AreaChart, XAxis, YAxis } from 'recharts';
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
import { sparkColor, type ChartTone } from './chartTheme';
import type { DashboardSeriesPoint } from '../types/dashboard';

export interface DashboardTrendChartProps {
  points: DashboardSeriesPoint[];
  ariaLabel: string;
  pick: (point: DashboardSeriesPoint) => number;
  tone?: ChartTone;
  height?: number;
  label?: (timeMs: number) => string;
  format?: (value: number) => string;
}

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

export const DashboardTrendChart: React.FC<DashboardTrendChartProps> = ({
  points,
  pick,
  ariaLabel,
  tone = 'accent',
  height = 46,
  label,
  format,
}) => {
  useTimeZone();
  const { theme } = useTheme();
  const { isReducedMotion } = useMotionPreference();
  const gradientId = React.useId().replace(/:/g, '');
  const color = sparkColor(theme.palette, tone);

  const data = React.useMemo(
    () =>
      points.map((point) => ({
        t: point.t,
        value: Math.max(0, pick(point) ?? 0),
      })),
    [points, pick],
  );

  const config = React.useMemo<ChartConfig>(
    () => ({ value: { color } }),
    [color],
  );

  if (data.length < 2) {
    return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
  }

  return (
    <div className="chart-slot" style={{ minHeight: height }}>
      <ChartSurface height={height} priority="p0">
        <ChartContainer
          config={config}
          role="img"
          aria-label={ariaLabel}
          className="h-full w-full"
          initialDimension={{ width: 240, height }}
        >
          <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 2, left: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.2} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="t" hide />
            <YAxis domain={[0, 'auto']} hide />
            <ChartTooltip
              isPinnedTop
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              content={
                <ChartTooltipContent
                  buildRows={(payload) => {
                    const entry = payload[0]?.payload as { t: number; value: number } | undefined;
                    if (!entry) return null;
                    // One number per readout: the compact figure the tile prints. Its exact twin beside
                    // it repeated the same value in a second spelling and halved the readout's legibility.
                    const display = format?.(entry.value) ?? PLAIN_NUMBER_FORMAT.format(entry.value);
                    return {
                      heading: (label ?? ((at: number) => dayjs(at).format('MM-DD HH:mm')))(entry.t),
                      rows: [{ color, value: display }],
                    };
                  }}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
              isAnimationActive={!isReducedMotion}
              animationDuration={180}
            />
          </AreaChart>
        </ChartContainer>
      </ChartSurface>
    </div>
  );
};
