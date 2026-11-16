import { useInsightsFormat } from '../useInsightsFormat';
import { tipCard } from '../../../components/common/tipCard';
import { translateOr, type TFunc } from '../../../i18n/catalog';
import React from 'react';
import { Segmented } from '@/components/ui/segmented';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { LoadingRegion } from '../../../components/common/Placeholder';
import { ChartLinesPlaceholder } from '../../../components/common/PageLoading';
import { EmptyState } from '../../../components/common/EmptyState';
import { LoadFailure } from '../../../components/feedback';
import { useT } from '../../../i18n';
import { heatmapRampMix } from '../../../theme/heatmapRamp';
import type { InsightsRhythmCell, InsightsRhythmResponse } from '../../../types/insights';
import type { TokenScope } from '../../../types/insightsCube';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';

import { canShowWeekView, peakHourSet, summarizeRhythm } from '../insightsRhythm';
import { LazyInsightsHourChart as InsightsHourChart } from '../../../charts/lazyCharts';
import styles from '../insights.module.css';

type RhythmMeasure = 'requests' | 'tokens' | 'cost';

interface RhythmGridProps {
  data: InsightsRhythmResponse | undefined;
  /** What the panel measures; latency has no place on a volume scale, so it falls back to requests. */
  measure: RhythmMeasure;
  /** The scope tokens are read in; a server without the net column falls back to every token. */
  tokenScope?: TokenScope;
  isLoading: boolean;
  /** The demonstration captured this window unfiltered only; a filtered rhythm it never recorded is not faked. */
  isUncaptured: boolean;
  error?: unknown;
  onRetry?: () => void;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** A weekday's name in the reading language; a number the catalog does not name reads as itself. */
function weekdayLabel(t: TFunc, weekday: number): string {
  return translateOr(t, `insights.weekday.${weekday}`, String(weekday));
}
const LEGEND_STEPS = [0.08, 0.3, 0.55, 0.8, 1];
const clock = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`;

/**
 * When usage happens, in the deployment's calendar. It opens on the plainest form of the answer - one
 * bar per hour of the day, the busiest stretch drawn darker and marked on the chart itself - and for
 * a window of a week or more the weekday-by-hour grid is one switch away. The grid carries its own
 * scale, so a shade is never a guess.
 */
export const RhythmGrid: React.FC<RhythmGridProps> = ({ data, measure, tokenScope = 'all', isLoading, isUncaptured, error, onRetry }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const [chosenView, setView] = React.useState<'hours' | 'week'>('hours');
  const canShowWeek = Boolean(data) && canShowWeekView(data!.window);
  const view = canShowWeek ? chosenView : 'hours';
  // The net reading needs every cell's net column; a reply without it reads every token, labelled so.
  const hasNetTokens = Boolean(data?.cells?.length) && data!.cells.every((cell) => typeof cell.net_tokens === 'number');
  const isNet = measure === 'tokens' && tokenScope === 'net' && hasNetTokens;
  const metric = isNet ? 'net_tokens' : measure;
  const valueOf = React.useCallback((cell: InsightsRhythmCell) => {
    if (measure === 'cost') return cell.cost_nanos / 1e9;
    if (measure === 'tokens') return isNet ? cell.net_tokens! : cell.total_tokens;
    return cell.requests;
  }, [isNet, measure]);
  const summary = React.useMemo(() => summarizeRhythm(data?.cells ?? [], valueOf), [data, valueOf]);
  const peakHours = React.useMemo(() => peakHourSet(summary), [summary]);
  const cells = React.useMemo(() => new Map((data?.cells ?? []).map((cell) => [cell.weekday * 24 + cell.hour, cell])), [data]);
  const max = React.useMemo(() => Math.max(0, ...(data?.cells ?? []).map(valueOf)), [data, valueOf]);

  let body: React.ReactNode;
  if (isUncaptured) body = <EmptyState size="compact" title={t('insights.rhythm_uncaptured')} />;
  else if (error && !data) body = <LoadFailure title={t('insights.rhythm_error_title')} error={error} onRetry={onRetry} />;
  else if (!data && isLoading) body = <LoadingRegion><ChartLinesPlaceholder kind="rhythm" /></LoadingRegion>;
  else if (!data || summary.total <= 0) body = <EmptyState size="compact" title={t('insights.no_usage')} />;
  else if (view === 'hours') {
    body = (
      <React.Suspense fallback={<div className="chart-placeholder" style={{ height: 200 }} aria-hidden="true"><ChartLinesPlaceholder height={200} kind="trend" /></div>}>
        <InsightsHourChart
          values={summary.hours}
          peakHours={peakHours}
          peakLabel={t('insights.peak')}
          metric={metric}
          label={t('insights.rhythm_title')}
        />
      </React.Suspense>
    );
  } else {
    body = (
      <>
        <div className={styles['rhythm']} role="grid" aria-label={t('insights.rhythm_title')}>
          <span />
          {HOURS.map((hour) => (
            <span key={hour} className={styles['rhythm-hour']} aria-hidden="true">{hour % 3 === 0 ? clock(hour) : ''}</span>
          ))}
          {WEEKDAYS.map((weekday) => (
            <React.Fragment key={weekday}>
              <span className={styles['rhythm-day']}>{weekdayLabel(t, weekday)}</span>
              {HOURS.map((hour) => {
                const cell = cells.get(weekday * 24 + hour);
                const value = cell ? valueOf(cell) : 0;
                return (
                  <span
                    key={hour}
                    role="gridcell"
                    className={styles['rhythm-cell']}
                    data-empty={value <= 0 || undefined}
                    style={{ '--heatmap-quiet-share': heatmapRampMix(value, max).fromShare } as React.CSSProperties}
                    {...tipCard({
                      heading: `${weekdayLabel(t, weekday)} ${clock(hour)}–${clock(hour + 1)}`,
                      rows: [{ label: t(`insights.metric.${metric}`), value: formatMetric(metric, value, style) }],
                    })}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
        <div className={styles['scale-legend']} aria-hidden="true">
          <span>{t('insights.scale_less')}</span>
          {LEGEND_STEPS.map((step) => (
            <i key={step} className={styles['rhythm-cell']} style={{ '--heatmap-quiet-share': heatmapRampMix(step, 1).fromShare } as React.CSSProperties} />
          ))}
          <span>{t('insights.scale_more')}</span>
        </div>
      </>
    );
  }

  return (
    <Panel
      data-testid="insights-rhythm"
      title={(
        <PanelTitle
          extra={canShowWeek && (
            <Segmented
              size="sm"
              value={view}
              onChange={(next) => setView(next as 'hours' | 'week')}
              aria-label={t('insights.rhythm_view_label')}
              options={[
                { value: 'hours', label: t('insights.rhythm_view_hours') },
                { value: 'week', label: t('insights.rhythm_view_week') },
              ]}
            />
          )}
        >
          {t('insights.rhythm_title')}
        </PanelTitle>
      )}
    >
      {/* A refresh that failed leaves the last reading on screen, said so, with the retry beside it. */}
      {error && data && !isUncaptured ? (
        <LoadFailure tone="warning" title={t('insights.rhythm_error_title')} error={error} onRetry={onRetry} />
      ) : null}
      {body}
    </Panel>
  );
};
