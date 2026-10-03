import { ActionMenu } from '../../components/common/ActionMenu';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Button, Input, Pagination, Popover, Segmented, Select, Tooltip } from 'antd';
import dayjs from '../../utils/time';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditOutlined, LinkOutlined, SearchOutlined, SyncOutlined } from '../../components/icons';
import { api, ApiError, describeError } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { formatTimeAgo } from '../../utils/format';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { PageHeader } from '../../components/common/PageHeader';
import { RefreshButton } from '../../components/common/RefreshButton';
import { ResponsiveList } from '../../components/common/ResponsiveList';
import { StatusLabel, type StatusTone } from '../../components/common/StatusLabel';
import { FactList } from '../../components/common/FactList';
import type { PricedModel, PricingCandidate, PricingMode, PricingResponse, PricingUsage, UnpricedModel, UpstreamModel } from '../../types/pricing';
import { formatMultiplier, formatRatePer1M, matchesModelSearch, modeOf } from '../../types/pricingDisplay';
import { useOpenPriceEditor } from '../../components/pricing/PricingEditorContext';
import { PRICING_QUERY_KEYS } from '../../components/pricing/pricingQueries';
import { TierBadges } from '../../components/pricing/PricingParts';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { pluginOAuthProviderLogos, pluginOAuthLogoFor } from '../../types/pluginOAuthProviders';
import { groupPricingModels, pagePricingGroups } from '../../types/pricingGroups';
import { pricingModelIdentity, pricingProviderIdentity } from '../../components/pricing/pricingIdentity';
import { pricingErrorText } from '../../components/pricing/pricingErrors';
import { ChannelMultipliersPanel } from './ChannelMultipliersPanel';
import { UsageCell } from './UsageCell';
import styles from './PricingPage.module.css';
import { LoadFailure, Notice, useToast } from '../../components/feedback';

/** One page of the price list, shared by both renderings so a page means the same thing at either width. */
const PAGE_SIZE = 20;

type PricingTab = 'models' | 'channels';
/** `candidates` narrows to custom and linked models OpenRouter has a new price for. */
type ModelFilter = 'all' | PricingMode | 'unpriced' | 'candidates';

/** A row of the book: a priced model, or a current model with no price yet. */
type BookRow =
  | (PricedModel & { rowKind: 'priced' })
  | { rowKind: 'unpriced'; model: string; usage_30d: PricingUsage; suggestions: UpstreamModel[] };

function rowMode(row: BookRow): ModelFilter {
  return row.rowKind === 'unpriced' ? 'unpriced' : modeOf(row);
}

const MODE_TONES: Record<ModelFilter, StatusTone> = {
  all: 'neutral',
  auto: 'success',
  linked: 'success',
  custom: 'accent',
  unpriced: 'warn',
  candidates: 'accent',
};

function syncTone(data: PricingResponse | undefined): StatusTone {
  if (!data) return 'neutral';
  if (data.sync.running) return 'accent';
  if (data.sync.state.last_error) return 'danger';
  return data.sync.state.last_success_at_ms ? 'success' : 'warn';
}

function syncSummary(t: TFunc, data: PricingResponse | undefined): string {
  if (!data) return t('pricing.sync.source_name');
  if (data.sync.running) return t('pricing.sync.running');
  if (data.sync.state.last_error) return t('pricing.sync.failed_short');
  const success = data.sync.state.last_success_at_ms;
  return success ? t('pricing.sync.synced_ago', { time: formatTimeAgo(success, Date.now(), t) }) : t('pricing.sync.never');
}

/**
 * The line a custom or linked row carries when OpenRouter has a price the operator has not answered:
 * which model, at what list rate, and the two ways to answer it.
 */
const CandidateLine: React.FC<{
  row: PricedModel;
  candidate: PricingCandidate;
  pendingAction?: 'adopt' | 'dismiss';
  onAct: (action: 'adopt' | 'dismiss') => void;
}> = ({ row, candidate, pendingAction, onAct }) => {
  const t = useT();
  const isAutomatic = candidate.kind === 'automatic';
  const rates = `${formatRatePer1M(candidate.model.prompt_price_per_1m)} / ${formatRatePer1M(candidate.model.completion_price_per_1m)}`;
  return (
    <div className={styles.candidate} data-testid="pricing-row-candidate" data-kind={candidate.kind}>
      <span className={styles['candidate-text']} title={candidate.model.id}>
        {t(isAutomatic ? 'pricing.candidate.automatic' : 'pricing.candidate.suggested', { id: candidate.model.id, rates })}
      </span>
      <span className={styles['candidate-actions']}>
        <Button
          size="small"
          type="link"
          icon={isAutomatic ? <SyncOutlined /> : <LinkOutlined />}
          loading={pendingAction === 'adopt'}
          disabled={pendingAction === 'dismiss'}
          onClick={() => onAct('adopt')}
          aria-label={`${t(isAutomatic ? 'pricing.candidate.follow' : 'pricing.attention.adopt')}: ${row.model}`}
          data-testid="pricing-candidate-adopt"
        >
          {t(isAutomatic ? 'pricing.candidate.follow' : 'pricing.attention.adopt')}
        </Button>
        <Button
          size="small"
          type="link"
          loading={pendingAction === 'dismiss'}
          disabled={pendingAction === 'adopt'}
          onClick={() => onAct('dismiss')}
          aria-label={`${t('pricing.candidate.dismiss')}: ${row.model}`}
          data-testid="pricing-candidate-dismiss"
        >
          {t('pricing.candidate.dismiss')}
        </Button>
      </span>
    </div>
  );
};

/**
 * The price book. OpenRouter prices every model it can match without the operator doing anything;
 * this page is where the rest is decided - the models that need a price, the ones an operator
 * pinned or priced by hand, and the multipliers for channels that do not bill list price.
 */
export const PricingPage: React.FC = () => {
  useTimeZone();
  const t = useT();
  const isDemo = isDemoMode();
  const toast = useToast();
  const queryClient = useQueryClient();
  const openEditor = useOpenPriceEditor();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: PricingTab = searchParams.get('tab') === 'channels' ? 'channels' : 'models';
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<ModelFilter>('all');
  const [providerFilter, setProviderFilter] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const isPhone = useIsPhoneViewport();
  const listRef = React.useRef<HTMLElement>(null);
  const plugins = useQuery({ queryKey: ['management-plugins'], queryFn: api.getPlugins, staleTime: 30_000 });
  const pluginLogos = React.useMemo(() => pluginOAuthProviderLogos(plugins.data?.plugins), [plugins.data?.plugins]);
  React.useEffect(() => { setPage(1); }, [search, filter, providerFilter]);

  const result = useQuery({
    queryKey: PRICING_QUERY_KEYS.book,
    queryFn: api.getPricing,
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.sync.running ? 2_500 : false),
  });
  const data = result.data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.book });
    void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.attention });
  };
  const invalidateModel = (model: string) => {
    invalidate();
    void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.model(model) });
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

  // Adopting a suggestion is a link, saved in one click from its model row without opening the editor.
  const adoptMutation = useMutation({
    mutationFn: ({ model, upstream }: { model: string; upstream: UpstreamModel }) =>
      api.updatePricingModel(model, { mode: 'linked', upstream_id: upstream.id }),
    onSuccess: (_, { model, upstream }) => {
      toast.success(t('pricing.adopted', { model, id: upstream.id }));
      invalidate();
    },
    onError: (err) => toast.error(t('pricing.save_failed', { msg: pricingErrorText(t, err) })),
  });

  // A candidate is answered in its row: follow it (auto mode when it is the automatic match, a
  // link when it only resembles the model), or ignore it until OpenRouter offers a different one.
  // Either way the operator's channel multiplier carries over.
  const candidateMutation = useMutation({
    mutationFn: async ({ row, candidate, action }: { row: PricedModel; candidate: PricingCandidate; action: 'adopt' | 'dismiss' }): Promise<unknown> => {
      if (action === 'dismiss') return api.dismissPricingCandidate(row.model, candidate.model.id);
      return candidate.kind === 'automatic'
        ? api.updatePricingModel(row.model, { mode: 'auto', price_multiplier: row.price_multiplier })
        : api.updatePricingModel(row.model, { mode: 'linked', upstream_id: candidate.model.id, price_multiplier: row.price_multiplier });
    },
    onSuccess: (_, { row, candidate, action }) => {
      if (action === 'dismiss') toast.info(t('pricing.candidate.dismissed', { model: row.model }));
      else toast.success(t(candidate.kind === 'automatic' ? 'pricing.candidate.followed' : 'pricing.adopted', { model: row.model, id: candidate.model.id }));
      invalidateModel(row.model);
    },
    onError: (err, { action }) => toast.error(t(action === 'dismiss' ? 'pricing.candidate.dismiss_failed' : 'pricing.save_failed', { msg: pricingErrorText(t, err) })),
  });

  const rows = React.useMemo<BookRow[]>(() => {
    if (!data) return [];
    const priced = data.models.map((model): BookRow => ({ ...model, rowKind: 'priced' }));
    const unpriced = data.unpriced.map((item: UnpricedModel): BookRow => ({ rowKind: 'unpriced', ...item }));
    return [...priced, ...unpriced];
  }, [data]);

  const counts = React.useMemo(() => {
    const result: Record<ModelFilter, number> = { all: rows.length, auto: 0, linked: 0, custom: 0, unpriced: 0, candidates: 0 };
    rows.forEach((row) => {
      result[rowMode(row)] += 1;
      if (row.rowKind === 'priced' && row.candidate) result.candidates += 1;
    });
    return result;
  }, [rows]);

  const visibleRows = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === 'candidates') {
        if (row.rowKind !== 'priced' || !row.candidate) return false;
      } else if (filter !== 'all' && rowMode(row) !== filter) return false;
      if (!query) return true;
      const upstream = row.rowKind === 'priced' ? row.upstream_id : '';
      return matchesModelSearch(query, row.model, upstream);
    });
  }, [rows, search, filter]);

  const allGroups = React.useMemo(() => groupPricingModels(rows, data?.providers ?? []), [rows, data?.providers]);
  const groups = React.useMemo(() => groupPricingModels(visibleRows, data?.providers ?? []), [visibleRows, data?.providers]);
  const filteredGroups = groups.filter((group) => providerFilter === 'all' || group.id === providerFilter);
  const totalRows = filteredGroups.reduce((total, group) => total + group.rows.length, 0);
  const safePage = Math.min(page, Math.max(1, Math.ceil(totalRows / PAGE_SIZE)));
  const pageGroups = pagePricingGroups(filteredGroups, safePage, PAGE_SIZE);
  const changePage = (nextPage: number) => {
    setPage(nextPage);
    if (listRef.current && listRef.current.getBoundingClientRect().top < 0) listRef.current.scrollIntoView({ block: 'start' });
  };
  const pagination = { current: safePage, pageSize: PAGE_SIZE, total: totalRows, showSizeChanger: false, hideOnSinglePage: true, onChange: changePage };


  const selectTab = (next: PricingTab) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    if (next === 'models') params.delete('tab');
    else params.set('tab', next);
    return params;
  }, { replace: true });

  const priceColumns = [
    {
      title: t('pricing.col.model'),
      key: 'model',
      render: (_: unknown, row: BookRow) => (
        <div className={styles['model-cell']}>
          <div className={styles['model-text']}>
            <span className={styles['model-name']} title={row.model}>{pricingModelIdentity(row.model).label}</span>
            {row.rowKind === 'priced' ? (
              <span className={styles['model-sub']}>
                {row.upstream_id || (row.source === 'modelsdev' ? t('pricing.source.modelsdev') : t('pricing.source.manual'))}
              </span>
            ) : null}
            {row.rowKind === 'priced' && <TierBadges tiers={row.tiers} />}
            {row.rowKind === 'priced' && row.candidate && (
              <CandidateLine
                row={row}
                candidate={row.candidate}
                pendingAction={candidateMutation.isPending && candidateMutation.variables?.row.model === row.model ? candidateMutation.variables.action : undefined}
                onAct={(action) => row.candidate && candidateMutation.mutate({ row, candidate: row.candidate, action })}
              />
            )}
            {row.rowKind === 'unpriced' && row.suggestions[0] && (
              <div className={styles['suggestion']}>
                <span className={styles['model-sub']} title={row.suggestions[0].id}>
                  {t('pricing.attention.suggestion', { id: row.suggestions[0].id })}
                </span>
                <Button
                  size="small"
                  type="link"
                  icon={<LinkOutlined />}
                  loading={adoptMutation.isPending && adoptMutation.variables?.model === row.model}
                  onClick={() => adoptMutation.mutate({ model: row.model, upstream: row.suggestions[0] })}
                  data-testid="pricing-row-adopt"
                >
                  {t('pricing.attention.adopt')}
                </Button>
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      title: t('pricing.col.input'),
      key: 'input',
      align: 'right' as const,
      width: 104,
      render: (_: unknown, row: BookRow) => (row.rowKind === 'priced'
        ? <span className={styles.rate}>{formatRatePer1M(row.prompt_price_per_1m)}</span>
        : <span className={styles.dimmed}>—</span>),
    },
    {
      title: t('pricing.col.output'),
      key: 'output',
      align: 'right' as const,
      width: 104,
      render: (_: unknown, row: BookRow) => (row.rowKind === 'priced'
        ? <span className={styles.rate}>{formatRatePer1M(row.completion_price_per_1m)}</span>
        : <span className={styles.dimmed}>—</span>),
    },
    {
      title: t('pricing.col.cache'),
      key: 'cache',
      align: 'right' as const,
      width: 150,
      render: (_: unknown, row: BookRow) => (row.rowKind === 'priced' ? (
        <span className={styles.rate}>
          {formatRatePer1M(row.cache_read_price_per_1m)}
          <span className={styles.dimmed}> / </span>
          {formatRatePer1M(row.cache_write_price_per_1m)}
        </span>
      ) : <span className={styles.dimmed}>—</span>),
    },
    {
      title: t('pricing.col.pricing'),
      key: 'mode',
      width: 150,
      render: (_: unknown, row: BookRow) => {
        const mode = rowMode(row);
        return (
          <div className={styles['mode-cell']}>
            <Tooltip title={mode === 'unpriced' ? t('pricing.unpriced_note') : undefined}>
            <StatusLabel tone={MODE_TONES[mode]}>
              {row.rowKind === 'priced' && row.source === 'modelsdev' ? t('pricing.mode.legacy') : t(`pricing.mode.${mode}`)}
            </StatusLabel>
            </Tooltip>
            {row.rowKind === 'priced' && (mode === 'auto' && row.match_kind && row.match_kind !== 'exact' || row.price_multiplier !== 1) && (
              <span className={styles['model-sub']}>
                {[
                  mode === 'auto' && row.match_kind && row.match_kind !== 'exact' ? t(`pricing.match.${row.match_kind}`) : '',
                  row.price_multiplier !== 1 ? formatMultiplier(row.price_multiplier) : '',
                ].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        );
      },
    },
    {
      title: t('pricing.col.usage'),
      key: 'usage',
      align: 'right' as const,
      width: 150,
      render: (_: unknown, row: BookRow) => <UsageCell usage={row.usage_30d} scope={{ key: 'model', value: row.model }} />,
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 64,
      align: 'right' as const,
      render: (_: unknown, row: BookRow) => (
        <div className="row-actions">
          <Tooltip title={row.rowKind === 'priced' ? t('pricing.edit') : t('pricing.set_price')}>
            <Button
              size="small"
              className="row-action-btn"
              icon={<EditOutlined />}
              onClick={() => openEditor?.(row.model)}
              aria-label={`${row.rowKind === 'priced' ? t('pricing.edit') : t('pricing.set_price')}: ${row.model}`}
              data-testid="pricing-row-edit"
            />
          </Tooltip>
        </div>
      ),
    },
  ];

  const modelTotal = rows.length;
  const pricedTotal = data?.models.length ?? 0;
  const subtitle = data
    ? t('pricing.coverage', { priced: pricedTotal, total: modelTotal })
    : undefined;

  const syncPopover = (
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
        // The sync reaches OpenRouter. The demonstration prices its own fixture instead, so the
        // server refuses this and the button says so.
        disabled={isDemo || Boolean(data?.sync.running)}
        title={isDemo ? t('demo.blocked') : undefined}
        onClick={() => syncMutation.mutate()}
      >
        {t('pricing.sync_now')}
      </Button>
    </div>
  );

  return (
    <div className="terminal-page terminal-page-stack" data-testid="pricing-page">
      <PageHeader
        title={t('pricing.title')}
        subtitle={subtitle}
        mobileActions={(
          <>
            <Segmented value={tab} onChange={(value) => selectTab(value as PricingTab)} options={[
              { value: 'models', label: t('pricing.tab.models') }, { value: 'channels', label: t('pricing.tab.channels') },
            ]} />
            <ActionMenu>
              <RefreshButton isRefreshing={result.isFetching} onRefresh={invalidate} />
              <span className="action-menu-label"><StatusLabel tone={syncTone(data)}>{syncSummary(t, data)}</StatusLabel></span>
              {syncPopover}
            </ActionMenu>
          </>
        )}
        actions={(
          <>
            <Segmented
              value={tab}
              onChange={(value) => selectTab(value as PricingTab)}
              options={[
                { value: 'models', label: t('pricing.tab.models') },
                { value: 'channels', label: t('pricing.tab.channels') },
              ]}
            />
            <RefreshButton isRefreshing={result.isFetching} onRefresh={invalidate} />
            <Popover content={syncPopover} trigger="click" placement="bottomRight" title={t('pricing.sync.title')}>
              <Button className={styles['sync-button']} data-testid="pricing-sync-status">
                <StatusLabel tone={syncTone(data)}>{syncSummary(t, data)}</StatusLabel>
              </Button>
            </Popover>
          </>
        )}
      />

      {result.isError && (
        <LoadFailure title={t('pricing.load_error')} error={result.error} onRetry={invalidate} />
      )}

      {tab === 'models' ? (
        <section className={styles.workbench} data-testid="pricing-model-list" ref={listRef}>
          <div className={styles.toolbar}>
            <Segmented<ModelFilter>
              value={filter}
              onChange={setFilter}
              options={(['all', 'auto', 'linked', 'custom', 'unpriced', 'candidates'] as const)
                .filter((value) => value === 'all' || value === filter || counts[value] > 0)
                .map((value) => ({
                  value,
                  label: (
                    <span className={styles['filter-option']}>
                      {value === 'all' ? t('common.all') : value === 'candidates' ? t('pricing.candidate.filter') : t(`pricing.mode.${value}`)}
                      <span className={styles['filter-count']}>{counts[value]}</span>
                    </span>
                  ),
                }))}
            />
            <Select
              className={styles['provider-filter']}
              value={providerFilter}
              onChange={setProviderFilter}
              aria-label={t('pricing.provider.filter')}
              options={[
                { value: 'all', label: t('pricing.provider.all') },
                ...allGroups.map((group) => ({ value: group.id, label: group.provider ? pricingProviderIdentity(group.provider).label : t('pricing.provider.unassigned') })),
              ]}
            />
            <Input
              data-testid="pricing-search"
              className={styles.search}
              placeholder={t('pricing.search_placeholder')}
              aria-label={t('pricing.search_placeholder')}
              prefix={<SearchOutlined aria-hidden="true" />}
              value={search}
              allowClear
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {pageGroups.length === 0 && (
            <ResponsiveList<BookRow>
              columns={priceColumns} dataSource={[]} rowKey="model"
              isLoading={result.isLoading} isBlocked={result.isError && !data}
              emptyText={rows.length === 0 ? t('pricing.table.empty') : t('pricing.table.empty_filter')}
              phone={{ identity: 'model', actions: ['actions'] }} tableProps={{ size: 'small' }}
            />
          )}
          {pageGroups.map((group, groupIndex) => {
            const identity = group.provider ? pricingProviderIdentity(group.provider) : null;
            return (
              <section key={group.id} className={styles['provider-group']} data-testid="pricing-provider-group" aria-label={identity?.label ?? t('pricing.provider.unassigned')}>
                <header className={styles['provider-heading']}>
                  {group.provider && <ProviderBrandIcon iconId={identity?.iconId} providerKeys={[group.provider.family, group.provider.name]} logo={pluginOAuthLogoFor(pluginLogos, group.provider.family) ?? pluginOAuthLogoFor(pluginLogos, group.provider.name)} size={20} />}
                  <h2>{identity?.label ?? t('pricing.provider.unassigned')}</h2>
                  {group.provider && <span className={styles.dimmed}>{group.provider.is_oauth ? t('pricing.provider.oauth') : t('pricing.provider.api')} · {t('omc.priority_value', { n: group.provider.priority })}</span>}
                </header>
                {/* The columns are the same fixed set in every group, so their names are drawn
                    once, above the first group; repeating them per provider put a header row
                    beside every one-model group and doubled the page's height. Later groups
                    keep their header row for assistive technology, visually hidden. */}
                <ResponsiveList<BookRow>
                  columns={priceColumns} dataSource={group.rows} rowKey="model"
                  isLoading={result.isLoading} isBlocked={result.isError && !data}
                  emptyText={t('pricing.table.empty_filter')}
                  phone={{ identity: 'model', actions: ['actions'] }} tableProps={{ size: 'small', className: groupIndex === 0 ? undefined : 'data-table-head-hidden' }}
                />
              </section>
            );
          })}
          {totalRows > 0 && (
            <nav className={styles['pagination-bar']} aria-label={t('pricing.pagination.label')} data-testid="pricing-pagination">
              <span className={styles['pagination-range']} aria-live="polite" aria-atomic="true">
                {t('pricing.pagination.range', { start: (safePage - 1) * PAGE_SIZE + 1, end: Math.min(safePage * PAGE_SIZE, totalRows), total: totalRows })}
              </span>
              <Pagination {...pagination} size="small" showLessItems simple={isPhone ? { readOnly: true } : false} />
            </nav>
          )}
        </section>
      ) : (
        <ChannelMultipliersPanel providers={data?.providers ?? []} pluginLogos={pluginLogos} channels={data?.channels ?? []} isLoading={result.isLoading} isBlocked={result.isError && !data} />
      )}
    </div>
  );
};
