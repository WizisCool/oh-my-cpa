import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Button, Checkbox, Empty, Input, InputNumber, Pagination, Segmented, Select, TimePicker, Tooltip } from 'antd';
import { ParagraphPlaceholder } from '../common/ContentPlaceholder';
import dayjs, { timeZoneOptions } from '../../utils/time';
import clsx from 'clsx';
import { ClockCircleOutlined, DeleteOutlined, PlusOutlined, SearchOutlined } from '../icons';
import { useT, type TFunc } from '../../i18n';
import { formatTokensFull } from '../../types/tokenDisplay';
import type { PriceTier, UpstreamModel } from '../../types/pricing';
import {
  MAX_TIERS,
  RATE_KEYS,
  clockShiftMinutes,
  convertTierDraftUnit,
  formatHHMM,
  formatMultiplier,
  formatRatePer1M,
  formatTokenCount,
  hasTimeWindow,
  newTierDraft,
  parseRateText,
  parseTokenCount,
  priceSchedule,
  rateField,
  searchUpstreamModels,
  shiftClockText,
  tierTimeZone,
  type RateFields,
  type RateKey,
  type TierDraft,
  type TierDraftError,
  type TierKind,
  type TierRateUnit,
} from '../../types/pricingDisplay';
import styles from './Pricing.module.css';

/** The words for one tier's condition, which every surface that names a tier shares. */
export function describeTier(t: TFunc, tier: PriceTier): string {
  const parts: string[] = [];
  if (tier.min_prompt_tokens) parts.push(t('pricing.tier.long_context', { n: formatTokenCount(tier.min_prompt_tokens) }));
  if (hasTimeWindow(tier)) {
    parts.push(t('pricing.tier.window', { start: formatHHMM(tier.utc_start), end: formatHHMM(tier.utc_end), zone: tierTimeZone(tier) }));
  }
  return parts.join(' · ');
}

/** Small marks naming a price's tiers; a price without tiers draws nothing. */
export const TierBadges: React.FC<{ tiers: PriceTier[] | null | undefined }> = ({ tiers }) => {
  useTimeZone();
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
  useTimeZone();
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
  useTimeZone();
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
      {model.tiers && model.tiers.length > 0 ? (
        <PriceSchedule price={model} tiers={model.tiers} />
      ) : (
        <RateGrid rates={{
          prompt: model.prompt_price_per_1m,
          completion: model.completion_price_per_1m,
          cacheRead: model.cache_read_price_per_1m,
          cacheWrite: model.cache_write_price_per_1m,
        }}
        />
      )}
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
  useTimeZone();
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
        {results.length === 0 && isLoading ? (
          <ParagraphPlaceholder rows={6} />
        ) : results.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('pricing.editor.pick_empty')} />
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

const RATE_LABEL_KEYS: Record<RateKey, string> = {
  prompt: 'pricing.rate.prompt',
  completion: 'pricing.rate.completion',
  cacheRead: 'pricing.rate.cache_read',
  cacheWrite: 'pricing.rate.cache_write',
};

/** Thresholds providers actually publish, offered as one-click choices. */
const THRESHOLD_PRESETS = [128_000, 200_000, 256_000, 272_000, 1_000_000];

/**
 * A tier's condition as the ladder names it. A window is named on its own clock, with the same
 * hours as the console zone reads them today when the two clocks differ.
 */
function useScheduleCondition() {
  const t = useT();
  const consoleZone = useTimeZone();
  return React.useCallback((tier: PriceTier | null, upTo: number | null): string => {
    if (!tier) return upTo ? t('pricing.schedule.base_below', { n: formatTokenCount(upTo) }) : t('pricing.schedule.base');
    const parts: string[] = [];
    if (tier.min_prompt_tokens) parts.push(t('pricing.schedule.context', { n: formatTokenCount(tier.min_prompt_tokens) }));
    if (hasTimeWindow(tier)) {
      const start = formatHHMM(tier.utc_start);
      const end = formatHHMM(tier.utc_end);
      let window = t('pricing.tier.window', { start, end, zone: tierTimeZone(tier) });
      const shift = clockShiftMinutes(tierTimeZone(tier), consoleZone, Date.now());
      if (shift !== 0) {
        window += ` (${t('pricing.schedule.window_local', { start: shiftClockText(start, shift), end: shiftClockText(end, shift) })})`;
      }
      parts.push(window);
    }
    return parts.join(' · ');
  }, [t, consoleZone]);
}

/**
 * A price read as a ladder: what a request pays at each step. A rate a tier leaves to the base is
 * muted, and one it changes names the multiple, so "input doubles above 272K" reads at a glance.
 */
export const PriceSchedule: React.FC<{
  price: RateFields;
  tiers: readonly PriceTier[] | null | undefined;
  /** The tier a sample request falls in, marked in the ladder; -1 marks the base row. */
  activeTierIndex?: number | null;
}> = ({ price, tiers, activeTierIndex = null }) => {
  useTimeZone();
  const t = useT();
  const condition = useScheduleCondition();
  const rows = priceSchedule(price, tiers);
  return (
    <div className={styles['schedule-wrap']}>
      <table className={styles.schedule} data-testid="pricing-schedule">
        <thead>
          <tr>
            <th scope="col">{t('pricing.schedule.condition')}</th>
            {RATE_KEYS.map((key) => <th key={key} scope="col">{t(RATE_LABEL_KEYS[key])}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tierIndex} className={clsx(activeTierIndex === row.tierIndex && styles['schedule-active'])}>
              <th scope="row">
                {row.tier && hasTimeWindow(row.tier) && <ClockCircleOutlined aria-hidden="true" />}
                {condition(row.tier, row.upTo)}
              </th>
              {RATE_KEYS.map((key) => {
                const rate = row.rates[rateField(key)];
                const from = price[rateField(key)];
                const isInherited = row.tier !== null && row.inherited.has(key);
                const ratio = !isInherited && row.tier && from > 0 ? rate / from : null;
                return (
                  <td key={key} className={clsx(isInherited && styles['schedule-inherited'])} title={isInherited ? t('pricing.schedule.inherited') : undefined}>
                    {formatRatePer1M(rate)}
                    {ratio !== null && Math.abs(ratio - 1) > 1e-9 && (
                      <span className={clsx(styles['schedule-ratio'], ratio > 1 ? styles['rate-up'] : styles['rate-down'])}>
                        {formatMultiplier(Number(ratio.toPrecision(4)))}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * A tier's window and the clock it is read on. The times are the ones the vendor publishes, in the
 * vendor's zone; nothing is converted on the way to the server.
 */
const WindowField: React.FC<{
  draft: TierDraft;
  onChange: (patch: Partial<TierDraft>) => void;
}> = ({ draft, onChange }) => {
  const t = useT();
  const consoleZone = useTimeZone();
  const pickerValue = (text: string) => (text ? dayjs(`2000-01-01 ${text}`, 'YYYY-MM-DD HH:mm') : null);
  const zones = React.useMemo(() => timeZoneOptions(consoleZone, draft.timeZone, t('pricing.editor.window_zone_console')), [consoleZone, draft.timeZone, t]);
  const shift = clockShiftMinutes(draft.timeZone, consoleZone, Date.now());
  const isComplete = draft.windowStart !== '' && draft.windowEnd !== '';
  return (
    <div className={styles['tier-window']}>
      <div className={styles['tier-field']}>
        <span>{t('pricing.editor.window_range')}</span>
        <TimePicker.RangePicker
          format="HH:mm"
          order={false}
          allowEmpty={[true, true]}
          value={[pickerValue(draft.windowStart), pickerValue(draft.windowEnd)]}
          aria-label={t('pricing.editor.window_range')}
          onChange={(values) => onChange({
            windowStart: values?.[0] ? values[0].format('HH:mm') : '',
            windowEnd: values?.[1] ? values[1].format('HH:mm') : '',
          })}
        />
      </div>
      <div className={styles['tier-field']}>
        <span>{t('pricing.editor.window_zone')}</span>
        <Select
          showSearch={{ filterOption: (input, option) => String(option?.searchText ?? '').includes(input.replace(/_/g, ' ').toLowerCase()) }}
          // Virtualized explicitly: a fixed popup width alone would switch antd to a plain list of
          // every zone, which the console's wheel smoothing does not drive.
          virtual
          popupMatchSelectWidth={320}
          value={draft.timeZone}
          onChange={(timeZone) => onChange({ timeZone })}
          options={zones}
          aria-label={t('pricing.editor.window_zone')}
          data-testid="pricing-tier-time-zone"
        />
      </div>
      {isComplete && shift !== 0 && (
        <span className={styles['tier-note']}>
          {t('pricing.editor.window_as_local', { start: shiftClockText(draft.windowStart, shift), end: shiftClockText(draft.windowEnd, shift) })}
        </span>
      )}
    </div>
  );
};

/** The four rates of one tier, entered as multiples of the base or as prices. */
const TierRateFields: React.FC<{
  draft: TierDraft;
  base: RateFields | null;
  onChange: (patch: Partial<TierDraft>) => void;
  onUnitChange: (unit: TierRateUnit) => void;
}> = ({ draft, base, onChange, onUnitChange }) => {
  const t = useT();
  const isMultiple = draft.rateUnit === 'multiple';
  return (
    <div className={styles['tier-rates-block']}>
      <div className={styles['tier-unit']}>
        <Segmented<TierRateUnit>
          size="small"
          value={draft.rateUnit}
          disabled={!base}
          onChange={onUnitChange}
          options={[
            { value: 'multiple', label: t('pricing.editor.rate_unit_multiple') },
            { value: 'price', label: t('pricing.editor.rate_unit_price') },
          ]}
        />
        <span className={styles['tier-note']}>{t('pricing.editor.tier_blank_hint')}</span>
      </div>
      <div className={styles['tier-rates']}>
        {RATE_KEYS.map((key) => {
          const value = parseRateText(draft[key]);
          const from = base ? base[rateField(key)] : null;
          const isInvalid = value !== undefined && Number.isNaN(value);
          let note = '';
          if (isMultiple && from !== null && value !== undefined && !isInvalid) note = t('pricing.editor.multiple_result', { price: formatRatePer1M(value * from) });
          return (
            <label key={key} className={styles['tier-field']}>
              <span>{t(RATE_LABEL_KEYS[key])}</span>
              <InputNumber<string>
                min="0"
                stringMode
                controls={false}
                value={draft[key] === '' ? null : draft[key]}
                status={isInvalid ? 'error' : undefined}
                prefix={isMultiple ? '×' : '$'}
                onChange={(next) => onChange({ [key]: next == null ? '' : String(next) })}
                placeholder={isMultiple ? '1' : (from === null ? '' : formatRatePer1M(from).slice(1))}
                data-testid={`pricing-tier-${key}`}
              />
              {note && <span className={styles['tier-note']}>{note}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
};

export interface TieredPricingEditorProps {
  drafts: TierDraft[];
  /** The base rates multiples are taken from; null while the base is incomplete. */
  base: RateFields | null;
  invalid: { index: number; error: TierDraftError } | null;
  onChange: (drafts: TierDraft[]) => void;
}

/**
 * Edits a custom price's tiers as the two questions operators actually ask - "does a long prompt
 * cost more?" and "is some time of day cheaper?" - each in its own section. A long-context tier
 * may also be limited to a window, which covers every tier the server accepts. A blank rate keeps
 * the base price, which is how providers publish tiers.
 */
export const TieredPricingEditor: React.FC<TieredPricingEditorProps> = ({ drafts, base, invalid, onChange }) => {
  const t = useT();
  const consoleZone = useTimeZone();
  const isFull = drafts.length >= MAX_TIERS;
  const update = (key: string, patch: Partial<TierDraft>) =>
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  const remove = (key: string) => onChange(drafts.filter((draft) => draft.key !== key));
  // A new window starts on the console's clock, the one the operator reads everything else in;
  // a vendor billing on another clock is one pick away.
  const add = (kind: TierKind) => onChange([...drafts, newTierDraft(kind === 'context'
    ? { kind, minPromptTokens: formatTokenCount(200_000), timeZone: consoleZone }
    : { kind, isWindowed: true, timeZone: consoleZone })]);
  const errorFor = (index: number) => (invalid?.index === index ? (
    <p className={styles['field-error']} role="alert">{t(`pricing.editor.tier_error_${invalid.error}`)}</p>
  ) : null);
  const windowField = (draft: TierDraft) => (
    <WindowField draft={draft} onChange={(patch) => update(draft.key, patch)} />
  );
  const removeButton = (draft: TierDraft) => (
    <Tooltip title={t('pricing.editor.tier_remove')}>
      <Button
        className="row-action-btn"
        size="small"
        danger
        icon={<DeleteOutlined />}
        aria-label={t('pricing.editor.tier_remove')}
        onClick={() => remove(draft.key)}
      />
    </Tooltip>
  );
  const rates = (draft: TierDraft) => (
    <TierRateFields
      draft={draft}
      base={base}
      onChange={(patch) => update(draft.key, patch)}
      onUnitChange={(unit) => base && onChange(drafts.map((item) => (item.key === draft.key ? convertTierDraftUnit(item, base, unit) : item)))}
    />
  );
  const sectionDrafts = (kind: TierKind) => drafts.map((draft, index) => ({ draft, index })).filter(({ draft }) => draft.kind === kind);

  return (
    <div className={styles['tier-sections']}>
      <section className={styles['tier-section']} data-testid="pricing-context-tiers">
        <div className={styles['tier-section-head']}>
          <h3>{t('pricing.editor.context_title')}</h3>
        </div>
        <p className={styles['mode-hint']}>{t('pricing.editor.context_hint')}</p>
        {sectionDrafts('context').map(({ draft, index }) => {
          const threshold = parseTokenCount(draft.minPromptTokens);
          return (
            <div key={draft.key} className={clsx(styles['tier-row'], invalid?.index === index && styles['tier-row-invalid'])} data-testid="pricing-tier-row">
              <div className={styles['tier-condition']}>
                <label className={styles['tier-threshold']}>
                  <span>{t('pricing.editor.context_threshold')}</span>
                  <Input
                    value={draft.minPromptTokens}
                    onChange={(event) => update(draft.key, { minPromptTokens: event.target.value })}
                    placeholder="200K"
                    suffix={t('pricing.editor.tokens_suffix')}
                    status={threshold !== undefined && Number.isNaN(threshold) ? 'error' : undefined}
                    data-testid="pricing-tier-threshold"
                  />
                </label>
                {removeButton(draft)}
              </div>
              <div className={styles['tier-presets']}>
                {THRESHOLD_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={clsx(styles['tier-preset'], threshold === preset && styles['tier-preset-active'])}
                    aria-pressed={threshold === preset}
                    onClick={() => update(draft.key, { minPromptTokens: formatTokenCount(preset) })}
                  >
                    {formatTokenCount(preset)}
                  </button>
                ))}
                {threshold !== undefined && !Number.isNaN(threshold) && (
                  <span className={styles['tier-note']}>{t('pricing.editor.context_threshold_full', { n: formatTokensFull(threshold) })}</span>
                )}
              </div>
              <Checkbox checked={draft.isWindowed} onChange={(event) => update(draft.key, { isWindowed: event.target.checked })}>
                {t('pricing.editor.context_windowed')}
              </Checkbox>
              {draft.isWindowed && windowField(draft)}
              {rates(draft)}
              {errorFor(index)}
            </div>
          );
        })}
        <Button icon={<PlusOutlined />} disabled={isFull} onClick={() => add('context')} data-testid="pricing-add-context-tier">
          {t('pricing.editor.context_add')}
        </Button>
      </section>

      <section className={styles['tier-section']} data-testid="pricing-window-tiers">
        <div className={styles['tier-section-head']}>
          <h3>{t('pricing.editor.window_title')}</h3>
        </div>
        <p className={styles['mode-hint']}>{t('pricing.editor.window_hint')}</p>
        {sectionDrafts('window').map(({ draft, index }) => (
          <div key={draft.key} className={clsx(styles['tier-row'], invalid?.index === index && styles['tier-row-invalid'])} data-testid="pricing-tier-row">
            <div className={styles['tier-condition']}>
              {windowField(draft)}
              {removeButton(draft)}
            </div>
            {rates(draft)}
            {errorFor(index)}
          </div>
        ))}
        <Button icon={<PlusOutlined />} disabled={isFull} onClick={() => add('window')} data-testid="pricing-add-window-tier">
          {t('pricing.editor.window_add')}
        </Button>
      </section>
      {isFull && <p className={styles['mode-hint']}>{t('pricing.editor.tier_limit', { n: MAX_TIERS })}</p>}
    </div>
  );
};
