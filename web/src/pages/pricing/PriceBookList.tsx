import React from 'react';
import clsx from 'clsx';
import { Button } from '@/components/ui/button';
import type { ColumnsType } from '@/components/ui/table';
import { BranchesOutlined, LayersOutlined, RightOutlined } from '../../components/icons';
import { useT, type TFunc } from '../../i18n';
import { ResponsiveList } from '../../components/common/ResponsiveList';
import { StatusLabel, type StatusTone } from '../../components/common/StatusLabel';
import { MetaLine } from '../../components/common/MetaLine';
import { GlyphBadge } from '../../components/common/GlyphBadge';
import { Tooltip } from '../../components/common/Tooltip';
import type { TipCard } from '../../components/common/tipCard';
import { isRecordBodyClick } from '../../components/common/recordClick';
import { ModelMark } from '../../components/ModelMark';
import { describeTier } from '../../components/pricing/PricingParts';
import type { UpstreamModel } from '../../types/pricing';
import type { BookMode, BookRow } from '../../types/pricingBook';
import { formatMultiplier, formatRatePer1M } from '../../types/pricingDisplay';
import { UsageCell } from './UsageCell';
import styles from './PricingPage.module.css';

/** One page of the book, at either width. */
const PAGE_SIZE = 20;

const MODE_TONES: Record<BookMode, StatusTone> = {
  auto: 'success',
  linked: 'success',
  custom: 'accent',
  unpriced: 'warn',
};

export type AttentionAction = 'adopt' | 'dismiss';

export interface PriceBookListProps {
  rows: readonly BookRow[];
  isLoading: boolean;
  isBlocked: boolean;
  emptyText: React.ReactNode;
  /** Changes whenever the filters do, so the list returns to its first page. */
  pageResetKey: unknown;
  /** The model the editor is open on, marked until it closes. */
  openModel: string | null;
  channelLabel: (channel: string) => string;
  pendingAction: { model: string; action: AttentionAction } | null;
  /** The model whose unpriced requests are being priced. */
  pricingModel: string | null;
  onOpen: (model: string) => void;
  onAttention: (row: BookRow, action: AttentionAction) => void;
  onPriceUnpriced: (model: string) => void;
}

function modeLabel(t: TFunc, row: BookRow): string {
  return row.price?.source === 'modelsdev' ? t('pricing.mode.legacy') : t(`pricing.mode.${row.mode}`);
}

/** The OpenRouter model a pending row would take on, read before it is taken. */
function attentionModel(row: BookRow): UpstreamModel | null {
  if (!row.attention) return null;
  return row.attention.kind === 'suggestion' ? row.attention.upstream : row.attention.candidate.model;
}

function attentionLine(t: TFunc, row: BookRow): string | null {
  const attention = row.attention;
  if (!attention) return null;
  if (attention.kind === 'candidate' && attention.candidate.kind === 'automatic') return t('pricing.candidate.listed', { id: attention.candidate.model.id });
  return t('pricing.attention.suggestion', { id: attentionModel(row)?.id ?? '' });
}

function adoptLabel(t: TFunc, row: BookRow): string {
  return row.attention?.kind === 'candidate' && row.attention.candidate.kind === 'automatic'
    ? t('pricing.candidate.follow')
    : t('pricing.attention.adopt');
}

function ratesCard(t: TFunc, heading: string, model: UpstreamModel): TipCard {
  return {
    heading,
    rows: [
      { label: t('pricing.rate.prompt'), value: formatRatePer1M(model.prompt_price_per_1m) },
      { label: t('pricing.rate.completion'), value: formatRatePer1M(model.completion_price_per_1m) },
      { label: t('pricing.rate.cache_read'), value: formatRatePer1M(model.cache_read_price_per_1m) },
      { label: t('pricing.rate.cache_write'), value: formatRatePer1M(model.cache_write_price_per_1m) },
    ],
    notes: [model.id],
  };
}

/**
 * The price book as one row per model. A row is one decision: clicking it opens the model's
 * editor, where every scope is set. A pending row also carries its answer under the name - adopt
 * the suggested price, or ignore a new match - so a review pass never has to open the editor.
 */
export const PriceBookList: React.FC<PriceBookListProps> = ({
  rows, isLoading, isBlocked, emptyText, pageResetKey, openModel, channelLabel, pendingAction, pricingModel, onOpen, onAttention, onPriceUnpriced,
}) => {
  const t = useT();

  const usageCell = (row: BookRow) => (
    <UsageCell
      usage={row.usage}
      scope={{ key: 'model', value: row.model }}
      // A channel's own price prices that channel's requests, so it is enough to offer.
      pricing={row.price || row.channelPrices.length > 0
        ? { model: row.model, isPending: pricingModel === row.model, onConfirm: () => onPriceUnpriced(row.model) }
        : undefined}
    />
  );

  const rate = (row: BookRow, field: 'prompt_price_per_1m' | 'completion_price_per_1m' | 'cache_read_price_per_1m' | 'cache_write_price_per_1m') => (
    row.price ? <span className={styles.rate}>{formatRatePer1M(row.price[field])}</span> : <span className={styles.dimmed}>—</span>
  );

  const badges = (row: BookRow) => {
    const tiers = row.price?.tiers ?? [];
    return (
      <>
        {tiers.length > 0 && (
          <GlyphBadge glyph={<LayersOutlined />} label={t('pricing.badge.tiers', { n: tiers.length })} items={tiers.map((tier) => describeTier(t, tier))} data-testid="pricing-row-tiers">
            {tiers.length}
          </GlyphBadge>
        )}
        {row.channelPrices.length > 0 && (
          <GlyphBadge
            glyph={<BranchesOutlined />}
            label={t('pricing.badge.channels', { n: row.channelPrices.length })}
            items={row.channelPrices.map((price) => channelLabel(price.channel ?? ''))}
            data-testid="pricing-row-channel-prices"
          >
            {row.channelPrices.length}
          </GlyphBadge>
        )}
      </>
    );
  };

  /**
   * What a pending row offers and its answer, on one line: the suggestion, then the words that take
   * or ignore it. Kept beside the id they act on, they read as a sentence; at the row's far end they
   * read as an unlabelled tick.
   */
  const attentionCell = (row: BookRow, line: string) => {
    const upstream = attentionModel(row);
    const busy = pendingAction?.model === row.model ? pendingAction.action : null;
    return (
      <span className={clsx(styles['model-sub'], styles.attention)}>
        <span className={styles['attention-text']} data-tip={line} data-tip-overflow="">{line}</span>
        {upstream && (
          <Tooltip card={ratesCard(t, adoptLabel(t, row), upstream)}>
            <Button
              variant="link"
              size="sm"
              className={styles['attention-action']}
              loading={busy === 'adopt'}
              disabled={busy === 'dismiss'}
              onClick={() => onAttention(row, 'adopt')}
              aria-label={`${adoptLabel(t, row)}: ${row.model}`}
              data-testid={row.attention?.kind === 'candidate' ? 'pricing-candidate-adopt' : 'pricing-row-adopt'}
            >
              {adoptLabel(t, row)}
            </Button>
          </Tooltip>
        )}
        {row.attention?.kind === 'candidate' && (
          <Button
            variant="link"
            size="sm"
            className={clsx(styles['attention-action'], styles['attention-dismiss'])}
            loading={busy === 'dismiss'}
            disabled={busy === 'adopt'}
            onClick={() => onAttention(row, 'dismiss')}
            aria-label={`${t('pricing.candidate.dismiss')}: ${row.model}`}
            data-testid="pricing-candidate-dismiss"
          >
            {t('pricing.candidate.dismiss')}
          </Button>
        )}
      </span>
    );
  };

  const modelCell = (row: BookRow) => {
    const pending = attentionLine(t, row);
    const line = pending ?? row.price?.upstream_id ?? '';
    return (
      <div className={styles['model-cell']}>
        <ModelMark model={row.model} fallbackModel={row.price?.upstream_id} size={20} className={styles['model-mark']} />
        <div className={styles['model-text']}>
          <span className={styles['model-head']}>
            <span className={styles['model-name']} data-tip={row.model} data-tip-overflow="">{row.model}</span>
            {badges(row)}
          </span>
          {pending ? attentionCell(row, pending) : line && (
            <span className={styles['model-sub']} data-tip={line} data-tip-overflow="">{line}</span>
          )}
        </div>
      </div>
    );
  };

  /** How auto mode matched the model is a detail behind the state, read on demand. */
  const modeLabelCell = (row: BookRow) => {
    const label = <StatusLabel tone={MODE_TONES[row.mode]}>{modeLabel(t, row)}</StatusLabel>;
    const matchKind = row.mode === 'auto' && row.price?.match_kind && row.price.match_kind !== 'exact' ? row.price.match_kind : '';
    if (!matchKind) return label;
    return (
      <Tooltip title={t('pricing.match.tip', { kind: t(`pricing.match.${matchKind}`) })} isTapReadable>
        <span tabIndex={0} data-testid="pricing-row-match">{label}</span>
      </Tooltip>
    );
  };

  const multiplierText = (row: BookRow) => (row.price && row.price.price_multiplier !== 1 ? formatMultiplier(row.price.price_multiplier) : '');

  const modeCell = (row: BookRow) => {
    const multiplier = multiplierText(row);
    return (
      <div className={styles['mode-cell']}>
        {modeLabelCell(row)}
        {multiplier && <span className={styles['model-sub']}>{multiplier}</span>}
      </div>
    );
  };

  const openCue = (row: BookRow) => (
    <div className="row-actions">
      <Tooltip title={t(row.price ? 'pricing.edit' : 'pricing.set_price')}>
        <Button
          size="sm"
          variant="ghost"
          className={clsx('row-action-btn', styles['open-cue'])}
          icon={<RightOutlined />}
          onClick={() => onOpen(row.model)}
          aria-label={`${t(row.price ? 'pricing.edit' : 'pricing.set_price')}: ${row.model}`}
          data-testid="pricing-row-edit"
        />
      </Tooltip>
    </div>
  );

  const columns: ColumnsType<BookRow> = [
    { title: t('pricing.col.model'), key: 'model', render: (_: unknown, row: BookRow) => modelCell(row) },
    { title: t('pricing.col.input'), key: 'input', align: 'right', width: 96, render: (_: unknown, row: BookRow) => rate(row, 'prompt_price_per_1m') },
    { title: t('pricing.col.output'), key: 'output', align: 'right', width: 96, render: (_: unknown, row: BookRow) => rate(row, 'completion_price_per_1m') },
    { title: t('pricing.rate.cache_read'), key: 'cache_read', align: 'right', width: 96, render: (_: unknown, row: BookRow) => rate(row, 'cache_read_price_per_1m') },
    { title: t('pricing.rate.cache_write'), key: 'cache_write', align: 'right', width: 96, render: (_: unknown, row: BookRow) => rate(row, 'cache_write_price_per_1m') },
    { title: t('pricing.col.pricing'), key: 'mode', width: 140, render: (_: unknown, row: BookRow) => modeCell(row) },
    {
      title: t('pricing.col.usage'),
      key: 'usage',
      align: 'right',
      width: 200,
      render: (_: unknown, row: BookRow) => usageCell(row),
    },
    { title: '', key: 'actions', align: 'right', width: 48, render: (_: unknown, row: BookRow) => openCue(row) },
  ];

  const openFromClick = (row: BookRow) => (event: React.MouseEvent<HTMLElement>) => {
    if (isRecordBodyClick(event)) onOpen(row.model);
  };

  /**
   * A model on a phone: its name and state, the two rates most requests pay, and its spend. Cache
   * rates and conditions stay in the editor the card opens.
   */
  const phoneCard = (row: BookRow) => (
    <article
      className={clsx(styles['phone-card'], openModel === row.model && styles['row-open'])}
      data-testid="phone-row"
      aria-label={row.model}
      onClick={openFromClick(row)}
    >
      <div className={styles['phone-card-head']}>
        {modelCell(row)}
        {openCue(row)}
      </div>
      <div className={styles['phone-card-facts']}>
        {modeLabelCell(row)}
        {row.price && (
          <MetaLine>
            {multiplierText(row)}
            <span>{t('pricing.col.input')} <b>{formatRatePer1M(row.price.prompt_price_per_1m)}</b></span>
            <span>{t('pricing.col.output')} <b>{formatRatePer1M(row.price.completion_price_per_1m)}</b></span>
          </MetaLine>
        )}
      </div>
      {usageCell(row)}
    </article>
  );

  return (
    <div className={styles['book-list']}>
      <ResponsiveList<BookRow>
        columns={columns}
        dataSource={rows}
        rowKey="model"
        isLoading={isLoading}
        isBlocked={isBlocked}
        emptyText={emptyText}
        pageSize={PAGE_SIZE}
        pageResetKey={pageResetKey}
        isFilterAnimated
        phone={{ render: phoneCard }}
        // A fixed layout gives the model column what the figures leave, so a long id truncates
        // instead of pushing the row's actions out of the card; below that width the card scrolls.
        tableProps={{
          tableLayout: 'fixed',
          scroll: { x: 1080 },
          onRow: (row) => ({
            onClick: openFromClick(row),
            className: clsx(styles['book-row'], openModel === row.model && styles['row-open']),
          }),
        }}
      />
    </div>
  );
};
