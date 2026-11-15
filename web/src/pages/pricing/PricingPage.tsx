import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Select } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { ReceiptOutlined, SyncOutlined } from '../../components/icons';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { api, ApiError, describeError } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import dayjs from '../../utils/time';
import { formatTimeAgo } from '../../utils/format';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { useViewSearchParams } from '../../hooks/useViewSearchParams';
import { useProviderBranding } from '../../hooks/useProviderBranding';
import { ActionMenu } from '../../components/common/ActionMenu';
import { PageHeader } from '../../components/common/PageHeader';
import { SummaryStrip } from '../../components/common/SummaryStrip';
import { FactList } from '../../components/common/FactList';
import { SearchInput } from '../../components/common/SearchInput';
import { Toolbar } from '../../components/common/Toolbar';
import { Count } from '../../components/common/Count';
import { confirmModal, LoadFailure, Notice, useToast } from '../../components/feedback';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { formatTokensFull } from '../../types/tokenDisplay';
import { useOpenPriceEditor, useOpenPriceModel } from '../../components/pricing/PricingEditorContext';
import { PRICING_QUERY_KEYS, pricingBookSwr } from '../../components/pricing/pricingQueries';
import { channelIdentity } from '../../components/pricing/pricingIdentity';
import { pricingErrorText } from '../../components/pricing/pricingErrors';
import { invalidateSwrScopes, useSwrQuery } from '../../performance/swrContract';
import type { PricingResponse } from '../../types/pricing';
import {
  BOOK_FILTERS,
  buildPriceBook,
  compareModelNames,
  filterPriceBook,
  hasUnbilledRequests,
  priceBookCounts,
  type BookFilter,
  type BookRow,
} from '../../types/pricingBook';
import { ChannelMultipliersPanel } from './ChannelMultipliersPanel';
import { PriceBookList, type AttentionAction } from './PriceBookList';
import styles from './PricingPage.module.css';

type PricingTab = 'models' | 'channels';

function syncTone(data: PricingResponse | undefined): 'healthy' | 'attention' | 'meta' {
  if (!data || data.sync.running) return 'meta';
  if (data.sync.state.last_error || !data.sync.state.last_success_at_ms) return 'attention';
  return 'healthy';
}

function syncSummary(t: TFunc, data: PricingResponse | undefined): string {
  if (!data) return t('common.loading');
  if (data.sync.running) return t('pricing.sync.running');
  if (data.sync.state.last_error) return t('pricing.sync.failed_short');
  const success = data.sync.state.last_success_at_ms;
  return success ? t('pricing.sync.synced_ago', { time: formatTimeAgo(success, Date.now(), t) }) : t('pricing.sync.never');
}

function isBookFilter(value: string | null): value is BookFilter {
  return value !== null && (BOOK_FILTERS as readonly string[]).includes(value);
}

/**
 * The price book. OpenRouter prices every model it can match without the operator doing anything;
 * this page is where the rest is decided - the models waiting on an answer, the ones an operator
 * pinned or priced by hand, and the multipliers for channels that do not bill list price.
 */
export const PricingPage: React.FC = () => {
  useTimeZone();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const openEditor = useOpenPriceEditor();
  const openModel = useOpenPriceModel();
  const branding = useProviderBranding();
  const [searchParams, setSearchParams] = useViewSearchParams();
  const tab: PricingTab = searchParams.get('tab') === 'channels' ? 'channels' : 'models';
  const filterParam = searchParams.get('filter');
  const filter: BookFilter = isBookFilter(filterParam) ? filterParam : 'all';
  const channelFilter = searchParams.get('channel') ?? '';
  const [search, setSearch] = React.useState('');

  const result = useSwrQuery(pricingBookSwr, undefined, {
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.sync.running ? 2_500 : false),
  });
  const data = result.data;

  const setParam = (key: string, value: string, emptyValue: string) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    if (value === emptyValue) params.delete(key);
    else params.set(key, value);
    return params;
  });
  const selectTab = (next: PricingTab) => setParam('tab', next, 'models');
  const showChannel = (channel: string) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    params.delete('tab');
    params.delete('filter');
    params.set('channel', channel);
    return params;
  });

  const invalidate = () => {
    void invalidateSwrScopes(queryClient, 'pricing');
  };

  const syncMutation = useMutation({
    mutationFn: () => api.startPricingSync(),
    onSuccess: () => {
      toast.info(t('pricing.sync_started'));
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.info(t('pricing.sync_conflict'));
        invalidate();
      } else {
        toast.error(t('pricing.sync_failed', { msg: describeError(err) }));
      }
    },
  });

  const scheduleMutation = useMutation({
    mutationFn: (intervalHours: number) => api.updatePricingSyncSchedule(intervalHours),
    onSuccess: () => {
      toast.success(t('pricing.sync.schedule_updated'));
      invalidate();
    },
    onError: (err) => toast.error(describeError(err)),
  });

  // A pending row is answered in place. An unpriced model links to its suggestion; a custom or
  // linked model follows its new match (auto mode when it is the automatic one) or ignores it
  // until OpenRouter offers a different one. The model multiplier carries over either way.
  const attentionMutation = useMutation({
    mutationFn: async ({ row, action }: { row: BookRow; action: AttentionAction }): Promise<unknown> => {
      const attention = row.attention;
      if (!attention) return null;
      if (attention.kind === 'suggestion') return api.updatePricingModel(row.model, { mode: 'linked', upstream_id: attention.upstream.id });
      const { candidate } = attention;
      if (action === 'dismiss') return api.dismissPricingCandidate(row.model, candidate.model.id);
      const multiplier = row.price?.price_multiplier;
      return candidate.kind === 'automatic'
        ? api.updatePricingModel(row.model, { mode: 'auto', price_multiplier: multiplier })
        : api.updatePricingModel(row.model, { mode: 'linked', upstream_id: candidate.model.id, price_multiplier: multiplier });
    },
    onSuccess: (_, { row, action }) => {
      const attention = row.attention;
      if (action === 'dismiss') toast.info(t('pricing.candidate.dismissed', { model: row.model }));
      else if (attention?.kind === 'candidate' && attention.candidate.kind === 'automatic') toast.success(t('pricing.candidate.followed', { model: row.model, id: attention.candidate.model.id }));
      else if (attention) toast.success(t('pricing.adopted', { model: row.model, id: attention.kind === 'suggestion' ? attention.upstream.id : attention.candidate.model.id }));
      invalidate();
      void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.model(row.model) });
    },
    onError: (err, { action }) => toast.error(t(action === 'dismiss' ? 'pricing.candidate.dismiss_failed' : 'pricing.save_failed', { msg: pricingErrorText(t, err) })),
  });

  const refreshSpend = (model?: string) => {
    void invalidateSwrScopes(queryClient, ['pricing', 'usage']);
    void queryClient.invalidateQueries({ queryKey: model ? PRICING_QUERY_KEYS.model(model) : ['pricing'] });
    void queryClient.invalidateQueries({ queryKey: ['usage-events'] });
  };

  const repriceAllMutation = useMutation({
    mutationFn: () => api.priceAllUnpricedUsage(),
    onSuccess: ({ priced }) => {
      if (priced > 0) toast.success(t('pricing.reprice_all.done', { n: priced }));
      else toast.info(t('pricing.reprice_all.none'));
      refreshSpend();
    },
    onError: (err) => toast.error(t('pricing.reprice.failed', { msg: pricingErrorText(t, err) })),
  });

  // Pricing a model's unpriced requests changes recorded spend, so every usage read refreshes.
  const repriceMutation = useMutation({
    mutationFn: (model: string) => api.priceUnpricedUsage(model),
    onSuccess: ({ priced }, model) => {
      if (priced > 0) toast.success(t('pricing.reprice.done', { model, n: priced }));
      else toast.info(t('pricing.reprice.none', { model }));
      refreshSpend(model);
    },
    onError: (err) => toast.error(t('pricing.reprice.failed', { msg: pricingErrorText(t, err) })),
  });

  const book = React.useMemo(() => (data ? buildPriceBook(data) : []), [data]);
  const counts = React.useMemo(() => priceBookCounts(book), [book]);
  // A filter with nothing left in it - every unbilled request priced - steps back to all models
  // rather than holding the operator on an empty list.
  const isFilterEmpty = Boolean(data) && filter !== 'all' && counts[filter] === 0;
  const activeFilter: BookFilter = isFilterEmpty ? 'all' : filter;
  React.useEffect(() => {
    if (isFilterEmpty) setParam('filter', 'all', 'all');
  }, [isFilterEmpty]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = React.useMemo(() => filterPriceBook(book, { filter: activeFilter, channel: channelFilter, search }), [book, activeFilter, channelFilter, search]);
  const billable = book.filter((row) => hasUnbilledRequests(row) && (row.price || row.channelPrices.length > 0));
  const billableRequests = billable.reduce((sum, row) => sum + row.usage.requests - row.usage.priced_requests, 0);
  const confirmRepriceAll = () => {
    confirmModal({
      title: t('pricing.reprice_all.final'),
      content: t('pricing.reprice_all.final_note'),
      okText: t('pricing.reprice_all.action'),
      danger: true,
      onOk: () => repriceAllMutation.mutate(),
    });
  };
  const channelLabel = React.useCallback((channel: string) => channelIdentity(channel, data?.providers, branding).label, [data?.providers, branding]);
  const channelOptions = React.useMemo(() => {
    const channels = new Set(book.flatMap((row) => [...row.channels, ...row.channelPrices.map((price) => price.channel ?? '')]));
    if (channelFilter) channels.add(channelFilter);
    channels.delete('');
    return [...channels]
      .map((channel) => ({ channel, identity: channelIdentity(channel, data?.providers, branding) }))
      .sort((left, right) => compareModelNames(left.identity.label, right.identity.label))
      .map(({ channel, identity }) => ({
        value: channel,
        title: identity.label,
        searchText: identity.label,
        label: (
          <span className={styles['channel-option']}>
            <ProviderBrandIcon mark={identity} size={16} />
            <span>{identity.label}</span>
          </span>
        ),
      }));
  }, [book, channelFilter, data?.providers, branding]);
  const candidates = book.filter((row) => row.attention?.kind === 'candidate').length;

  const summary = data && (
    <SummaryStrip>
      <SummaryStrip.Total testId="pricing-model-count">{t('pricing.summary.models', { n: counts.all })}</SummaryStrip.Total>
      <SummaryStrip.Divider />
      <SummaryStrip.Item tone="healthy">{t('pricing.summary.priced', { n: counts.all - counts.unpriced })}</SummaryStrip.Item>
      {counts.unpriced > 0 && (
        <>
          <SummaryStrip.Divider />
          <SummaryStrip.Item tone="attention">{t('pricing.summary.unpriced', { n: counts.unpriced })}</SummaryStrip.Item>
        </>
      )}
      {candidates > 0 && (
        <>
          <SummaryStrip.Divider />
          <SummaryStrip.Item tone="attention">{t('pricing.summary.candidates', { n: candidates })}</SummaryStrip.Item>
        </>
      )}
      <SummaryStrip.Divider />
      <SummaryStrip.Item tone={syncTone(data)} testId="pricing-sync-summary">
        {t('pricing.sync.source_name')} {syncSummary(t, data)}
      </SummaryStrip.Item>
    </SummaryStrip>
  );

  const syncPanel = (
    <div className={styles['sync-popover']} data-testid="pricing-sync-popover">
      <FactList
        emphasis="quiet"
        facts={[
          { key: 'source', label: t('pricing.sync.source'), value: t('pricing.sync.source_value', { n: data?.upstream_count ?? 0 }) },
          {
            key: 'last',
            label: t('pricing.sync.last_success_label'),
            value: data?.sync.state.last_success_at_ms ? dayjs(data.sync.state.last_success_at_ms).format('YYYY-MM-DD HH:mm') : t('pricing.sync.never'),
          },
          { key: 'matched', label: t('pricing.sync.matched_label'), value: `${data?.sync.state.last_matched ?? 0} / ${(data?.sync.state.last_matched ?? 0) + (data?.sync.state.last_unmatched ?? 0)}` },
          ...(data?.sync.state.next_sync_at_ms && data.sync.state.auto_sync_interval_hours !== 0
            ? [{ key: 'next', label: t('pricing.sync.next_label'), value: dayjs(data.sync.state.next_sync_at_ms).format('MM-DD HH:mm') }]
            : []),
        ]}
      />
      {data?.sync.state.last_error && (
        <Notice tone="error" title={t('pricing.sync.error', { error: data.sync.state.last_error })} />
      )}
      <label className={styles['sync-schedule']}>
        <span>{t('pricing.sync.auto_label')}</span>
        <Select
          size="small"
          value={data?.sync.state.auto_sync_interval_hours ?? 24}
          onChange={(value) => scheduleMutation.mutate(value)}
          loading={scheduleMutation.isPending}
          options={[
            { label: t('pricing.sync.off'), value: 0 },
            { label: t('pricing.sync.every_1h'), value: 1 },
            { label: t('pricing.sync.every_6h'), value: 6 },
            { label: t('pricing.sync.every_12h'), value: 12 },
            { label: t('pricing.sync.every_24h'), value: 24 },
          ]}
        />
      </label>
      <Button
        block
        icon={<SyncOutlined spin={Boolean(data?.sync.running)} />}
        loading={syncMutation.isPending}
        disabled={Boolean(data?.sync.running)}
        onClick={() => syncMutation.mutate()}
      >
        {t('pricing.sync_now')}
      </Button>
    </div>
  );

  const tabs = (
    <Segmented<PricingTab>
      value={tab}
      onChange={selectTab}
      options={[
        { value: 'models', label: t('pricing.tab.models') },
        { value: 'channels', label: t('pricing.tab.channels') },
      ]}
    />
  );

  return (
    <div className="terminal-page terminal-page-stack" data-testid="pricing-page">
      <PageHeader
        title={t('pricing.title')}
        mobileActions={(
          <>
            {tabs}
            <ActionMenu label={t('pricing.sync.title')}>
              {syncPanel}
            </ActionMenu>
          </>
        )}
        actions={(
          <>
            {tabs}
            <Popover>
              <PopoverTrigger
                render={(
                  <Button
                    icon={<SyncOutlined spin={Boolean(data?.sync.running)} />}
                    aria-label={t('pricing.sync.title')}
                    data-testid="pricing-sync-status"
                  />
                )}
              />
              <PopoverContent placement="bottomRight">
                <PopoverTitle className="m-0 mb-2 text-base font-semibold text-foreground">
                  {t('pricing.sync.title')}
                </PopoverTitle>
                {syncPanel}
              </PopoverContent>
            </Popover>
          </>
        )}
      >
        {summary}
      </PageHeader>

      {result.isError && (
        <LoadFailure title={t('pricing.load_error')} error={result.error} onRetry={invalidate} />
      )}

      {tab === 'models' ? (
        <section className={styles.workbench} data-testid="pricing-model-list">
          <Toolbar
            end={(
              <>
                <span className={styles.unit}>{t('pricing.unit')}</span>
                <Select
                  className={styles['channel-filter']}
                  value={channelFilter}
                  onChange={(value: string) => setParam('channel', value, '')}
                  aria-label={t('pricing.channel_filter.label')}
                  options={[{ value: '', label: t('pricing.channel_filter.all') }, ...channelOptions]}
                />
                {activeFilter === 'unbilled' && billable.length > 0 && (
                  <ConfirmAction
                    title={t('pricing.reprice_all.confirm', { models: billable.length, n: formatTokensFull(billableRequests) })}
                    description={t('pricing.reprice_all.confirm_note')}
                    confirmLabel={t('pricing.reprice_all.action')}
                    placement="bottomRight"
                    onConfirm={confirmRepriceAll}
                  >
                    <Button icon={<ReceiptOutlined />} loading={repriceAllMutation.isPending} data-testid="pricing-reprice-all">
                      {t('pricing.reprice_all.action')}
                    </Button>
                  </ConfirmAction>
                )}
              </>
            )}
          >
            <SearchInput
              data-testid="pricing-search"
              className={styles.search}
              label={t('pricing.search_placeholder')}
              value={search}
              onChange={setSearch}
            />
            <Segmented<BookFilter>
              className={styles.filters}
              aria-label={t('pricing.filter.label')}
              value={activeFilter}
              onChange={(value) => setParam('filter', value, 'all')}
              options={BOOK_FILTERS
                .filter((value) => value === 'all' || counts[value] > 0)
                .map((value) => ({
                  value,
                  label: (
                    <span className={styles['filter-option']} data-testid={`pricing-filter-${value}`}>
                      {value === 'all' ? t('common.all') : value === 'unbilled' ? t('pricing.filter.unbilled') : t(`pricing.mode.${value}`)}
                      <Count size="small">{counts[value]}</Count>
                    </span>
                  ),
                }))}
            />
          </Toolbar>
          <PriceBookList
            rows={rows}
            isLoading={result.isLoading}
            isBlocked={result.isError && !data}
            emptyText={book.length === 0 ? t('pricing.table.empty') : t('pricing.table.empty_filter')}
            pageResetKey={`${activeFilter}\n${channelFilter}\n${search}`}
            openModel={openModel}
            channelLabel={channelLabel}
            pendingAction={attentionMutation.isPending && attentionMutation.variables
              ? { model: attentionMutation.variables.row.model, action: attentionMutation.variables.action }
              : null}
            pricingModel={repriceMutation.isPending ? repriceMutation.variables ?? null : null}
            onOpen={(model) => openEditor?.(model)}
            onAttention={(row, action) => attentionMutation.mutate({ row, action })}
            onPriceUnpriced={(model) => repriceMutation.mutate(model)}
          />
        </section>
      ) : (
        <ChannelMultipliersPanel
          providers={data?.providers ?? []}
          branding={branding}
          channels={data?.channels ?? []}
          ownPrices={data?.channel_models ?? []}
          isLoading={result.isLoading}
          isBlocked={result.isError && !data}
          onShowModels={showChannel}
        />
      )}
    </div>
  );
};
