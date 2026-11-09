import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { AppModal } from '../../components/common/AppModal';
import { Meter } from '../../components/common/Meter';
import { PanelTitle } from '../../components/common/PanelTitle';
import { Tag } from '../../components/common/Tag';
import { HistoryOutlined, HourglassOutlined, InfoCircleOutlined, InsightsOutlined } from '../../components/icons';
import { useT } from '../../i18n';
import { formatTokens, type TokenNumberStyle } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { formatUsd } from '../../types/pricingDisplay';
import type { QuotaCapacityCycle, QuotaWindow } from '../../types/quota';
import { formatShortDateTime } from './quotaFormat';
import { describeQuotaCapacity, formatEstimatedUsd } from './quotaCapacity';
import type { QuotaCapacityOwner } from './QuotaCapacityButton';
import { quotaWindowGroupName, quotaWindowName } from './quotaWindowSelection';
import styles from './QuotaCapacityDialog.module.css';

export interface QuotaCapacityDialogProps {
  open: boolean;
  onClose: () => void;
  owner: QuotaCapacityOwner;
  window: QuotaWindow;
}

/** A dollar figure needs nearly every request priced; the server applies the same rule. */
const MIN_PRICED_SHARE = 0.95;

/** One card's figures, already formatted; null where the reading has none. */
interface CardFigures {
  cost: string | null;
  requests: string | null;
  tokens: string | null;
}

const EMPTY_FIGURES: CardFigures = { cost: null, requests: null, tokens: null };

/**
 * Three cards of one build: what the last window used, what this one has used so far, and what
 * this window holds in all. Cost, requests and tokens sit at the same height in each, so every
 * figure is read against its neighbours.
 */
export default function QuotaCapacityDialog({ open, onClose, owner, window }: QuotaCapacityDialogProps) {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const history = useQuery({
    queryKey: ['quota-capacity', owner.authIndex, window.id],
    queryFn: () => api.getQuotaCapacityHistory(owner.authIndex, window.id),
    enabled: open,
    staleTime: 30_000,
  });
  const used = window.used_percent ?? (window.remaining_percent == null ? undefined : 100 - window.remaining_percent);
  // The window itself carries this cycle's usage; the history read adds the cycle before it.
  const current: QuotaCapacityCycle | null = history.data?.current
    ?? (window.usage && window.reset_at_ms ? { from_ms: window.usage.from_ms, reset_at_ms: window.reset_at_ms, used_percent: used, usage: window.usage } : null);
  const previous = history.data?.previous ?? null;
  const { capacity } = window;
  const pendingNote = capacity ? null : describeQuotaCapacity(window, tokenStyle, t)?.note;
  const group = quotaWindowGroupName(window);

  return (
    <AppModal
      open={open}
      onCancel={onClose}
      footer={null}
      size="large"
      title={(
        <span className={styles['dialog-title']}>
          {owner.mark && <span className={styles['mark-tile']} aria-hidden="true">{owner.mark}</span>}
          <span className={styles['title-text']}>{t('quota.capacity_dialog_title', { window: quotaWindowName(window, t) })}</span>
        </span>
      )}
      description={group ? `${owner.credentialName} · ${group}` : owner.credentialName}
    >
      <div className={styles.cards} data-quota-capacity-dialog={window.id}>
        <Card
          icon={<HistoryOutlined />}
          title={t('quota.capacity_previous_window')}
          caption={previous
            ? cycleSpan(previous)
            : t(history.isError ? 'quota.capacity_reason_history_unavailable' : 'quota.capacity_no_previous')}
          figures={previous ? usageFigures(previous, tokenStyle) : EMPTY_FIGURES}
          isEmpty={!previous}
          isPending={history.isPending}
          foot={<UsedShare usedPercent={previous?.used_percent} />}
        />
        <Card
          icon={<HourglassOutlined />}
          title={t('quota.capacity_current_window')}
          caption={current ? cycleSpan(current) : t('quota.capacity_reason_no_traffic')}
          figures={current ? usageFigures(current, tokenStyle) : EMPTY_FIGURES}
          isEmpty={!current}
          foot={<UsedShare usedPercent={current?.used_percent ?? used} />}
        />
        <Card
          tone="forecast"
          icon={<InsightsOutlined />}
          title={t('quota.capacity_forecast_window')}
          caption={window.reset_at_ms ? t('quota.capacity_until', { when: formatShortDateTime(window.reset_at_ms) }) : ' '}
          figures={capacity ? {
            cost: capacity.cost_nanos == null ? null : `≈ ${formatEstimatedUsd(capacity.cost_nanos / 1e9, capacity.error_percent)}`,
            requests: `≈ ${Math.round(capacity.requests).toLocaleString()}`,
            tokens: `≈ ${formatTokens(capacity.tokens, tokenStyle)}`,
          } : EMPTY_FIGURES}
          isEmpty={!capacity}
          foot={(
            <>
              {capacity
                ? <span className={styles['foot-text']} title={t('quota.capacity_error_hint')}>{t('quota.capacity_margin', { n: Math.max(1, Math.round(capacity.error_percent)) })}</span>
                : <span className={styles['foot-text']}>{pendingNote ?? t('quota.capacity_reason_low_usage')}</span>}
              <Tag tone="accent" size="small" className={styles['foot-tag']}>{t('quota.capacity_forecast_tag')}</Tag>
            </>
          )}
        />
      </div>
      <div className={styles.note}>
        <InfoCircleOutlined className={styles['note-glyph']} />
        <span>{t('quota.capacity_hint')}</span>
      </div>
    </AppModal>
  );
}

function cycleSpan(cycle: QuotaCapacityCycle): string {
  return `${formatShortDateTime(cycle.from_ms)} – ${formatShortDateTime(cycle.reset_at_ms)}`;
}

function usageFigures(cycle: QuotaCapacityCycle, tokenStyle: TokenNumberStyle): CardFigures {
  const usage = cycle.usage;
  if (!usage) return EMPTY_FIGURES;
  return {
    cost: usage.requests > 0 && usage.priced_requests >= usage.requests * MIN_PRICED_SHARE ? formatUsd(usage.cost_nanos / 1e9) : null,
    requests: usage.requests.toLocaleString(),
    tokens: formatTokens(usage.tokens, tokenStyle),
  };
}

/**
 * One window's card: a PanelTitle head with its span over a rule, the cost large, requests and
 * tokens as ruled rows, and a foot. A card without a reading keeps every row with a dash for each
 * figure, so the three still line up and the empty one reads as "nothing yet" rather than a gap.
 */
function Card({ tone, icon, title, caption, figures, isEmpty, isPending = false, foot }: {
  tone?: 'forecast';
  icon: React.ReactNode;
  title: string;
  caption: string;
  figures: CardFigures;
  isEmpty: boolean;
  isPending?: boolean;
  foot: React.ReactNode;
}) {
  const t = useT();
  return (
    <section className={styles.card} data-tone={tone} data-empty={isEmpty || undefined} aria-label={title} aria-busy={isPending || undefined}>
      <header className={styles.head}>
        <PanelTitle icon={icon}>{title}</PanelTitle>
        <span className={styles.caption} title={caption}>{isPending ? '…' : caption}</span>
      </header>
      <div className={styles.lead}>
        <span className={styles.label}>{t('quota.capacity_spent')}</span>
        <span className={styles['lead-value']}>{figures.cost ?? '—'}</span>
      </div>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t('quota.capacity_requests')}</dt>
          <dd>{figures.requests ?? '—'}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t('quota.capacity_tokens_label')}</dt>
          <dd>{figures.tokens ?? '—'}</dd>
        </div>
      </dl>
      <footer className={styles.foot}>{foot}</footer>
    </section>
  );
}

function UsedShare({ usedPercent }: { usedPercent: number | undefined }) {
  const t = useT();
  const share = usedPercent == null ? null : Math.round(Math.min(Math.max(usedPercent, 0), 100));
  return (
    <>
      <Meter className={styles.meter} value={share ?? 0} />
      <span className={styles['foot-figure']}>{share == null ? '—' : t('quota.capacity_used_share', { n: share })}</span>
    </>
  );
}
