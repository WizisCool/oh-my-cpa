import React from 'react';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { ToolButton } from '../../../components/common/ToolButton';
import { EmptyState } from '../../../components/common/EmptyState';
import { tipCard } from '../../../components/common/tipCard';
import { HistoryOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatTokens } from '../../../types/tokenDisplay';
import { formatChange } from '../../../types/insightsFormat';
import type { TrendsMoverItem, TrendsUsageResponse } from '../../../types/trends';
import { TrendsValue, type TrendsIdentity } from '../useTrendsIdentity';
import styles from '../trends.module.css';

export interface MoversPanelProps {
  data: TrendsUsageResponse | undefined;
  /** Picks what the movers rank: model, key, client, provider or credential. */
  groupControl: React.ReactNode;
  isSelected: (id: string) => boolean;
  identity: TrendsIdentity;
  onSelect: (id: string) => void;
  eventsHref: (id: string) => string | null;
  onNavigate: (href: string) => void;
  isUnavailable?: boolean;
}

/**
 * The groups whose traffic moved most against their own baseline: risers on one side, fallers on
 * the other, each a ranked line. Every bar shares one scale across both sides, so a reader weighs
 * a fall against a rise at a glance: ink is what the group kept, hue is what moved. A name narrows
 * the whole page to it; the glyph opens its requests.
 */
export const MoversPanel: React.FC<MoversPanelProps> = ({ data, groupControl, isSelected, identity, onSelect, eventsHref, onNavigate, isUnavailable }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const metric = data?.movers.metric ?? 'net_tokens';
  const dimension = data?.group_by ?? 'model';
  const readings = (item: TrendsMoverItem) => (metric === 'net_tokens'
    ? { current: item.net_tokens, baseline: item.baseline_net_tokens, delta: item.delta_net_tokens }
    : { current: item.requests, baseline: item.baseline_requests, delta: item.delta_requests });
  const format = (value: number) => (metric === 'net_tokens' ? formatTokens(value, style) : value.toLocaleString('en'));
  const scale = React.useMemo(() => {
    const items = [...(data?.movers.risers ?? []), ...(data?.movers.fallers ?? [])];
    return Math.max(1, ...items.map((item) => (metric === 'net_tokens'
      ? Math.max(item.net_tokens, item.baseline_net_tokens)
      : Math.max(item.requests, item.baseline_requests))));
  }, [data, metric]);

  const row = (item: TrendsMoverItem) => {
    const { current, baseline, delta } = readings(item);
    const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : undefined;
    const name = identity.label(dimension, item);
    const href = item.filter_disabled ? null : eventsHref(item.id);
    // A group that appeared or went silent says so; a percent from or to nothing reads as noise.
    const relative = item.status === 'new' || item.status === 'quiet'
      ? t(`trends.movers.status.${item.status}`)
      : item.delta_percent === undefined ? null : formatChange(item.delta_percent / 100);
    const share = (value: number) => `${(Math.max(0, value) / scale) * 100}%`;
    return (
      <li key={item.id} className={styles['mover-row']} data-testid="trends-mover">
        <button type="button" className={styles['mover-name']} aria-pressed={isSelected(item.id)} disabled={item.filter_disabled} onClick={() => !item.filter_disabled && onSelect(item.id)}>
          <TrendsValue mark={identity.mark(dimension, item.id)} name={name} />
        </button>
        <span
          className={styles['mover-bar']}
          {...tipCard({
            heading: name,
            rows: [
              { label: t('trends.movers.current'), value: format(current) },
              { label: t('trends.movers.baseline'), value: format(baseline) },
            ],
          })}
        >
          <span className={styles['mover-kept']} style={{ width: share(Math.min(current, baseline)) }} />
          <span className={styles['mover-moved']} data-trend={trend} style={{ width: share(Math.abs(delta)) }} />
        </span>
        <b className={styles['mover-delta']} data-trend={trend}>
          {`${delta > 0 ? '+' : delta < 0 ? '−' : ''}${format(Math.abs(delta))}`}
        </b>
        <span className={styles['mover-relative']}>{relative}</span>
        <ToolButton
          size="sm"
          variant="ghost"
          className={styles['mover-requests']}
          icon={<HistoryOutlined />}
          label={t('trends.view_requests_of', { name })}
          disabled={!href}
          onClick={() => href && onNavigate(href)}
        />
      </li>
    );
  };

  const column = (key: 'risers' | 'fallers', items: readonly TrendsMoverItem[]) => (
    <section className={styles['movers-column']} data-testid={`trends-movers-${key}`}>
      <h3 className={styles['movers-heading']}>{t(`trends.movers.${key}`)}</h3>
      {items.length === 0 ? (
        <span className={styles['movers-empty']}>{t('trends.movers.none')}</span>
      ) : (
        <ul className={styles['mover-list']}>{items.map(row)}</ul>
      )}
    </section>
  );

  return (
    <Panel
      id="trends-movers"
      className={styles.section}
      data-testid="trends-movers"
      title={(
        <PanelTitle extra={groupControl}>
          {t('trends.movers.title', { metric: t(`trends.metric.${metric}`) })}
        </PanelTitle>
      )}
    >
      {!data && isUnavailable ? (
        <EmptyState size="compact" title={t('trends.unavailable')} />
      ) : !data ? (
        <div className="chart-placeholder" style={{ height: 180 }} aria-hidden="true" />
      ) : data.movers.risers.length === 0 && data.movers.fallers.length === 0 ? (
        <EmptyState size="compact" title={t('trends.movers.empty')} />
      ) : (
        <div className={styles.movers}>
          {column('risers', data.movers.risers)}
          {column('fallers', data.movers.fallers)}
        </div>
      )}
    </Panel>
  );
};
