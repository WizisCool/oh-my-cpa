import React from 'react';
import { MetaLine } from '../../components/common/MetaLine';
import { useQuery } from '@tanstack/react-query';
import { Segmented } from '@/components/ui/segmented';
import { api } from '../../api/client';
import { AppModal } from '../../components/common/AppModal';
import { Meter } from '../../components/common/Meter';
import { PanelTitle } from '../../components/common/PanelTitle';
import { Tag } from '../../components/common/Tag';
import { RollingNumber } from '../../components/dashboard/RollingNumber';
import { HistoryOutlined, HourglassOutlined, InfoCircleOutlined, InsightsOutlined } from '../../components/icons';
import { useT } from '../../i18n';
import { cacheScaleMix } from '../../theme/cacheScale';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import type { QuotaCapacityCycle, QuotaSubscriptionPeriod, QuotaWindow, QuotaWindowCapacity } from '../../types/quota';
import type { RollingReadout } from '../../types/rollingNumber';
import { formatShortDateTime } from './quotaFormat';
import {
  type CycleCardFigures,
  describeCapacityCard,
  quotaCapacityNote,
  formatCycleCardFigures,
  subscriptionProjectionNote,
  supportsSubscriptionCycleTab,
} from './quotaCapacity';
import type { QuotaCapacityOwner } from './QuotaCapacityButton';
import { quotaWindowGroupName, siblingCapacityWindows } from './quotaWindowSelection';
import { quotaDetailWindowName } from '../oauthManagement/credentialSections';
import styles from './QuotaCapacityDialog.module.css';

export const SUBSCRIPTION_CYCLE_TAB = '__subscription_cycle__';

export interface QuotaCapacityDialogProps {
  open: boolean;
  onClose: () => void;
  owner: QuotaCapacityOwner;
  window?: QuotaWindow;
  windows?: readonly QuotaWindow[];
  /** Starts on the subscription billing-cycle view instead of a rate-limit window. */
  initialTab?: 'subscription_cycle';
}

/** Recorded consumption, estimated full-window capacity, and subscription-cycle totals share one period switcher. */
export default function QuotaCapacityDialog({ open, onClose, owner, window, windows, initialTab }: QuotaCapacityDialogProps) {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const siblingWindows = React.useMemo(
    () => (window ? siblingCapacityWindows(window, windows) : []),
    [window, windows],
  );
  const canShowSubscriptionTab = supportsSubscriptionCycleTab(window, Boolean(owner.hasSubscriptionCycle));
  const defaultTab = canShowSubscriptionTab && (initialTab === 'subscription_cycle' || !window)
    ? SUBSCRIPTION_CYCLE_TAB
    : window?.id ?? SUBSCRIPTION_CYCLE_TAB;

  const [selectedTab, setSelectedTab] = React.useState(defaultTab);
  const [prevTrigger, setPrevTrigger] = React.useState({ open, defaultTab });
  if (prevTrigger.open !== open || prevTrigger.defaultTab !== defaultTab) {
    const openedFresh = open && !prevTrigger.open;
    const triggerChanged = prevTrigger.defaultTab !== defaultTab;
    setPrevTrigger({ open, defaultTab });
    if (openedFresh || triggerChanged) {
      setSelectedTab(defaultTab);
    }
  }

  const isSubscriptionTab = canShowSubscriptionTab && (selectedTab === SUBSCRIPTION_CYCLE_TAB || !window);
  const activeWindow = siblingWindows.find((candidate) => candidate.id === selectedTab) ?? window;

  const history = useQuery({
    queryKey: ['quota-capacity', owner.authIndex, activeWindow?.id ?? ''],
    queryFn: () => api.getQuotaCapacityHistory(owner.authIndex, activeWindow!.id),
    enabled: open && !isSubscriptionTab && Boolean(activeWindow),
    staleTime: 30_000,
  });

  const subscription = useQuery({
    queryKey: ['quota-subscription-cycle', owner.authIndex],
    queryFn: () => api.getQuotaSubscriptionCycle(owner.authIndex),
    enabled: open && isSubscriptionTab,
    staleTime: 30_000,
  });

  const tabOptions = [
    ...siblingWindows.map((candidate) => ({
      value: candidate.id,
      label: quotaDetailWindowName(candidate, t, siblingWindows),
    })),
    ...(canShowSubscriptionTab
      ? [{ value: SUBSCRIPTION_CYCLE_TAB, label: t('quota.subscription_cycle_tab') }]
      : []),
  ];

  const titleWindowLabel = isSubscriptionTab
    ? t('quota.subscription_cycle_tab')
    : activeWindow
      ? quotaDetailWindowName(activeWindow, t, siblingWindows)
      : t('quota.subscription_cycle_tab');

  const group = !isSubscriptionTab && activeWindow ? quotaWindowGroupName(activeWindow) : null;

  // Rate-limit window state
  const used = activeWindow
    ? activeWindow.used_percent
      ?? (activeWindow.remaining_percent == null ? undefined : 100 - activeWindow.remaining_percent)
    : undefined;
  const current: QuotaCapacityCycle | null = history.data?.current
    ?? (activeWindow?.usage && activeWindow.reset_at_ms
      ? { from_ms: activeWindow.usage.from_ms, reset_at_ms: activeWindow.reset_at_ms, used_percent: used, usage: activeWindow.usage }
      : null);
  const previous = history.data?.previous ?? null;
  const currentUsed = current?.used_percent ?? used;
  const activeCapacity: QuotaWindowCapacity | null = history.isError
    ? null
    : history.data
      ? history.data.capacity ?? null
      : activeWindow?.capacity ?? null;
  const pendingNote = quotaCapacityNote(
    history.isError ? 'usage_unavailable' : history.data?.capacity_unavailable ?? activeWindow?.capacity_unavailable,
    t,
  );
  const forecastFigures = describeCapacityCard(activeCapacity, tokenStyle, t);
  const untilText = activeWindow?.reset_at_ms
    ? t('quota.capacity_until', { when: formatShortDateTime(activeWindow.reset_at_ms) })
    : null;
  const forecastCaption = activeCapacity?.basis === 'previous_window'
    ? t('quota.capacity_from_previous')
    : untilText ?? '\u00a0';

  // Subscription billing-cycle state
  const subCurrent = subscription.isError ? null : subscription.data?.current ?? null;
  const subPrevious = subscription.isError ? null : subscription.data?.previous ?? null;
  const subProjection: QuotaWindowCapacity | null = subscription.isError ? null : subscription.data?.projection ?? null;
  const subPendingNote = subscriptionProjectionNote(
    subscription.isError ? 'usage_unavailable' : subscription.data?.projection_unavailable,
    t,
  );
  const subProjectionFigures = describeCapacityCard(subProjection, tokenStyle, t);
  const subUntilCaption = subCurrent
    ? t('quota.capacity_until', { when: formatShortDateTime(subCurrent.to_ms) })
    : '\u00a0';

  // Keep one stable three-card DOM tree across all period tabs so RollingNumber and Meter
  // stay mounted without layout remounts or height shifts when switching tabs.
  const previousCard = isSubscriptionTab
    ? {
      title: t('quota.subscription_previous_cycle'),
      caption: subPrevious
        ? subscriptionSpan(subPrevious)
        : t(subscription.isError ? 'quota.capacity_reason_history_unavailable' : 'quota.subscription_no_previous'),
      figures: formatCycleCardFigures(asCapacityCycle(subPrevious), tokenStyle, t),
      isEmpty: !subPrevious,
      isPending: subscription.isPending,
      foot: (
        <span className={styles['foot-figure']}>
          {subPrevious ? t('quota.subscription_completed') : '—'}
        </span>
      ),
    }
    : {
      title: t('quota.capacity_previous_window'),
      caption: previous
        ? cycleSpan(previous)
        : t(history.isError ? 'quota.capacity_reason_history_unavailable' : 'quota.capacity_no_previous'),
      figures: formatCycleCardFigures(previous, tokenStyle, t),
      isEmpty: !previous,
      isPending: history.isPending,
      foot: <UsedShare usedPercent={previous?.used_percent} />,
    };

  const currentCard = isSubscriptionTab
    ? {
      title: t('quota.subscription_current_cycle'),
      caption: subCurrent
        ? subscriptionSpan(subCurrent)
        : t(subscription.isError ? 'quota.capacity_reason_usage_unavailable' : 'quota.capacity_reason_no_traffic'),
      figures: formatCycleCardFigures(asCapacityCycle(subCurrent), tokenStyle, t),
      isEmpty: !subCurrent,
      isPending: subscription.isPending,
      foot: <ElapsedShare elapsedPercent={subCurrent?.elapsed_percent} />,
    }
    : {
      title: t('quota.capacity_current_window'),
      caption: current ? cycleSpan(current) : t('quota.capacity_reason_no_traffic'),
      figures: formatCycleCardFigures(current, tokenStyle, t),
      isEmpty: !current,
      isPending: false,
      foot: <UsedShare usedPercent={currentUsed} />,
    };

  const forecastFootNote = isSubscriptionTab
    ? (!subProjection && !subscription.isPending ? (subPendingNote ?? t('quota.subscription_reason_insufficient_elapsed')) : null)
    : (!activeCapacity ? (pendingNote ?? t('quota.capacity_reason_low_usage')) : null);

  const forecastCard = isSubscriptionTab
    ? {
      title: t('quota.subscription_projected_cycle'),
      caption: subUntilCaption,
      figures: subProjectionFigures,
      isEmpty: !subProjection,
      isPending: subscription.isPending,
      tag: t('quota.subscription_projection_tag'),
    }
    : {
      title: t('quota.capacity_forecast_window'),
      caption: forecastCaption,
      figures: forecastFigures,
      isEmpty: !activeCapacity,
      isPending: false,
      tag: t('quota.capacity_forecast_tag'),
    };

  return (
    <AppModal
      open={open}
      onCancel={onClose}
      footer={null}
      size="large"
      title={(
        <span className={styles['dialog-title']}>
          {owner.mark && <span className={styles['mark-tile']} aria-hidden="true">{owner.mark}</span>}
          <span className={styles['title-text']}>
            {t('quota.capacity_dialog_title', { window: titleWindowLabel })}
          </span>
        </span>
      )}
      description={group ? <MetaLine>{owner.credentialName}{group}</MetaLine> : owner.credentialName}
    >
      {tabOptions.length > 1 && (
        <div className={styles['cycle-bar']} data-quota-capacity-toolbar="">
          <Segmented
            size="sm"
            className={styles['window-switch']}
            aria-label={t('quota.capacity_window_switch')}
            value={isSubscriptionTab ? SUBSCRIPTION_CYCLE_TAB : activeWindow?.id ?? SUBSCRIPTION_CYCLE_TAB}
            onChange={setSelectedTab}
            options={tabOptions}
          />
        </div>
      )}

      <div className={styles.cards} data-quota-capacity-dialog={isSubscriptionTab ? 'subscription_cycle' : activeWindow?.id}>
        <Card
          icon={<HistoryOutlined />}
          title={previousCard.title}
          caption={previousCard.caption}
          figures={previousCard.figures}
          isEmpty={previousCard.isEmpty}
          isPending={previousCard.isPending}
          foot={previousCard.foot}
        />
        <Card
          icon={<HourglassOutlined />}
          title={currentCard.title}
          caption={currentCard.caption}
          figures={currentCard.figures}
          isEmpty={currentCard.isEmpty}
          isPending={currentCard.isPending}
          foot={currentCard.foot}
        />
        <Card
          tone="forecast"
          icon={<InsightsOutlined />}
          title={forecastCard.title}
          caption={forecastCard.caption}
          figures={forecastCard.figures}
          isEmpty={forecastCard.isEmpty}
          isPending={forecastCard.isPending}
          foot={(
            <>
              {forecastFootNote && (
                <span className={styles['foot-text']} data-tip={forecastFootNote} data-tip-overflow="">
                  {forecastFootNote}
                </span>
              )}
              <Tag tone="accent" size="small" className={styles['foot-tag']}>{forecastCard.tag}</Tag>
            </>
          )}
        />
      </div>

      <div className={styles.note}>
        <InfoCircleOutlined className={styles['note-glyph']} />
        <span>
          {t(
            isSubscriptionTab
              ? (subCurrent?.widened || subPrevious?.widened ? 'insights.widened' : 'quota.subscription_hint_live')
              : 'quota.capacity_hint',
          )}
        </span>
      </div>
    </AppModal>
  );
}

function cycleSpan(cycle: QuotaCapacityCycle): string {
  return `${formatShortDateTime(cycle.from_ms)} – ${formatShortDateTime(cycle.reset_at_ms)}`;
}

function subscriptionSpan(period: QuotaSubscriptionPeriod): string {
  return `${formatShortDateTime(period.from_ms)} – ${formatShortDateTime(period.to_ms)}`;
}

function asCapacityCycle(period: QuotaSubscriptionPeriod | null): QuotaCapacityCycle | null {
  return period ? { from_ms: period.from_ms, reset_at_ms: period.to_ms, usage: period.usage } : null;
}

/**
 * Consumption cards lead with recorded API-equivalent cost; the capacity card leads with
 * estimated full-window cost. A card without a reading keeps every row with a dash for
 * each figure, so the three still line up across the subgrid.
 */
function Card({ tone, icon, title, caption, figures, isEmpty, isPending = false, foot }: {
  tone?: 'forecast';
  icon: React.ReactNode;
  title: string;
  caption: string;
  figures: CycleCardFigures;
  isEmpty: boolean;
  isPending?: boolean;
  foot: React.ReactNode;
}) {
  const t = useT();
  return (
    <section className={styles.card} data-tone={tone} data-empty={isEmpty || undefined} aria-label={title} aria-busy={isPending || undefined}>
      <header className={styles.head}>
        <PanelTitle icon={icon}>{title}</PanelTitle>
        <span className={styles.caption} data-tip={caption} data-tip-overflow="">
          {isPending ? '…' : caption}
        </span>
      </header>
      <div className={styles.lead}>
        <span className={styles.label}>{t(tone === 'forecast' ? 'quota.capacity_estimated_amount' : 'quota.capacity_spent')}</span>
        <span className={styles['lead-value']} data-tip={figures.costHint ?? undefined}>
          <FigureValue readout={figures.costReadout} fallback={figures.cost} />
        </span>
      </div>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t('quota.capacity_requests')}</dt>
          <dd><FigureValue readout={figures.requestsReadout} fallback={figures.requests} /></dd>
        </div>
        <div className={styles.row}>
          <dt>{t('quota.capacity_tokens_label')}</dt>
          <dd><FigureValue readout={figures.tokensReadout} fallback={figures.tokens} /></dd>
        </div>
        <div className={styles.row}>
          <dt>{t('quota.capacity_cache_rate')}</dt>
          <dd><CacheRateValue rate={figures.cacheRate} readout={figures.cacheRateReadout} /></dd>
        </div>
      </dl>
      <footer className={styles.foot}>{foot}</footer>
    </section>
  );
}

function FigureValue({ readout, fallback }: { readout?: RollingReadout; fallback: string | null }) {
  if (readout) return <RollingNumber readout={readout} />;
  return <>{fallback ?? '—'}</>;
}

function CacheRateValue({ rate, readout }: { rate: number | undefined; readout?: RollingReadout }) {
  if (rate == null || !Number.isFinite(rate)) return <>—</>;
  const mix = cacheScaleMix(rate);
  const dotStyle = {
    '--cache-rate-from': mix.from,
    '--cache-rate-to': mix.to,
    '--cache-rate-from-share': mix.fromShare,
  } as React.CSSProperties;
  return (
    <span className={styles['cache-value']}>
      <span className={styles['cache-dot']} style={dotStyle} aria-hidden="true" />
      <RollingNumber readout={readout} />
    </span>
  );
}

function UsedShare({ usedPercent }: { usedPercent: number | undefined }) {
  const t = useT();
  const share = usedPercent == null ? null : Math.round(Math.min(Math.max(usedPercent, 0), 100));
  return (
    <>
      {share != null && <Meter className={styles.meter} value={share} label={t('quota.capacity_used_share', { n: share })} />}
      <span className={styles['foot-figure']}>
        {share == null ? '—' : t('quota.capacity_used_share', { n: share })}
      </span>
    </>
  );
}

function ElapsedShare({ elapsedPercent }: { elapsedPercent: number | undefined }) {
  const t = useT();
  const share = elapsedPercent == null ? null : Math.round(Math.min(Math.max(elapsedPercent, 0), 100));
  return (
    <>
      {share != null && <Meter className={styles.meter} value={share} label={t('quota.subscription_elapsed_share', { n: share })} />}
      <span className={styles['foot-figure']}>
        {share == null ? '—' : t('quota.subscription_elapsed_share', { n: share })}
      </span>
    </>
  );
}
