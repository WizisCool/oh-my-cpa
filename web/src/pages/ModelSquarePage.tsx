import React from 'react';
import clsx from 'clsx';
import { Button, Drawer, Empty, Input, Pagination } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { LobeIcon, ProviderBrandIcon } from '../components/LobeIcon';
import { BoxOutlined, CheckOutlined, CloseOutlined, CopyOutlined, DownOutlined, ExternalLinkOutlined, LayersOutlined, RightOutlined, SearchOutlined, UpOutlined } from '../components/icons';
import { PageHeader } from '../components/common/PageHeader';
import { PageLoading } from '../components/common/PageLoading';
import { RefreshButton } from '../components/common/RefreshButton';
import { CopyButton } from '../components/common/CopyButton';
import { StatusLabel } from '../components/common/StatusLabel';
import { credentialProviderIconId, getCredentialProviderMetadata } from '../components/common/providerMetadata';
import { LoadFailure, Notice, useToast } from '../components/feedback';
import { useOpenPriceEditor } from '../components/pricing/PricingEditorContext';
import { PRICING_QUERY_KEYS } from '../components/pricing/pricingQueries';
import { useOverlayHistory } from '../hooks/useOverlayHistory';
import { copyText } from '../utils/clipboard';
import { formatRatePer1M } from '../types/pricingDisplay';
import { isUsageFacetsResponse } from '../types/usageEvents';
import { MODEL_REQUEST_FACET_QUERY, buildModelLedger, modelRequestsLink, type ModelLedgerEntry } from '../types/modelSquareLedger';
import {
  buildModelReferenceLinks,
  buildModelSquareEntries,
  classifyModelOpenness,
  countModelManufacturers,
  filterModelSquareEntries,
  isSafeReferenceURL,
  resolveEntryReference,
  resolveModelManufacturer,
  type ModelManufacturer,
  type ModelReference,
  type ModelReferenceLink,
  type ModelSquareEntry,
  type ModelSquareProvider,
} from '../types/modelSquare';
import styles from './ModelSquarePage.module.css';

const PAGE_SIZE = 120;
/** How long the check mark stands in for the copy glyph, matching `CopyButton`. */
const COPIED_MS = 1500;
const KNOWN_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'];

type Translate = ReturnType<typeof useT>;

function manufacturerLabel(manufacturer: ModelManufacturer, t: Translate): string {
  return manufacturer.name || t(manufacturer.id === 'multiple' ? 'models.multiple_makers' : 'models.unknown_maker');
}

/** Below this size a framed glyph is a smudge, so the glyph stands alone. */
const FRAMED_MARK_MIN_SIZE = 20;

/**
 * A maker's mark: its brand artwork, or the console's own glyph where there is no brand to show.
 *
 * The two groups that are not a maker - several makers behind one name, and a maker nobody
 * identified - are drawn from the console's palette rather than at brand weight, so they sit
 * beside the artwork as quiet chrome instead of reading as a tenth, louder brand.
 */
const ManufacturerMark: React.FC<{ manufacturer: ModelManufacturer; size: number }> = ({ manufacturer, size }) => {
  const iconId = manufacturer.modelIconId || manufacturer.iconId;
  if (iconId) return <LobeIcon iconId={iconId} size={size} />;
  const Glyph = manufacturer.id === 'multiple' ? LayersOutlined : BoxOutlined;
  const isFramed = size >= FRAMED_MARK_MIN_SIZE;
  return <span className={clsx(styles['generic-mark'], isFramed && styles['generic-mark-framed'])} style={{ width: size, height: size }} aria-hidden="true">
    <Glyph size={isFramed ? Math.round(size * 0.6) : size} strokeWidth={1.5} />
  </span>;
};

// A connection named after its own adapter ("codex") carries no name of its own, so the adapter's
// display label stands in for it.
/** Marks drawn for a model served by several connections; the count beside them states the rest. */
const MAX_SOURCE_MARKS = 3;

function describeProvider(provider: ModelSquareProvider): { name: string; iconId: string } {
  const hasOwnName = provider.name !== '' && provider.name.toLowerCase() !== provider.family.toLowerCase();
  return {
    name: hasOwnName ? provider.name : getCredentialProviderMetadata(provider.family).label,
    iconId: provider.icon_id || credentialProviderIconId(provider.family, provider.name),
  };
}

function entryProviders(entry: ModelSquareEntry, providers: ReadonlyMap<string, ModelSquareProvider>): ModelSquareProvider[] {
  const ids = [...new Set(entry.routes.map(route => route.provider_id))];
  return ids.flatMap(id => providers.get(id) ?? []);
}

/**
 * The call name as the row's copy control.
 *
 * The directory exists so an operator can take a name to a client, so the name itself is the
 * target rather than a small glyph beside it. What is copied is the advertised call name, never
 * the reference's display name or the upstream identity a connection maps it to.
 */
const CopyModelName: React.FC<{ identity: string }> = ({ identity }) => {
  const t = useT();
  const toast = useToast();
  const [hasCopied, setHasCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>();
  React.useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = async () => {
    if (!(await copyText(identity))) {
      toast.error(t('common.copy_failed'));
      return;
    }
    setHasCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHasCopied(false), COPIED_MS);
  };
  return <button type="button" className={styles['copy-name']} data-copy-model={identity} data-copied={hasCopied || undefined} onClick={() => void copy()} aria-label={hasCopied ? t('common.copied') : t('models.copy_named', { model: identity })}>
    <span className={styles['model-identity']}>{identity}</span>
    {hasCopied ? <CheckOutlined /> : <CopyOutlined />}
  </button>;
};

interface ModelRowProps {
  entry: ModelSquareEntry;
  ledger: ModelLedgerEntry;
  providers: ReadonlyMap<string, ModelSquareProvider>;
  onOpen: (identity: string) => void;
  onSetPrice?: (identity: string) => void;
}

const ModelRow: React.FC<ModelRowProps> = React.memo(({ entry, ledger, providers, onOpen, onSetPrice }) => {
  const t = useT();
  const reference = resolveEntryReference(entry);
  const connections = entryProviders(entry, providers).map(describeProvider);
  const upstream = entry.profiles[0].identity;
  let caption = '';
  // Several routes to one model repeat its name; the caption names each distinct model once.
  if (entry.profiles.length > 1) caption = [...new Set(entry.profiles.map(profile => profile.metadata?.name || profile.identity))].join(' · ');
  else if (reference) caption = reference.name;
  else if (upstream !== entry.identity) caption = upstream;
  const { price } = ledger;

  return <li className={styles['model-row']}>
    <span className={styles['model-name']}>
      <CopyModelName identity={entry.identity} />
      {caption && <span className={styles['model-caption']}>{caption}</span>}
    </span>
    <span className={styles['model-meta']}>
      <span className={styles['model-price']} title={t('models.price_head')}>
        {price.status === 'priced' && <>{formatRatePer1M(price.price.prompt_price_per_1m)} / {formatRatePer1M(price.price.completion_price_per_1m)}</>}
        {price.status === 'unpriced' && (onSetPrice
          ? <button type="button" className={styles['set-price']} onClick={() => onSetPrice(entry.identity)}><StatusLabel tone="warn">{t('pricing.set_price')}</StatusLabel></button>
          : <StatusLabel tone="warn">{t('models.unpriced')}</StatusLabel>)}
      </span>
      <span className={styles['model-sources']}>
        {/* One connection is named. Several would wrap the card to a height its neighbours do not share,
            so they collapse to their marks and a count; the details list every one of them. */}
        {connections.length === 1
          ? <span className={styles['model-source']}><ProviderBrandIcon iconId={connections[0].iconId} size={14} />{connections[0].name}</span>
          : connections.length > 1 && <span className={styles['model-source']} title={connections.map(connection => connection.name).join(' · ')}>
            <span className={styles['source-marks']}>
              {connections.slice(0, MAX_SOURCE_MARKS).map(connection => <ProviderBrandIcon key={connection.name} iconId={connection.iconId} size={14} />)}
            </span>
            {t('models.source_count', { count: connections.length })}
          </span>}
      </span>
    </span>
    {/* Last in the card and stretched over it: everything that is not its own control opens the details. */}
    <button type="button" className={styles['model-details']} data-model-identity={entry.identity} onClick={() => onOpen(entry.identity)} aria-label={t('models.details_for', { model: entry.identity })}>
      <RightOutlined />
    </button>
  </li>;
});
ModelRow.displayName = 'ModelRow';

const ReferenceLinks: React.FC<{ links: readonly Pick<ModelReferenceLink, 'label' | 'url'>[] }> = ({ links }) => <>
  {links.filter(link => isSafeReferenceURL(link.url)).map(link => <a key={link.url} className={styles['reference-link']} href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
    {link.label}<ExternalLinkOutlined />
  </a>)}
</>;

const ModelProfile: React.FC<{ identity: string; metadata?: ModelReference }> = ({ identity, metadata }) => {
  const t = useT();
  const maker = resolveModelManufacturer(identity, metadata);
  const unknown = <span className={styles['is-absent']}>{t('models.unknown')}</span>;
  const text = (value?: string) => value || unknown;
  const limit = (value?: number) => value ? value.toLocaleString() : unknown;
  const modalities = (values?: string[]) => values?.length ? values.map(value => (KNOWN_MODALITIES.includes(value) ? t(`models.modality.${value}`) : value)).join(' · ') : unknown;
  const flag = (value?: boolean) => {
    if (value === undefined) return unknown;
    return value
      ? <span className={styles['flag']}><CheckOutlined className={styles['flag-yes']} />{t('models.supported')}</span>
      : <span className={clsx(styles['flag'], styles['is-absent'])}><CloseOutlined />{t('models.unsupported')}</span>;
  };
  const openness = metadata && classifyModelOpenness(metadata);
  const weightLinks = metadata?.weights?.filter(link => isSafeReferenceURL(link.url)) ?? [];
  const resourceLinks = metadata?.links?.filter(link => isSafeReferenceURL(link.url)) ?? [];

  return <section className={styles['model-profile']}>
    <div className={styles['profile-heading']}>
      <ManufacturerMark manufacturer={maker} size={32} />
      <div>
        <strong>{metadata?.name || identity}</strong>
        <code>{metadata?.id || identity}</code>
      </div>
    </div>
    {metadata ? <>
      {metadata.description && <p className={styles['model-description']}>{metadata.description}</p>}
      <dl className={clsx(styles['stat-tiles'], styles['limit-tiles'])}>
        <div><dt>{t('models.context_window')}</dt><dd>{limit(metadata.limit.context)}</dd></div>
        <div><dt>{t('models.output_limit')}</dt><dd>{limit(metadata.limit.output)}</dd></div>
        <div><dt>{t('models.input_limit')}</dt><dd>{limit(metadata.limit.input)}</dd></div>
      </dl>
      <h3 className={styles['fact-heading']}>{t('models.section_capabilities')}</h3>
      <dl className={styles['model-facts']}>
        <div><dt>{t('models.input_modalities')}</dt><dd>{modalities(metadata.modalities.input)}</dd></div>
        <div><dt>{t('models.output_modalities')}</dt><dd>{modalities(metadata.modalities.output)}</dd></div>
        <div><dt>{t('models.reasoning')}</dt><dd>{flag(metadata.reasoning)}</dd></div>
        <div><dt>{t('models.tool_call')}</dt><dd>{flag(metadata.tool_call)}</dd></div>
        <div><dt>{t('models.structured_output')}</dt><dd>{flag(metadata.structured_output)}</dd></div>
        <div><dt>{t('models.attachment')}</dt><dd>{flag(metadata.attachment)}</dd></div>
      </dl>
      <h3 className={styles['fact-heading']}>{t('models.section_release')}</h3>
      <dl className={styles['model-facts']}>
        <div><dt>{t('models.openness')}</dt><dd>{openness ? t(`models.openness.${openness}`) : unknown}</dd></div>
        <div><dt>{t('models.license')}</dt><dd>{text(metadata.license)}</dd></div>
        <div><dt>{t('models.release_date')}</dt><dd>{text(metadata.release_date)}</dd></div>
        <div><dt>{t('models.knowledge')}</dt><dd>{text(metadata.knowledge)}</dd></div>
        <div><dt>{t('models.last_updated')}</dt><dd>{text(metadata.last_updated)}</dd></div>
      </dl>
      {/* A model the source marks closed has no weights to link to, so only an open or unstated one reports a missing link. */}
      {(weightLinks.length > 0 || metadata.open_weights !== false) && <div className={styles['link-row']}>
        <h3>{t('models.weights')}</h3>
        {weightLinks.length > 0 ? <ReferenceLinks links={weightLinks} /> : <span className={styles['is-absent']}>{t('models.weights_unknown')}</span>}
      </div>}
      {resourceLinks.length > 0 && <div className={styles['link-row']}><h3>{t('models.resources')}</h3><ReferenceLinks links={resourceLinks} /></div>}
    </> : <div className={styles['profile-notice']}><Notice tone="info" title={t('models.metadata_unknown')} /></div>}
    <div className={styles['link-row']} aria-label={t('models.external_resources')}>
      <h3>{t('models.external_resources')}</h3>
      <ReferenceLinks links={buildModelReferenceLinks(identity, metadata)} />
    </div>
  </section>;
};

interface ModelCostProps {
  identity: string;
  ledger: ModelLedgerEntry;
  onSetPrice?: (identity: string) => void;
}

/**
 * What calling this model costs and how much it has been called, with the two places to act.
 *
 * The figures are the price book's and the request records' own; this section only shows them
 * and hands off - to the shared price editor, and to the request list on the same window.
 */
const ModelCost: React.FC<ModelCostProps> = ({ identity, ledger, onSetPrice }) => {
  const t = useT();
  const { price, recentRequests } = ledger;
  const unknown = <span className={styles['is-absent']}>{t('models.unknown')}</span>;
  const noPrice = price.status === 'unpriced' ? <span className={styles['is-absent']}>{t('models.unpriced')}</span> : unknown;
  return <section className={styles['cost-section']} data-testid="model-cost">
    <h3>{t('nav.pricing')}</h3>
    {price.status === 'unpriced' && <Notice tone="warning" title={t('pricing.unpriced_note')} />}
    <dl className={clsx(styles['stat-tiles'], styles['cost-tiles'])}>
      <div><dt>{t('models.input_price')}</dt><dd>{price.status === 'priced' ? formatRatePer1M(price.price.prompt_price_per_1m) : noPrice}</dd></div>
      <div><dt>{t('models.output_price')}</dt><dd>{price.status === 'priced' ? formatRatePer1M(price.price.completion_price_per_1m) : noPrice}</dd></div>
      <div><dt>{t('models.requests_24h')}</dt><dd>{recentRequests === undefined ? unknown : recentRequests.toLocaleString()}</dd></div>
    </dl>
    <div className={styles['cost-actions']}>
      {onSetPrice && price.status !== 'unknown' && <Button type={price.status === 'unpriced' ? 'primary' : 'default'} onClick={() => onSetPrice(identity)}>
        {t(price.status === 'unpriced' ? 'pricing.set_price' : 'pricing.edit')}
      </Button>}
      <Link className={styles['reference-link']} to={modelRequestsLink(identity)}>{t('models.view_requests')}<RightOutlined /></Link>
    </div>
  </section>;
};

export const ModelSquarePage: React.FC = () => {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const manufacturerId = params.get('maker') ?? '';
  const [page, setPage] = React.useState(1);
  const [selectedIdentity, setSelectedIdentity] = React.useState<string>();
  const closeDetails = React.useCallback(() => setSelectedIdentity(undefined), []);
  useOverlayHistory({ isOpen: selectedIdentity !== undefined, onClose: closeDetails });
  const detailsRef = React.useRef<HTMLDivElement>(null);

  const directory = useQuery({ queryKey: ['model-square'], queryFn: () => api.getModelSquare(), staleTime: 30_000 });
  const allEntries = React.useMemo(() => directory.data ? buildModelSquareEntries(directory.data, '') : [], [directory.data]);
  const searched = React.useMemo(() => directory.data ? buildModelSquareEntries(directory.data, search) : [], [directory.data, search]);
  // The maker strip counts what the search leaves, so a count is what selecting that maker will
  // show; the maker filter itself must not zero its own siblings.
  const makers = React.useMemo(() => countModelManufacturers(searched), [searched]);
  const entries = React.useMemo(() => filterModelSquareEntries(searched, manufacturerId), [searched, manufacturerId]);
  const providers = React.useMemo(() => new Map((directory.data?.providers ?? []).map(provider => [provider.id, provider])), [directory.data]);

  // Both neighbours are optional: a price book or request count that cannot be read leaves its
  // cells unstated and the directory itself untouched. The price book shares the pricing page's
  // cache, so a price saved in the editor reaches these rows without a read of their own.
  const pricing = useQuery({ queryKey: PRICING_QUERY_KEYS.book, queryFn: () => api.getPricing(), staleTime: 30_000, retry: false });
  const requests = useQuery({
    queryKey: ['model-square', 'recent-requests'],
    queryFn: async () => {
      const response = await api.getUsageFacets(MODEL_REQUEST_FACET_QUERY);
      if (!isUsageFacetsResponse(response)) throw new Error('usage facets response is incomplete');
      return response;
    },
    staleTime: 30_000,
    retry: false,
  });
  const ledger = React.useMemo(() => buildModelLedger(allEntries.map(entry => entry.identity), pricing.data, requests.data), [allEntries, pricing.data, requests.data]);
  const openPriceEditor = useOpenPriceEditor() ?? undefined;
  const refresh = () => { void directory.refetch(); void pricing.refetch(); void requests.refetch(); };

  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleEntries = entries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const groups = countModelManufacturers(visibleEntries).map(({ manufacturer }) => ({
    manufacturer,
    entries: visibleEntries.filter(entry => entry.manufacturer.id === manufacturer.id),
    total: entries.filter(entry => entry.manufacturer.id === manufacturer.id).length,
  }));

  const updateParams = (change: (next: URLSearchParams) => void) => {
    setPage(1);
    setParams(current => { const next = new URLSearchParams(current); change(next); return next; }, { replace: true });
  };
  const setParam = (name: string, value: string) => updateParams(next => { if (value) next.set(name, value); else next.delete(name); });
  const isFiltered = search !== '' || manufacturerId !== '';
  const clearFilters = () => updateParams(next => { next.delete('q'); next.delete('maker'); });

  const selectedIndex = entries.findIndex(entry => entry.identity === selectedIdentity);
  const selected = selectedIndex >= 0 ? entries[selectedIndex] : allEntries.find(entry => entry.identity === selectedIdentity);
  const stepSelection = (offset: number) => {
    const target = entries[selectedIndex + offset];
    if (!target) return;
    setSelectedIdentity(target.identity);
    // The neighbour's page must be the visible one, so closing the details lands beside it.
    setPage(Math.floor((selectedIndex + offset) / PAGE_SIZE) + 1);
    detailsRef.current?.closest('.ant-drawer-body')?.scrollTo({ top: 0 });
  };
  const selectedRoutes = selected?.routes.filter(route => providers.has(route.provider_id)) ?? [];

  const errorCode = directory.error instanceof ApiError ? (directory.error.data as { code?: string })?.code : undefined;
  const needsKey = errorCode === 'client_key_required' || errorCode === 'client_key_missing';
  const subtitle = directory.data && t('models.summary_line', {
    models: directory.data.models.length,
    makers: countModelManufacturers(allEntries).length,
    date: directory.data.metadata_updated_at,
  });

  return <div className={clsx(styles['page'], 'terminal-page', 'model-square-page')}>
    <PageHeader title={t('nav.model_square')} subtitle={subtitle} actions={<RefreshButton isRefreshing={directory.isFetching || pricing.isFetching || requests.isFetching} onRefresh={refresh} />} />
    {directory.isError && <LoadFailure title={t(needsKey ? 'models.key_required' : 'models.load_failed')} error={directory.error} onRetry={() => void directory.refetch()} />}
    {needsKey && <Link to="/api-keys">{t('models.manage_keys')}</Link>}
    {directory.isPending ? <PageLoading variant="block" /> : directory.data && <>
      <div className={styles['toolbar']}>
        <Input className={styles['search']} allowClear prefix={<SearchOutlined />} aria-label={t('models.search')} placeholder={t('models.search')} value={search} onChange={event => setParam('q', event.target.value)} />
        <span className={styles['result-count']} role="status">
          {isFiltered ? t('models.showing', { shown: entries.length, total: allEntries.length }) : ''}
        </span>
        {isFiltered && <Button type="link" size="small" className={styles['clear-filters']} onClick={clearFilters}>{t('models.clear_filters')}</Button>}
      </div>
      <div className={clsx(styles['chip-group'], styles['maker-strip'])} role="group" aria-label={t('models.filter_makers')}>
        <button type="button" className={styles['chip']} aria-pressed={manufacturerId === ''} onClick={() => setParam('maker', '')}>
          {t('common.all')}<span className={styles['chip-count']}>{searched.length}</span>
        </button>
        {makers.map(({ manufacturer, count }) => <button key={manufacturer.id} type="button" className={styles['chip']} data-maker={manufacturer.id} aria-pressed={manufacturerId === manufacturer.id} onClick={() => setParam('maker', manufacturerId === manufacturer.id ? '' : manufacturer.id)}>
          <ManufacturerMark manufacturer={manufacturer} size={14} />
          {manufacturerLabel(manufacturer, t)}<span className={styles['chip-count']}>{count}</span>
        </button>)}
      </div>
      {directory.data.partial.length > 0 && <Notice tone="warning" title={t('models.provenance_partial')} />}
      {entries.length === 0 ? <Empty className={styles['empty']} description={t(directory.data.models.length ? 'models.no_results' : 'models.empty')}>
        {directory.data.models.length ? <Button onClick={clearFilters}>{t('models.clear_filters')}</Button> : <Link to="/ai-providers">{t('models.manage_connections')}</Link>}
      </Empty> : <ul className={styles['group-list']}>
        {groups.map(group => <li className={styles['model-group']} key={group.manufacturer.id} data-model-group={group.manufacturer.id}>
          <div className={styles['group-heading']}>
            <div className={styles['group-title']}>
              <ManufacturerMark manufacturer={group.manufacturer} size={20} />
              <h2>{manufacturerLabel(group.manufacturer, t)}</h2>
              <span>{t('models.group_count', { count: group.total })}</span>
            </div>
          </div>
          <ul className={styles['model-rows']}>
            {group.entries.map(entry => <ModelRow key={entry.identity} entry={entry} ledger={ledger.entryFor(entry.identity)} providers={providers} onOpen={setSelectedIdentity} onSetPrice={openPriceEditor} />)}
          </ul>
        </li>)}
      </ul>}
      {entries.length > PAGE_SIZE && <Pagination className={styles['pagination']} current={currentPage} pageSize={PAGE_SIZE} total={entries.length} showSizeChanger={false} onChange={setPage} />}
    </>}
    <Drawer
      title={selected?.identity ?? ''}
      extra={selected && <CopyButton text={selected.identity} label={t('models.copy_model')} />}
      open={selected !== undefined}
      onClose={closeDetails}
      size="min(560px, 100vw)"
      className={styles['details-drawer']}
      destroyOnHidden
      footer={selected && selectedIndex >= 0 && entries.length > 1 && <div className={styles['details-footer']}>
        <Button icon={<UpOutlined />} disabled={selectedIndex === 0} onClick={() => stepSelection(-1)}>{t('models.previous')}</Button>
        <Button icon={<DownOutlined />} disabled={selectedIndex === entries.length - 1} onClick={() => stepSelection(1)}>{t('models.next')}</Button>
        <span>{selectedIndex + 1} / {entries.length}</span>
      </div>}
    >
      {selected && <div ref={detailsRef}>
        <ModelCost identity={selected.identity} ledger={ledger.entryFor(selected.identity)} onSetPrice={openPriceEditor} />
        {selectedRoutes.length > 0 && <div className={styles['served-by']}>
          <h3>{t('models.served_by')}</h3>
          <ul>
            {selectedRoutes.map(route => {
              const provider = providers.get(route.provider_id)!;
              const connection = describeProvider(provider);
              return <li key={`${route.provider_id}\n${route.upstream_model}`}>
                <ProviderBrandIcon iconId={connection.iconId} size={16} />
                <span className={styles['served-name']}>{connection.name}</span>
                <span className={styles['served-kind']}>{provider.is_oauth ? 'OAuth' : provider.endpoint_host}</span>
                {route.upstream_model && route.upstream_model !== selected.identity && <code>{route.upstream_model}</code>}
              </li>;
            })}
          </ul>
        </div>}
        {selected.profiles.map(profile => <ModelProfile key={profile.identity} identity={profile.identity} metadata={profile.metadata} />)}
        <p className={styles['scope-note']}>
          {t('models.reference_note')}
          {directory.data?.metadata_updated_at && <> {t('models.snapshot_date', { date: directory.data.metadata_updated_at })}</>}
        </p>
      </div>}
    </Drawer>
  </div>;
};
