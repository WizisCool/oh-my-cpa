import React from 'react';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { ToolButton } from '../../../components/common/ToolButton';
import { Tag } from '../../../components/common/Tag';
import { tipCard } from '../../../components/common/tipCard';
import { ArrowRightOutlined, CheckCircleOutlined, HistoryOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import type { InsightsBucket } from '../../../types/insights';
import type { TrendsSubstitutionPair, TrendsTelemetryResponse } from '../../../types/trends';
import { stabilityLanes, successRate, formatPercent, type StabilityLane } from '../trendsLogic';
import { ModelMark } from '../../../components/ModelMark';
import type { TrendsIdentity } from '../useTrendsIdentity';
import styles from '../trends.module.css';

const TOOLTIP_FORMATS: Record<InsightsBucket, string> = { hour: 'MM-DD HH:mm', day: 'YYYY-MM-DD', week: 'YYYY-MM-DD', month: 'YYYY-MM' };
const AXIS_FORMATS: Record<InsightsBucket, string> = { hour: 'MM-DD HH:mm', day: 'MM-DD', week: 'MM-DD', month: 'YYYY-MM' };
const PAIR_LIMIT = 6;
/** Past this many buckets the cells close up, so none of them thins to nothing. */
const DENSE_BUCKETS = 72;
/** The faintest a bucket with any event is drawn, so a single failure is never invisible. */
const MIN_WEIGHT = 22;

export interface StabilityPanelProps {
  data: TrendsTelemetryResponse | undefined;
  identity: TrendsIdentity;
  pairHref: (pair: TrendsSubstitutionPair) => string | null;
  onNavigate: (href: string) => void;
  isUnavailable?: boolean;
}

function laneTone(lane: StabilityLane): 'danger' | 'warn' {
  // A substitution served an answer; the other lanes are failures, and red stays with failure.
  return lane === 'model_substituted' ? 'warn' : 'danger';
}

/**
 * Failures and silent model substitutions as lanes over the window: a cell per bucket, as strong
 * as that bucket's count against the lane's busiest one. The substitutions read as pairs below -
 * what was asked for, what answered - each opening its requests.
 */
export const StabilityPanel: React.FC<StabilityPanelProps> = ({ data, identity, pairHref, onNavigate, isUnavailable }) => {
  useTimeZone();
  const t = useT();
  // A lane with nothing in it reads as a placeholder, so only the lanes that saw an event are drawn.
  const lanes = React.useMemo(() => (data ? stabilityLanes(data.buckets).filter((lane) => lane.total > 0) : []), [data]);
  const rate = data ? successRate(data.summary) : null;
  const bucket = (data?.window.bucket ?? 'day') as InsightsBucket;
  const starts = data?.buckets.map((item) => item.start_ms) ?? [];
  // A short window has fewer than three distinct buckets; each tick names a different one.
  const scale = starts.length > 0
    ? [...new Set([starts[0]!, starts[Math.floor((starts.length - 1) / 2)]!, starts[starts.length - 1]!])].map((ms) => dayjs(ms).format(AXIS_FORMATS[bucket]))
    : [];

  return (
    <Panel
      id="trends-stability"
      className={styles.section}
      data-testid="trends-stability"
      title={(
        <PanelTitle extra={rate === null ? undefined : <span className={styles['panel-meta']}>{t('trends.stability.success', { value: formatPercent(rate * 100) })}</span>}>
          {t('trends.stability.title')}
        </PanelTitle>
      )}
    >
      {!data && isUnavailable ? (
        <EmptyState size="compact" title={t('trends.unavailable')} />
      ) : !data ? (
        <div className="chart-placeholder" style={{ height: 180 }} aria-hidden="true" />
      ) : data.summary.total_requests === 0 ? (
        <EmptyState size="compact" title={t('trends.no_usage')} />
      ) : lanes.length === 0 && data.substitution_pairs.length === 0 ? (
        <div className={styles['stability-clear']} data-testid="trends-stability-clear">
          <CheckCircleOutlined className={styles['stability-clear-icon']} aria-hidden="true" />
          <span>{t('trends.stability.clear')}</span>
        </div>
      ) : (
        <div className={styles['panel-body']}>
          {lanes.length > 0 && (
            <div className={styles.lanes} role="list" aria-label={t('trends.stability.title')} data-dense={starts.length > DENSE_BUCKETS || undefined}>
              {lanes.map((lane) => (
                <div key={lane.lane} className={styles.lane} role="listitem" data-testid={`trends-lane-${lane.lane}`}>
                  <span className={styles['lane-label']}>{t(`trends.stability.lane.${lane.lane}`)}</span>
                  <span className={styles['lane-cells']}>
                    {lane.counts.map((count, index) => {
                      const start = data.buckets[index]?.start_ms ?? 0;
                      const weight = count === 0 || lane.max === 0 ? 0 : Math.round(MIN_WEIGHT + (100 - MIN_WEIGHT) * (count / lane.max));
                      return (
                        <span
                          key={start}
                          className={styles['lane-cell']}
                          data-tone={count > 0 ? laneTone(lane.lane) : undefined}
                          style={{ '--lane-weight': `${weight}%` } as React.CSSProperties}
                          {...tipCard({
                            heading: dayjs(start).format(TOOLTIP_FORMATS[bucket]),
                            rows: [{ label: t(`trends.stability.lane.${lane.lane}`), value: count.toLocaleString('en'), tone: count > 0 ? laneTone(lane.lane) : 'muted' }],
                          })}
                        />
                      );
                    })}
                  </span>
                  <span className={styles['lane-total']}>{lane.total.toLocaleString('en')}</span>
                </div>
              ))}
              {scale.length > 0 && (
                <div className={styles['lane-scale']} aria-hidden="true">
                  <span className={styles['lane-scale-ticks']}>
                    {scale.map((label, index) => <span key={index}>{label}</span>)}
                  </span>
                </div>
              )}
            </div>
          )}
          {data.substitution_pairs.length > 0 && (
            <div className={styles['pairs-section']}>
              <h3 className={styles['pairs-heading']}>{t('trends.stability.pairs')}</h3>
              <ul className={styles.pairs} data-testid="trends-substitutions">
                {data.substitution_pairs.slice(0, PAIR_LIMIT).map((pair) => {
                  const href = pairHref(pair);
                  return (
                    <li key={`${pair.provider}\u0000${pair.requested_model}\u0000${pair.served_model}`} className={styles['pair-row']}>
                      <span className={styles['pair-models']}>
                        <ModelMark model={pair.requested_model} size={15} />
                        <span className={styles['pair-model']} data-tip={pair.requested_model} data-tip-overflow="">{pair.requested_model}</span>
                        <ArrowRightOutlined className={styles['pair-arrow']} aria-label={t('trends.stability.served_as')} />
                        <ModelMark model={pair.served_model} size={15} />
                        <span className={`${styles['pair-model']} ${styles['pair-served']}`} data-tip={pair.served_model} data-tip-overflow="">{pair.served_model}</span>
                      </span>
                      <span className={styles['pair-provider']}>{pair.provider && <Tag size="small" icon={identity.mark('provider', pair.provider)}>{identity.label('provider', pair.provider)}</Tag>}</span>
                      <span className={styles['pair-count']}>{t('trends.stability.pair_count', { n: pair.count })}</span>
                      <ToolButton
                        size="sm"
                        variant="ghost"
                        icon={<HistoryOutlined />}
                        label={t('trends.view_requests_of', { name: pair.requested_model })}
                        disabled={!href}
                        onClick={() => href && onNavigate(href)}
                        data-testid="trends-substitution-events"
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
};
