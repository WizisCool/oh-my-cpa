import React from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { useMorphedProps } from '../../../charts/useChartMorph';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatTokens } from '../../../types/tokenDisplay';
import { COLUMN_CAP } from '../../../charts/stackCap';
import { formatPercent, type QuotaCycleBar } from '../trendsLogic';

export interface QuotaCyclesChartProps {
  cycles: readonly QuotaCycleBar[];
  measure: 'net_tokens' | 'requests';
  label: string;
  height?: number;
}

/**
 * Each cycle's real use beside what its whole window would have held at the rate it was measured:
 * the capacity a plan actually delivered, cycle over cycle. The scaled bar is the quieter mark.
 */
const QuotaCyclesChartView: React.FC<QuotaCyclesChartProps> = ({ cycles, measure, label, height = 260 }) => {
  useTimeZone();
  const t = useT();
  const { theme } = useTheme();
  const { style } = useTokenDisplayStyle();
  const format = React.useCallback(
    (value: number) => (measure === 'net_tokens' ? formatTokens(value, style) : value.toLocaleString('en')),
    [measure, style],
  );
  const data = React.useMemo(() => cycles.map((cycle, index) => ({ ...cycle, index })), [cycles]);
  const config = React.useMemo<ChartConfig>(() => ({
    actual: { label: t('trends.quota.cycle_actual'), color: theme.palette.series[0] },
    full: { label: t('trends.quota.cycle_full'), color: theme.palette.muted },
  }), [t, theme.palette.muted, theme.palette.series]);

  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={label}
      data-testid="trends-quota-cycles"
      style={{ height }}
      initialDimension={{ width: 760, height }}
    >
      <BarChart data={data} margin={{ top: 14, right: 12, bottom: 4, left: 4 }} barGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="index"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tickFormatter={(index: number) => {
            const cycle = data[index];
            return cycle ? dayjs(cycle.start).format('MM-DD') : '';
          }}
        />
        <YAxis width={56} tickCount={4} tickLine={false} axisLine={false} tickFormatter={(value: number) => format(value)} />
        <ChartTooltip
          isPinnedTop
          content={(
            <ChartTooltipContent
              buildRows={(payload) => {
                const cycle = payload[0]?.payload as (QuotaCycleBar & { index: number }) | undefined;
                if (!cycle) return null;
                return {
                  heading: `${dayjs(cycle.start).format('MM-DD HH:mm')} – ${dayjs(cycle.reset).format('MM-DD HH:mm')}`,
                  rows: [
                    { key: 'used', name: t('trends.quota.used'), value: formatPercent(cycle.usedPercent) },
                    { key: 'actual', name: t('trends.quota.cycle_actual'), color: theme.palette.series[0], value: format(cycle.actual) },
                    { key: 'full', name: t('trends.quota.cycle_full'), color: theme.palette.muted, value: cycle.full === null ? '—' : format(cycle.full) },
                    ...(cycle.isCurrent ? [{ key: 'current', value: t('trends.quota.cycle_current'), tone: 'muted' as const }] : []),
                  ],
                  notes: cycle.isApproximate ? [t('trends.quota.approximate_hint')] : undefined,
                };
              }}
            />
          )}
        />
        <Bar dataKey="actual" fill={theme.palette.series[0]} maxBarSize={22} radius={COLUMN_CAP} isAnimationActive={false} />
        <Bar dataKey="full" fill={theme.palette.muted} fillOpacity={0.45} maxBarSize={22} radius={COLUMN_CAP} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
};

const QuotaCyclesChartPlot = React.memo(QuotaCyclesChartView);
export const QuotaCyclesChart = React.memo<QuotaCyclesChartProps>((props) => {
  const { shown, scopeRef } = useMorphedProps(props);
  return (
    <div ref={scopeRef} className="omc-chart-morph">
      <QuotaCyclesChartPlot {...shown} />
    </div>
  );
});
QuotaCyclesChart.displayName = 'QuotaCyclesChart';
export default QuotaCyclesChart;
