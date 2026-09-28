import React from 'react';
import { Button, Empty, Input, InputNumber, Pagination, TimePicker, Tooltip } from 'antd';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { ClockCircleOutlined, DeleteOutlined, PlusOutlined, SearchOutlined } from '../icons';
import { useT, type TFunc } from '../../i18n';
import { formatTokensFull } from '../../types/tokenDisplay';
import type { PriceTier, UpstreamModel } from '../../types/pricing';
import {
  formatHHMM,
  formatRatePer1M,
  hasTimeWindow,
  newTierDraft,
  searchUpstreamModels,
  type TierDraft,
} from '../../types/pricingDisplay';
import styles from './Pricing.module.css';

/** The words for one tier's condition, which every surface that names a tier shares. */
export function describeTier(t: TFunc, tier: PriceTier): string {
  const parts: string[] = [];
  if (tier.min_prompt_tokens) parts.push(t('pricing.tier.long_context', { n: formatTokensFull(tier.min_prompt_tokens) }));
  if (hasTimeWindow(tier)) parts.push(t('pricing.tier.window', { start: formatHHMM(tier.utc_start), end: formatHHMM(tier.utc_end) }));
  return parts.join(' · ');
}

/** Small marks naming a price's tiers; a price without tiers draws nothing. */
export const TierBadges: React.FC<{ tiers: PriceTier[] | null | undefined }> = ({ tiers }) => {
  const t = useT();
  if (!tiers || tiers.length === 0) return null;
  return (
    <span className={styles['tier-badges']}>
      {tiers.map((tier, index) => (
        <span key={index} className={styles['tier-badge']}>
          {hasTimeWindow(tier) && <ClockCircleOutlined aria-hidden="true" />}
          {describeTier(t, tier)}
        </span>
      ))}
    </span>
  );
};

/** The four rates of a price, laid out the same wherever a price is read. */
export const RateGrid: React.FC<{
  rates: { prompt: number; completion: number; cacheRead: number; cacheWrite: number };
  className?: string;
}> = ({ rates, className }) => {
  const t = useT();
  const cells: Array<[string, number]> = [
    [t('pricing.rate.prompt'), rates.prompt],
    [t('pricing.rate.completion'), rates.completion],
    [t('pricing.rate.cache_read'), rates.cacheRead],
    [t('pricing.rate.cache_write'), rates.cacheWrite],
  ];
  return (
    <dl className={clsx(styles['rate-grid'], className)}>
      {cells.map(([label, value]) => (
        <div key={label} className={styles['rate-cell']}>
          <dt>{label}</dt>
          <dd>{formatRatePer1M(value)}</dd>
        </div>
      ))}
    </dl>
  );
};

/** One OpenRouter model: who publishes it, what it is called, and what it costs. */
export const UpstreamSummary: React.FC<{ model: UpstreamModel; extra?: React.ReactNode }> = ({ model, extra }) => {
  const t = useT();
  return (
    <div className={styles['upstream-summary']} data-testid="pricing-upstream-summary">
      <div className={styles['upstream-head']}>
        <div className={styles['upstream-identity']}>
          <span className={styles['upstream-id']}>{model.id}</span>
          {model.name && (
            <span className={styles['upstream-name']}>
              {model.name}
              {model.context_length > 0 && ` · ${t('pricing.context_length', { n: formatTokensFull(model.context_length) })}`}
            </span>
          )}
        </div>
        {extra}
      </div>
      <RateGrid rates={{
        prompt: model.prompt_price_per_1m,
        completion: model.completion_price_per_1m,
        cacheRead: model.cache_read_price_per_1m,
        cacheWrite: model.cache_write_price_per_1m,
      }}
      />
      <TierBadges tiers={model.tiers} />
    </div>
  );
};

export interface UpstreamPickerProps {
  models: readonly UpstreamModel[];
  suggestions: readonly UpstreamModel[];
  selectedId: string;
  isLoading: boolean;
  onSelect: (model: UpstreamModel) => void;
}

/**
 * Chooses an OpenRouter model. The whole stored list is filtered in the browser, so typing costs
 * no request; before anything is typed, the server's suggestions for this model come first.
 */
export const UpstreamPicker: React.FC<UpstreamPickerProps> = ({ models, suggestions, selectedId, isLoading, onSelect }) => {
  const t = useT();
  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState(1);
  const results = React.useMemo(() => {
    if (query.trim() === '') {
      const suggested = new Set(suggestions.map((model) => model.id));
      return [...suggestions, ...searchUpstreamModels(models, '', models.length).filter((model) => !suggested.has(model.id))];
    }
    return searchUpstreamModels(models, query, models.length);
  }, [models, suggestions, query]);
  const pageSize = 12;
  const safePage = Math.min(page, Math.max(1, Math.ceil(results.length / pageSize)));
  const suggestedIds = React.useMemo(() => new Set(suggestions.map((model) => model.id)), [suggestions]);
  return (
    <div className={styles.picker}>
      <Input
        allowClear
        value={query}
        onChange={(event) => { setQuery(event.target.value); setPage(1); }}
        prefix={<SearchOutlined aria-hidden="true" />}
        placeholder={t('pricing.editor.pick_search')}
        aria-label={t('pricing.editor.pick_search')}
      />
      <div className={styles['picker-list']} role="listbox" aria-label={t('pricing.editor.pick_title')}>
        {results.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isLoading ? t('common.loading') : t('pricing.editor.pick_empty')} />
        ) : results.slice((safePage - 1) * pageSize, safePage * pageSize).map((model) => {
          const isSelected = model.id === selectedId;
          return (
            <button
              type="button"
              role="option"
              aria-selected={isSelected}
              key={model.id}
              className={clsx(styles['picker-option'], isSelected && styles['picker-option-selected'])}
              onClick={() => onSelect(model)}
            >
              <span className={styles['picker-option-id']}>{model.id}</span>
              {query.trim() === '' && suggestedIds.has(model.id) && (
                <span className={styles['picker-suggested']}>{t('pricing.editor.pick_suggested')}</span>
              )}
              <span className={styles['picker-option-rates']}>
                {formatRatePer1M(model.prompt_price_per_1m)} / {formatRatePer1M(model.completion_price_per_1m)}
              </span>
            </button>
          );
        })}
      </div>
      <Pagination size="small" current={safePage} pageSize={pageSize} total={results.length} onChange={setPage} showSizeChanger={false} hideOnSinglePage />
    </div>
  );
};

const RATE_FIELDS: Array<{ field: keyof Pick<TierDraft, 'prompt' | 'completion' | 'cacheRead' | 'cacheWrite'>; labelKey: string }> = [
  { field: 'prompt', labelKey: 'pricing.rate.prompt' },
  { field: 'completion', labelKey: 'pricing.rate.completion' },
  { field: 'cacheRead', labelKey: 'pricing.rate.cache_read' },
  { field: 'cacheWrite', labelKey: 'pricing.rate.cache_write' },
];

export interface TierEditorProps {
  drafts: TierDraft[];
  invalidIndex: number | null;
  onChange: (drafts: TierDraft[]) => void;
}

/**
 * Edits a custom price's tiers: a prompt threshold, a UTC window, or both, and the rates that
 * change inside it. A blank rate inherits the base price, which is how providers publish tiers.
 */
export const TierEditor: React.FC<TierEditorProps> = ({ drafts, invalidIndex, onChange }) => {
  const t = useT();
  const update = (key: string, patch: Partial<TierDraft>) =>
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  const timeValue = (text: string) => (text ? dayjs(text, 'HH:mm') : null);
  return (
    <div className={styles['tier-editor']}>
      {drafts.map((draft, index) => (
        <div key={draft.key} className={clsx(styles['tier-row'], invalidIndex === index && styles['tier-row-invalid'])} data-testid="pricing-tier-row">
          <div className={styles['tier-conditions']}>
            <label className={styles['tier-field']}>
              <span>{t('pricing.editor.tier_min_tokens')}</span>
              <InputNumber
                min={1}
                precision={0}
                controls={false}
                value={draft.minPromptTokens === '' ? null : Number(draft.minPromptTokens)}
                onChange={(value) => update(draft.key, { minPromptTokens: value == null ? '' : String(value) })}
                placeholder="200000"
              />
            </label>
            <label className={styles['tier-field']}>
              <span>{t('pricing.editor.tier_window')}</span>
              <TimePicker.RangePicker
                format="HH:mm"
                order={false}
                allowEmpty={[true, true]}
                value={[timeValue(draft.utcStart), timeValue(draft.utcEnd)]}
                onChange={(values) => update(draft.key, {
                  utcStart: values?.[0] ? values[0].format('HH:mm') : '',
                  utcEnd: values?.[1] ? values[1].format('HH:mm') : '',
                })}
              />
            </label>
            <Tooltip title={t('pricing.editor.tier_remove')}>
              <Button
                className="row-action-btn"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={t('pricing.editor.tier_remove')}
                onClick={() => onChange(drafts.filter((item) => item.key !== draft.key))}
              />
            </Tooltip>
          </div>
          <div className={styles['tier-rates']}>
            {RATE_FIELDS.map(({ field, labelKey }) => (
              <label key={field} className={styles['tier-field']}>
                <span>{t(labelKey)}</span>
                <InputNumber<string>
                  min="0"
                  stringMode
                  controls={false}
                  value={draft[field] === '' ? null : draft[field]}
                  onChange={(value) => update(draft.key, { [field]: value == null ? '' : String(value) })}
                  placeholder={t('pricing.editor.tier_inherit')}
                />
              </label>
            ))}
          </div>
        </div>
      ))}
      <Button icon={<PlusOutlined />} onClick={() => onChange([...drafts, newTierDraft()])}>
        {t('pricing.editor.add_tier')}
      </Button>
    </div>
  );
};
