import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
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
import type { QuotaCapacityCycle, QuotaModelProjection, QuotaWindow } from '../../types/quota';
import type { RollingReadout } from '../../types/rollingNumber';
import { formatShortDateTime } from './quotaFormat';
import {
  type CycleCardFigures,
  describeForecastCard,
  describeQuotaCapacity,
  formatCycleCardFigures,
} from './quotaCapacity';
import type { QuotaCapacityOwner } from './QuotaCapacityButton';
import { quotaWindowGroupName, quotaWindowName, siblingCapacityWindows } from './quotaWindowSelection';
import styles from './QuotaCapacityDialog.module.css';

export interface QuotaCapacityDialogProps {
  open: boolean;
  onClose: () => void;
  owner: QuotaCapacityOwner;
  window: QuotaWindow;
  windows?: readonly QuotaWindow[];
}

/**
 * Three cards of one build: what the last window used, what this one has used so far, and what
 * this window holds in all. Cost, requests, tokens and cache rate sit at the same height in each,
 * so every figure is read directly against its neighbours.
 */
export default function QuotaCapacityDialog({ open, onClose, owner, window, windows }: QuotaCapacityDialogProps) {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const siblingWindows = React.useMemo(() => siblingCapacityWindows(window, windows), [window, windows]);
  const [selectedWindowId, setSelectedWindowId] = React.useState(window.id);
  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const [prevTrigger, setPrevTrigger] = React.useState({ open, windowId: window.id });
  if (prevTrigger.open !== open || prevTrigger.windowId !== window.id) {
    const openedFresh = open && !prevTrigger.open;
    const triggerChanged = prevTrigger.windowId !== window.id;
    setPrevTrigger({ open, windowId: window.id });
    if (openedFresh || triggerChanged) {
      setSelectedWindowId(window.id);
      if (openedFresh) setSelectedModel(null);
    }
  }

  const activeWindow = siblingWindows.find((candidate) => candidate.id === selectedWindowId) ?? window;

  const history = useQuery({
    queryKey: ['quota-capacity', owner.authIndex, activeWindow.id],
    queryFn: () => api.getQuotaCapacityHistory(owner.authIndex, activeWindow.id),
    enabled: open,
    staleTime: 30_000,
  });

  const used = activeWindow.used_percent
    ?? (activeWindow.remaining_percent == null ? undefined : 100 - activeWindow.remaining_percent);
  const current: QuotaCapacityCycle | null = history.data?.current
    ?? (activeWindow.usage && activeWindow.reset_at_ms
      ? { from_ms: activeWindow.usage.from_ms, reset_at_ms: activeWindow.reset_at_ms, used_percent: used, usage: activeWindow.usage }
      : null);
  const previous = history.data?.previous ?? null;
  const currentUsed = current?.used_percent ?? used;
  const { capacity } = activeWindow;
  const pendingNote = capacity ? null : describeQuotaCapacity(activeWindow, tokenStyle, t)?.note;
  const group = quotaWindowGroupName(activeWindow);

  const modelOptions = React.useMemo<QuotaModelProjection[]>(() => {
    if (history.data?.model_projections?.length) return history.data.model_projections;
    return capacity?.projection ? [capacity.projection] : [];
  }, [history.data?.model_projections, capacity?.projection]);

  const activeProjection = React.useMemo(() => {
    if (selectedModel) {
      const match = modelOptions.find((option) => option.model === selectedModel);
      if (match) return match;
    }
    return modelOptions[0] ?? capacity?.projection ?? null;
  }, [selectedModel, modelOptions, capacity?.projection]);

  const forecast = describeForecastCard(activeWindow, current, tokenStyle, activeProjection);
  const untilText = activeWindow.reset_at_ms
    ? t('quota.capacity_until', { when: formatShortDateTime(activeWindow.reset_at_ms) })
    : null;
  const forecastCaption = forecast.model ?? untilText ?? '\u00a0';

  const selectOptions = React.useMemo(
    () => modelOptions.map((option) => ({ value: option.model, label: option.model })),
    [modelOptions],
  );

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
            {t('quota.capacity_dialog_title', { window: quotaWindowName(activeWindow, t) })}
          </span>
        </span>
      )}
      description={group ? `${owner.credentialName} · ${group}` : owner.credentialName}
    >
      {siblingWindows.length > 1 && (
        <div className={styles['cycle-bar']} data-quota-capacity-toolbar="">
          <Segmented
            size="sm"
            className={styles['window-switch']}
            aria-label={t('quota.capacity_window_switch')}
            value={activeWindow.id}
            onChange={setSelectedWindowId}
            options={siblingWindows.map((candidate) => ({
              value: candidate.id,
              label: quotaWindowName(candidate, t),
            }))}
          />
        </div>
      )}

      <div className={styles.cards} data-quota-capacity-dialog={activeWindow.id}>
        <Card
          icon={<HistoryOutlined />}
          title={t('quota.capacity_previous_window')}
          caption={previous
            ? cycleSpan(previous)
            : t(history.isError ? 'quota.capacity_reason_history_unavailable' : 'quota.capacity_no_previous')}
          figures={formatCycleCardFigures(previous, tokenStyle, t)}
          isEmpty={!previous}
          isPending={history.isPending}
          foot={<UsedShare usedPercent={previous?.used_percent} />}
        />
        <Card
          icon={<HourglassOutlined />}
          title={t('quota.capacity_current_window')}
          caption={current ? cycleSpan(current) : t('quota.capacity_reason_no_traffic')}
          figures={formatCycleCardFigures(current, tokenStyle, t)}
          isEmpty={!current}
          foot={<UsedShare usedPercent={currentUsed} />}
        />
        <Card
          tone="forecast"
          icon={<InsightsOutlined />}
          title={t('quota.capacity_forecast_window')}
          caption={forecastCaption}
          captionSlot={capacity && modelOptions.length > 1 && activeProjection ? (
            <Select
              size="sm"
              variant="borderless"
              className={styles['model-select']}
              popupMatchSelectWidth={false}
              aria-label={t('quota.capacity_select_model')}
              data-testid="quota-capacity-model-select"
              value={activeProjection.model}
              onChange={(next) => { if (next) setSelectedModel(next); }}
              options={selectOptions}
            />
          ) : undefined}
          figures={forecast.figures}
          isEmpty={!capacity}
          foot={(
            <>
              {capacity ? (
                <span className={styles['foot-text']} data-tip={t('quota.capacity_error_hint')}>
                  {t('quota.capacity_margin', { n: Math.max(1, Math.round(capacity.error_percent)) })}
                </span>
              ) : (
                <span className={styles['foot-text']}>{pendingNote ?? t('quota.capacity_reason_low_usage')}</span>
              )}
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

/**
 * One window's card: a PanelTitle head with its span over a rule, the cost large, requests,
 * tokens and cache rate as ruled rows, and a foot. A card without a reading keeps every row
 * with a dash for each figure, so the three still line up across the subgrid.
 */
function Card({ tone, icon, title, caption, captionSlot, figures, isEmpty, isPending = false, foot }: {
  tone?: 'forecast';
  icon: React.ReactNode;
  title: string;
  caption: string;
  captionSlot?: React.ReactNode;
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
        {captionSlot ?? (
          <span className={styles.caption} data-tip={caption} data-tip-overflow="">
            {isPending ? '…' : caption}
          </span>
        )}
      </header>
      <div className={styles.lead}>
        <span className={styles.label}>{t(tone === 'forecast' ? 'quota.capacity_amount' : 'quota.capacity_spent')}</span>
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
      <Meter className={styles.meter} value={share ?? 0} />
      <span className={styles['foot-figure']}>
        {share == null ? '—' : t('quota.capacity_used_share', { n: share })}
      </span>
    </>
  );
}
