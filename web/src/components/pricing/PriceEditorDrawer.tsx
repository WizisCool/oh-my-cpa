import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Button, Collapse, Drawer, Input, InputNumber, Popconfirm, Segmented } from 'antd';
import { ParagraphPlaceholder } from '../common/Placeholder';
import dayjs from '../../utils/time';
import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditOutlined, LinkOutlined, ThunderboltOutlined } from '../icons';
import { api } from '../../api/client';
import { pricingErrorText } from './pricingErrors';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { StatusLabel, type StatusTone } from '../common/StatusLabel';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import type { ModelPrice, PriceTier, PriceVersion, PricingMode, PricingModelUpdate, UpstreamModel } from '../../types/pricing';
import {
  formatMultiplier,
  formatRatePer1M,
  formatUsd,
  modeOf,
  parseRateText,
  parseTokenCount,
  previewCostUsd,
  rateDelta,
  tierDraftsFrom,
  tiersFromDrafts,
  type RateFields,
  type TierDraft,
} from '../../types/pricingDisplay';
import { PriceSchedule, RateGrid, TierBadges, TieredPricingEditor, UpstreamPicker, UpstreamSummary, describeTier } from './PricingParts';
import { PRICING_QUERY_KEYS } from './pricingQueries';
import styles from './Pricing.module.css';
import { useToast } from '../feedback';
import { LoadFailure, Notice } from '../feedback';

export interface PriceEditorDrawerProps {
  model: string;
  initialMode?: PricingMode;
  initialUpstream?: UpstreamModel;
  isOpen: boolean;
  onClose: () => void;
}

interface CustomRatesDraft {
  prompt: string;
  completion: string;
  cacheRead: string;
  cacheWrite: string;
}

const EMPTY_RATES: CustomRatesDraft = { prompt: '', completion: '', cacheRead: '', cacheWrite: '' };

function ratesDraftFrom(price: RateFields): CustomRatesDraft {
  return {
    prompt: String(price.prompt_price_per_1m),
    completion: String(price.completion_price_per_1m),
    cacheRead: String(price.cache_read_price_per_1m),
    cacheWrite: String(price.cache_write_price_per_1m),
  };
}

function upstreamRates(model: UpstreamModel): RateFields {
  return {
    prompt_price_per_1m: model.prompt_price_per_1m,
    completion_price_per_1m: model.completion_price_per_1m,
    cache_read_price_per_1m: model.cache_read_price_per_1m,
    cache_write_price_per_1m: model.cache_write_price_per_1m,
  };
}

const MODE_ICONS: Record<PricingMode, React.ReactNode> = {
  auto: <ThunderboltOutlined />,
  linked: <LinkOutlined />,
  custom: <EditOutlined />,
};

export function modeTone(mode: PricingMode | null): StatusTone {
  if (mode === null) return 'warn';
  return mode === 'custom' ? 'accent' : 'success';
}

/**
 * Decides how one model is priced: follow OpenRouter automatically, follow one chosen OpenRouter
 * model, or use the operator's own rates. Every decision prices requests from now on; the drawer
 * says so once, beside the Save button, and shows what a typical recent request would cost before
 * and after so the change is read in money rather than in per-million rates.
 */
export const PriceEditorDrawer: React.FC<PriceEditorDrawerProps> = ({ model, initialMode, initialUpstream, isOpen, onClose }) => {
  useTimeZone();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { style: tokenStyle } = useTokenDisplayStyle();
  useOverlayHistory({ isOpen, onClose });

  const detail = useQuery({
    queryKey: PRICING_QUERY_KEYS.model(model),
    queryFn: () => api.getPricingModel(model),
    enabled: isOpen,
    staleTime: 10_000,
  });
  const current: ModelPrice | null = detail.data?.price ?? null;
  const currentMode = current ? modeOf(current) : null;
  const automatic = detail.data?.automatic ?? null;
  const suggestions = React.useMemo(() => detail.data?.suggestions ?? [], [detail.data]);
  const candidate = detail.data?.candidate ?? null;

  const [mode, setMode] = React.useState<PricingMode | null>(initialMode ?? null);
  const [linked, setLinked] = React.useState<UpstreamModel | null>(initialUpstream ?? null);
  const [rates, setRates] = React.useState<CustomRatesDraft>(EMPTY_RATES);
  const [tierDrafts, setTierDrafts] = React.useState<TierDraft[]>([]);
  const [multiplier, setMultiplier] = React.useState<number>(1);
  const [isSeeded, setIsSeeded] = React.useState(false);

  // The first answer decides the starting point: the model's own mode, or for an unpriced model
  // the cheapest route to a price - automatic when it matches, a suggestion when one resembles it,
  // hand-set rates otherwise.
  React.useEffect(() => {
    if (!detail.data || isSeeded) return;
    const price = detail.data.price;
    const startMode = initialMode
      ?? (price ? modeOf(price) : detail.data.automatic ? 'auto' : detail.data.suggestions.length > 0 ? 'linked' : 'custom');
    setMode(startMode);
    if (price) {
      setMultiplier(price.price_multiplier || 1);
      if (modeOf(price) === 'custom') {
        setRates(ratesDraftFrom(price));
        setTierDrafts(tierDraftsFrom(price.tiers, price));
      }
    }
    if (!initialUpstream && startMode === 'linked') {
      const pinned = price && modeOf(price) === 'linked' ? price.upstream_id : '';
      setLinked(detail.data.suggestions.find((item) => item.id === pinned) ?? detail.data.suggestions[0] ?? null);
    }
    setIsSeeded(true);
  }, [detail.data, initialMode, initialUpstream, isSeeded]);

  const catalog = useQuery({
    queryKey: PRICING_QUERY_KEYS.catalog,
    queryFn: api.getPricingCatalog,
    enabled: isOpen && mode === 'linked',
    staleTime: 10 * 60_000,
  });
  // A pinned model may not be among the suggestions; resolve it from the stored list once loaded.
  React.useEffect(() => {
    if (mode !== 'linked' || linked || !current?.upstream_id || !catalog.data) return;
    setLinked(catalog.data.models.find((item) => item.id === current.upstream_id) ?? null);
  }, [mode, linked, current, catalog.data]);

  /** The OpenRouter figures a custom price is compared against, when there are any. */
  const reference: UpstreamModel | null = automatic?.model ?? linked ?? suggestions[0] ?? null;

  const customRates = React.useMemo(() => ({
    prompt: parseRateText(rates.prompt),
    completion: parseRateText(rates.completion),
    cacheRead: parseRateText(rates.cacheRead),
    cacheWrite: parseRateText(rates.cacheWrite),
  }), [rates]);
  /** The custom base rates as billed, which tier multiples are taken from; null while incomplete. */
  const baseRates = React.useMemo((): RateFields | null => {
    const { prompt, completion, cacheRead, cacheWrite } = customRates;
    if (prompt === undefined || Number.isNaN(prompt) || completion === undefined || Number.isNaN(completion)) return null;
    if (Number.isNaN(cacheRead ?? 0) || Number.isNaN(cacheWrite ?? 0)) return null;
    return {
      prompt_price_per_1m: prompt,
      completion_price_per_1m: completion,
      // An empty cache rate is billed at the input rate, the same rule OpenRouter prices follow.
      cache_read_price_per_1m: cacheRead ?? prompt,
      cache_write_price_per_1m: cacheWrite ?? prompt,
    };
  }, [customRates]);
  const tierResult = React.useMemo(() => tiersFromDrafts(tierDrafts, baseRates), [tierDrafts, baseRates]);
  const isCustomValid = baseRates !== null && 'tiers' in tierResult;

  /** The price the form describes right now, for the preview; null until it is complete. */
  const draftPrice = React.useMemo((): (RateFields & { price_multiplier: number; tiers: PriceTier[] }) | null => {
    const withMultiplier = (fields: RateFields, tiers: PriceTier[] | null) => ({ ...fields, price_multiplier: multiplier, tiers: tiers ?? [] });
    if (mode === 'auto') return automatic ? withMultiplier(upstreamRates(automatic.model), automatic.model.tiers) : null;
    if (mode === 'linked') return linked ? withMultiplier(upstreamRates(linked), linked.tiers) : null;
    if (mode === 'custom' && baseRates && 'tiers' in tierResult) return withMultiplier(baseRates, tierResult.tiers);
    return null;
  }, [mode, automatic, linked, tierResult, baseRates, multiplier]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.book });
    void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.attention });
    void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.model(model) });
  };

  const save = useMutation({
    mutationFn: () => {
      const payload: PricingModelUpdate = { mode: mode ?? 'custom', price_multiplier: multiplier };
      if (mode === 'linked' && linked) payload.upstream_id = linked.id;
      if (mode === 'custom' && draftPrice) {
        payload.prompt_price_per_1m = draftPrice.prompt_price_per_1m;
        payload.completion_price_per_1m = draftPrice.completion_price_per_1m;
        payload.cache_read_price_per_1m = draftPrice.cache_read_price_per_1m;
        payload.cache_write_price_per_1m = draftPrice.cache_write_price_per_1m;
        payload.tiers = draftPrice.tiers;
      }
      return api.updatePricingModel(model, payload);
    },
    onSuccess: () => {
      toast.success(t('pricing.saved', { model }));
      invalidate();
      onClose();
    },
    onError: (error) => toast.error(t('pricing.save_failed', { msg: pricingErrorText(t, error) })),
  });

  const remove = useMutation({
    mutationFn: () => api.deletePricingModel(model),
    onSuccess: () => {
      toast.success(t('pricing.removed', { model }));
      invalidate();
      onClose();
    },
    onError: (error) => toast.error(t('pricing.delete_failed', { msg: pricingErrorText(t, error) })),
  });

  const dismissCandidate = useMutation({
    mutationFn: (upstreamId: string) => api.dismissPricingCandidate(model, upstreamId),
    onSuccess: () => {
      toast.info(t('pricing.candidate.dismissed', { model }));
      invalidate();
    },
    onError: (error) => toast.error(t('pricing.candidate.dismiss_failed', { msg: pricingErrorText(t, error) })),
  });
  // The candidate only stays on screen while the draft has not taken it up yet; once the operator
  // switched to it, the mode's own summary shows the same model and the save answers it.
  const isCandidateAdopted = candidate !== null && (candidate.kind === 'automatic'
    ? mode === 'auto'
    : mode === 'linked' && linked?.id === candidate.model.id);
  const adoptCandidate = () => {
    if (!candidate) return;
    if (candidate.kind === 'automatic') {
      setMode('auto');
    } else {
      setMode('linked');
      setLinked(candidate.model);
    }
  };

  const canSave = mode === 'auto' ? automatic !== null : mode === 'linked' ? linked !== null : mode === 'custom' && isCustomValid;
  const profile = detail.data?.profile;

  const title = (
    <div className={styles['drawer-title']}>
      <span className={styles['drawer-model']} title={model}>{model}</span>
      <StatusLabel tone={modeTone(currentMode)}>
        {currentMode ? t(`pricing.mode.${currentMode}`) : t('pricing.mode.unpriced')}
      </StatusLabel>
    </div>
  );

  const footer = (
    <div className={styles['drawer-footer']}>
      <span className={styles['drawer-footer-note']}>{t('pricing.editor.forward_note')}</span>
      <div className={styles['drawer-footer-actions']}>
        {current && (
          <Popconfirm
            title={t('pricing.delete_confirm', { model })}
            okText={t('pricing.editor.remove')}
            okButtonProps={{ danger: true }}
            cancelText={t('common.cancel')}
            onConfirm={() => remove.mutate()}
          >
            <Button danger type="text" loading={remove.isPending}>{t('pricing.editor.remove')}</Button>
          </Popconfirm>
        )}
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()} data-testid="pricing-editor-save">
          {t('common.save')}
        </Button>
      </div>
    </div>
  );

  return (
    <Drawer
      title={title}
      size={600}
      open={isOpen}
      onClose={onClose}
      footer={footer}
      destroyOnHidden
      className={styles.drawer}
      closable={{ 'aria-label': t('common.close') }}
      data-testid="pricing-editor"
    >
      {detail.isLoading || mode === null ? (
        detail.isError ? (
          <LoadFailure title={t('pricing.load_error')} error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <ParagraphPlaceholder rows={8} />
        )
      ) : (
        <div className={styles['drawer-body']}>
          {candidate && !isCandidateAdopted && (
            <Notice
              tone="info"
              data-testid="pricing-editor-candidate"
              title={t(candidate.kind === 'automatic' ? 'pricing.candidate.automatic' : 'pricing.candidate.suggested', {
                id: candidate.model.id,
                rates: `${formatRatePer1M(candidate.model.prompt_price_per_1m)} / ${formatRatePer1M(candidate.model.completion_price_per_1m)}`,
              })}
              description={t(candidate.kind === 'automatic' ? 'pricing.candidate.automatic_hint' : 'pricing.candidate.suggested_hint')}
              action={(
                <div className={styles['candidate-actions']}>
                  <Button size="small" type="primary" onClick={adoptCandidate} data-testid="pricing-editor-candidate-adopt">
                    {t(candidate.kind === 'automatic' ? 'pricing.candidate.follow' : 'pricing.attention.adopt')}
                  </Button>
                  <Button
                    size="small"
                    loading={dismissCandidate.isPending}
                    onClick={() => dismissCandidate.mutate(candidate.model.id)}
                    data-testid="pricing-editor-candidate-dismiss"
                  >
                    {t('pricing.candidate.dismiss')}
                  </Button>
                </div>
              )}
            />
          )}
          <section className={styles.section}>
            <Segmented<PricingMode>
              block
              value={mode}
              onChange={(value) => {
                setMode(value);
                // Switching to custom starts from the reference rates rather than from blanks, so
                // the operator edits a price instead of retyping one.
                if (value === 'custom' && rates.prompt === '' && reference) {
                  setRates(ratesDraftFrom(upstreamRates(reference)));
                  if (tierDrafts.length === 0) setTierDrafts(tierDraftsFrom(reference.tiers, upstreamRates(reference)));
                }
                if (value === 'linked' && !linked && suggestions[0]) setLinked(suggestions[0]);
              }}
              options={(['auto', 'linked', 'custom'] as const).map((value) => ({
                value,
                label: (
                  <span className={styles['mode-option']} data-testid={`pricing-mode-${value}`}>
                    {MODE_ICONS[value]}
                    {t(`pricing.mode.${value}`)}
                  </span>
                ),
              }))}
            />
            <p className={styles['mode-hint']}>{t(`pricing.mode.${mode}_hint`)}</p>
          </section>

          {mode === 'auto' && (
            <section className={styles.section}>
              {automatic ? (
                <UpstreamSummary
                  model={automatic.model}
                  extra={<span className={styles['match-kind']}>{t(`pricing.match.${automatic.match_kind || 'exact'}`)}</span>}
                />
              ) : (
                <Notice tone="warning" title={t('pricing.editor.auto_none')} />
              )}
            </section>
          )}

          {mode === 'linked' && (
            <section className={styles.section}>
              {linked && <UpstreamSummary model={linked} />}
              {catalog.isSuccess && catalog.data.models.length === 0 ? (
                <Notice tone="info" title={t('pricing.editor.catalog_empty')} />
              ) : (
                <UpstreamPicker
                  models={catalog.data?.models ?? []}
                  suggestions={suggestions}
                  selectedId={linked?.id ?? ''}
                  isLoading={catalog.isLoading}
                  onSelect={setLinked}
                />
              )}
            </section>
          )}

          {mode === 'custom' && (
            <section className={styles.section}>
              <div className={styles['section-head']}>
                <h3>{t('pricing.editor.rates')}</h3>
                {reference && (
                  <Button size="small" type="link" onClick={() => {
                    setRates(ratesDraftFrom(upstreamRates(reference)));
                    setTierDrafts(tierDraftsFrom(reference.tiers, upstreamRates(reference)));
                  }}
                  >
                    {t('pricing.editor.fill_reference', { id: reference.id })}
                  </Button>
                )}
              </div>
              <div className={styles['rate-inputs']}>
                {([
                  ['prompt', 'pricing.rate.prompt', 'prompt_price_per_1m', true],
                  ['completion', 'pricing.rate.completion', 'completion_price_per_1m', true],
                  ['cacheRead', 'pricing.rate.cache_read', 'cache_read_price_per_1m', false],
                  ['cacheWrite', 'pricing.rate.cache_write', 'cache_write_price_per_1m', false],
                ] as const).map(([field, labelKey, referenceField, isRequired]) => {
                  const value = parseRateText(rates[field]);
                  const delta = reference && value !== undefined && !Number.isNaN(value) ? rateDelta(reference[referenceField], value) : null;
                  return (
                    <label key={field} className={styles['rate-input']}>
                      <span>
                        {t(labelKey)}
                        {isRequired && <span className={styles.required} aria-hidden="true">*</span>}
                      </span>
                      <InputNumber<string>
                        min="0"
                        stringMode
                        controls={false}
                        value={rates[field] === '' ? null : rates[field]}
                        status={value !== undefined && Number.isNaN(value) ? 'error' : undefined}
                        onChange={(next) => setRates((previous) => ({ ...previous, [field]: next == null ? '' : String(next) }))}
                        placeholder={isRequired ? '0.00' : t('pricing.editor.cache_inherit')}
                        prefix="$"
                        data-testid={`pricing-rate-${field}`}
                      />
                      {reference && (
                        <span className={styles['rate-reference']}>
                          {t('pricing.editor.reference', { price: formatRatePer1M(reference[referenceField]) })}
                          {delta !== null && Math.abs(delta) >= 0.0005 && (
                            <span className={clsx(styles['rate-delta'], delta > 0 ? styles['rate-up'] : styles['rate-down'])}>
                              {delta > 0 ? '+' : ''}{(delta * 100).toFixed(delta > -0.1 && delta < 0.1 ? 1 : 0)}%
                            </span>
                          )}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          {mode === 'custom' && (
            <TieredPricingEditor
              drafts={tierDrafts}
              base={baseRates}
              invalid={'error' in tierResult ? tierResult : null}
              onChange={setTierDrafts}
            />
          )}

          {mode === 'custom' && draftPrice && draftPrice.tiers.length > 0 && (
            <section className={styles.section}>
              <h3>{t('pricing.editor.schedule')}</h3>
              <PriceSchedule price={draftPrice} tiers={draftPrice.tiers} />
            </section>
          )}

          <section className={styles.section}>
            <label className={styles['multiplier-field']}>
              <span>{t('pricing.editor.multiplier')}</span>
              <InputNumber
                min={0.01}
                max={100}
                step={0.05}
                value={multiplier}
                onChange={(value) => setMultiplier(typeof value === 'number' && value > 0 ? value : 1)}
                suffix="×"
                data-testid="pricing-multiplier"
              />
              <span className={styles['tier-note']}>{t('pricing.editor.multiplier_hint')}</span>
            </label>
          </section>

          <section className={styles.section} data-testid="pricing-preview">
            <h3>{t('pricing.editor.preview')}</h3>
            <PreviewRows
              profile={profile ?? { samples: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, max_input: 0 }}
              current={current}
              next={draftPrice}
              basis={profile && profile.samples > 0 ? t('pricing.editor.preview_basis', {
                n: profile.samples,
                input: formatTokens(profile.input, tokenStyle),
                output: formatTokens(profile.output, tokenStyle),
                cache: formatTokens(profile.cache_read, tokenStyle),
              }) : null}
            />
          </section>

          <Collapse
            ghost
            size="small"
            items={[{
              key: 'history',
              label: t('pricing.editor.history'),
              children: <PriceHistory versions={detail.data?.versions ?? []} />,
            }]}
          />
        </div>
      )}
    </Drawer>
  );
};

type PreviewPrice = RateFields & { price_multiplier: number; tiers?: PriceTier[] | null };

/**
 * The editor's cost preview: the model's median recent request priced now and after the change,
 * plus the largest recent prompt when it would reach a long-context tier - the request whose
 * price moves most when tiers change. Each row names the tier the new price bills it at, and a
 * request typed by hand can be tried against both prices.
 */
const PreviewRows: React.FC<{
  profile: { samples: number; input: number; output: number; cache_read: number; cache_write: number; max_input: number };
  current: ModelPrice | null;
  next: PreviewPrice | null;
  basis: string | null;
}> = ({ profile, current, next, basis }) => {
  useTimeZone();
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const [trialInput, setTrialInput] = React.useState('');
  const [trialOutput, setTrialOutput] = React.useState('');
  const hasSamples = profile.samples > 0;
  const typical = { input: profile.input, output: profile.output, cache_read: profile.cache_read, cache_write: profile.cache_write };
  // The largest prompt is scaled from the median's mix, since only its prompt size is sampled.
  const scale = profile.input > 0 ? profile.max_input / profile.input : 1;
  const largest = {
    input: profile.max_input,
    output: profile.output,
    cache_read: Math.round(profile.cache_read * scale),
    cache_write: Math.round(profile.cache_write * scale),
  };
  const rows: Array<{ key: string; label: string; tokens: typeof typical }> = [];
  if (hasSamples) rows.push({ key: 'typical', label: t('pricing.editor.preview_typical'), tokens: typical });
  const reachesTier = (price: PreviewPrice | null) => Boolean(price?.tiers?.some((tier) => (tier.min_prompt_tokens ?? 0) > 0 && profile.max_input >= (tier.min_prompt_tokens ?? 0)));
  if (hasSamples && profile.max_input > profile.input && (reachesTier(next) || reachesTier(current))) {
    rows.push({ key: 'largest', label: t('pricing.editor.preview_largest', { tokens: formatTokens(profile.max_input, tokenStyle) }), tokens: largest });
  }
  const trialIn = parseTokenCount(trialInput);
  const trialOut = parseTokenCount(trialOutput);
  const isTrialValid = trialIn !== undefined && !Number.isNaN(trialIn) && !Number.isNaN(trialOut ?? 0);
  if (isTrialValid) {
    rows.push({
      key: 'trial',
      label: t('pricing.editor.calc_row', { input: formatTokens(trialIn, tokenStyle), output: formatTokens(trialOut ?? 0, tokenStyle) }),
      tokens: { input: trialIn, output: trialOut ?? 0, cache_read: 0, cache_write: 0 },
    });
  }
  const quote = (price: PreviewPrice | null, tokens: typeof typical) => (price ? previewCostUsd(price, tokens) : null);
  const tierLabel = (price: PreviewPrice, tierIndex: number) => (
    tierIndex >= 0 && price.tiers ? describeTier(t, price.tiers[tierIndex]) : t('pricing.schedule.base')
  );
  const showsTiers = Boolean(next?.tiers?.length);
  return (
    <>
      {basis && <p className={styles['mode-hint']}>{basis}</p>}
      {!hasSamples && <p className={styles['mode-hint']}>{t('pricing.editor.preview_none')}</p>}
      {rows.length > 0 && (
        <table className={styles['preview-table']}>
          <thead>
            <tr>
              <th />
              <th>{t('pricing.editor.preview_current')}</th>
              <th>{t('pricing.editor.preview_new')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const before = quote(current, row.tokens);
              const after = quote(next, row.tokens);
              return (
                <tr key={row.key} data-testid={`pricing-preview-${row.key}`}>
                  <th scope="row">
                    {row.label}
                    {showsTiers && next && after && <span className={styles['preview-tier']}>{tierLabel(next, after.tierIndex)}</span>}
                  </th>
                  <td>{before === null ? '—' : formatUsd(before.usd)}</td>
                  <td className={styles['preview-new']}>{after === null ? '—' : formatUsd(after.usd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className={styles.calculator}>
        <span className={styles['calculator-label']}>{t('pricing.editor.calc')}</span>
        <Input
          size="small"
          value={trialInput}
          onChange={(event) => setTrialInput(event.target.value)}
          placeholder={t('pricing.editor.calc_input')}
          aria-label={t('pricing.editor.calc_input')}
          status={trialIn !== undefined && Number.isNaN(trialIn) ? 'error' : undefined}
          data-testid="pricing-calc-input"
        />
        <Input
          size="small"
          value={trialOutput}
          onChange={(event) => setTrialOutput(event.target.value)}
          placeholder={t('pricing.editor.calc_output')}
          aria-label={t('pricing.editor.calc_output')}
          status={trialOut !== undefined && Number.isNaN(trialOut) ? 'error' : undefined}
          data-testid="pricing-calc-output"
        />
      </div>
    </>
  );
};

/** A model's price versions, newest first, each with the moment it took effect. */
const PriceHistory: React.FC<{ versions: PriceVersion[] }> = ({ versions }) => {
  useTimeZone();
  const t = useT();
  if (versions.length === 0) return <p className={styles['mode-hint']}>{t('pricing.editor.history_empty')}</p>;
  return (
    <ol className={styles.history}>
      {versions.map((version) => (
        <li key={version.id} className={clsx(styles['history-item'], !version.available && styles['history-retired'])}>
          <time dateTime={new Date(version.effective_from_ms).toISOString()}>
            {dayjs(version.effective_from_ms).format('YYYY-MM-DD HH:mm')}
          </time>
          {version.available ? (
            <>
              <span className={styles['history-source']}>
                {version.price.source === 'manual'
                  ? t('pricing.source.manual')
                  : version.price.source === 'modelsdev'
                    ? t('pricing.source.modelsdev')
                    : version.price.upstream_id || t('pricing.source.openrouter')}
              </span>
              <RateGrid
                className={styles['history-rates']}
                rates={{
                  prompt: version.price.prompt_price_per_1m,
                  completion: version.price.completion_price_per_1m,
                  cacheRead: version.price.cache_read_price_per_1m,
                  cacheWrite: version.price.cache_write_price_per_1m,
                }}
              />
              {version.price.price_multiplier !== 1 && <span className={styles['history-source']}>{formatMultiplier(version.price.price_multiplier)}</span>}
              <TierBadges tiers={version.price.tiers} />
            </>
          ) : (
            <span className={styles['history-source']}>{t('pricing.editor.history_retired')}</span>
          )}
        </li>
      ))}
    </ol>
  );
};
