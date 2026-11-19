import { translateOr } from '../i18n/catalog';
import { joinPhrases } from '../utils/format';
import React from 'react';
import clsx from 'clsx';
import { Button } from '@/components/ui/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useViewSearchParams, type ViewChangeOptions } from '../hooks/useViewSearchParams';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { resolveProviderMark, type BrandMark, type ProviderBrandSources } from '../types/brandMark';
import { useProviderBranding } from '../hooks/useProviderBranding';
import { LobeIcon, ProviderBrandIcon } from '../components/LobeIcon';
import { AudioOutlined, BoxOutlined, CheckOutlined, CloseOutlined, CopyOutlined, DownOutlined, ExternalLinkOutlined, FileOutlined, FileTextOutlined, LayersOutlined, PictureOutlined, RightOutlined, SyncOutlined, TypeOutlined, UpOutlined, VideoOutlined } from '../components/icons';
import { PageHeader } from '../components/common/PageHeader';
import { CatalogSkeleton } from '../components/common/PageLoading';
import { CopyButton } from '../components/common/CopyButton';
import { StatusLabel } from '../components/common/StatusLabel';
import { EffortTag, Tag } from '../components/common/Tag';
import { Tooltip } from '../components/common/Tooltip';
import { providerDisplayName } from '../types/providerMetadata';
import { LoadFailure, Notice, useToast, type ToastItem } from '../components/feedback';
import { useOpenPriceEditor } from '../components/pricing/PricingEditorContext';
import { PRICING_QUERY_KEYS } from '../components/pricing/pricingQueries';
import { copyText } from '../utils/clipboard';
import { formatRatePer1M } from '../types/pricingDisplay';
import type { PricingResponse } from '../types/pricing';
import { isUsageFacetsResponse } from '../types/usageEvents';
import { MODEL_REQUEST_FACET_QUERY, buildModelLedger, modelRequestsLink, routePricingTarget, type ModelLedgerEntry, type ModelPricingTarget } from '../types/modelSquareLedger';
import {
  buildModelReferenceLinks,
  buildModelSquareEntries,
  countModelManufacturers,
  filterModelSquareEntries,
  isModelCatalogRefreshResult,
  isSafeReferenceURL,
  resolveEntryReference,
  resolveModelManufacturer,
  type ModelCatalogRefreshOutcome,
  type ModelCatalogRefreshResult,
  type ModelManufacturer,
  type ModelReference,
  type ModelReferenceLink,
  type ModelSquareEntry,
  type ModelSquareProvider,
  type ModelSquareRoute,
} from '../types/modelSquare';
import styles from './ModelSquarePage.module.css';
import selectionStyles from '../components/common/selection.module.css';
import { SearchInput } from '../components/common/SearchInput';
import { FilterTransition, useFilterItemMotion } from '../motion/filter';
import { m } from '../motion';
import { EmptyState } from '../components/common/EmptyState';
import { SectionHeading } from '../components/common/SectionHeading';
import { AppDrawer } from '../components/common/AppDrawer';
import { Toolbar } from '../components/common/Toolbar';
import { Pager } from '../components/common/Pager';
import { Count } from '../components/common/Count';
import { IconTileButton } from '../components/common/IconTileButton';
import { IconPickerModal } from '../components/IconPickerModal';
import { useModelIconOverrides } from '../hooks/useModelIconOverrides';
import { resolveModelIconOverride } from '../types/modelIcons';

const PAGE_SIZE = 120;
/** How long the check mark stands in for the copy glyph, matching `CopyButton`. */
const COPIED_MS = 1500;
/** The modalities drawn as a glyph; one the catalog adds later reads as its own name. */
const MODALITY_ICONS: Record<string, React.FC> = {
  text: TypeOutlined, image: PictureOutlined, audio: AudioOutlined, video: VideoOutlined, file: FileOutlined, pdf: FileTextOutlined,
};

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
const ManufacturerMark: React.FC<{ manufacturer: ModelManufacturer; size: number; isBare?: boolean }> = ({ manufacturer, size, isBare = false }) => {
  const iconId = defaultModelIcon(manufacturer);
  if (iconId) return <LobeIcon iconId={iconId} size={size} />;
  const Glyph = manufacturer.id === 'multiple' ? LayersOutlined : BoxOutlined;
  const isFramed = !isBare && size >= FRAMED_MARK_MIN_SIZE;
  return <span className={clsx(styles['generic-mark'], isFramed && styles['generic-mark-framed'])} style={{ width: size, height: size }} aria-hidden="true">
    <Glyph size={isFramed ? Math.round(size * 0.6) : size} strokeWidth={1.5} />
  </span>;
};

const defaultModelIcon = (manufacturer: ModelManufacturer) => manufacturer.modelIconId || manufacturer.iconId;
/** The one upstream an alias routes to, whose chosen icon the alias inherits as `ModelMark` does elsewhere. */
const singleUpstreamIdentity = (entry: ModelSquareEntry) => (entry.profiles.length === 1 ? entry.profiles[0].identity : undefined);

/** A model's mark: the icon the operator chose, else its maker's. Drawn bare inside an `IconTileButton`. */
const ModelIconMark: React.FC<{ manufacturer: ModelManufacturer; iconId?: string; size: number }> = ({ manufacturer, iconId, size }) => iconId
  ? <LobeIcon iconId={iconId} size={size} />
  : <ManufacturerMark manufacturer={manufacturer} size={size} isBare />;

// A connection named after its own adapter ("codex") carries no name of its own, so the adapter's
// display label stands in for it.
/** Marks drawn for a model served by several connections; the count beside them states the rest. */
const MAX_SOURCE_MARKS = 3;

function describeProvider(provider: ModelSquareProvider, branding: ProviderBrandSources): BrandMark & { id: string; name: string } {
  const hasOwnName = provider.name !== '' && provider.name.toLowerCase() !== provider.family.toLowerCase();
  return {
    id: provider.id,
    // Only an OAuth family is a plugin's provider; an API-key family is a dialect a plugin cannot rename.
    name: hasOwnName ? provider.name : providerDisplayName(provider.family, provider.is_oauth ? branding.pluginTitles : undefined),
    ...resolveProviderMark({ ...provider, base_url: provider.endpoint_host }, branding),
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
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
  branding: ProviderBrandSources;
  entry: ModelSquareEntry;
  ledger: ModelLedgerEntry;
  providers: ReadonlyMap<string, ModelSquareProvider>;
  /** The icon the operator chose for this model, if any. */
  iconId?: string;
  onOpen: (identity: string) => void;
  onPickIcon: (identity: string) => void;
  onSetPrice?: (identity: string) => void;
}

const ModelRow: React.FC<ModelRowProps> = React.memo(({ entry, ledger, providers, branding, iconId, onOpen, onPickIcon, onSetPrice }) => {
  const t = useT();
  const filterMotion = useFilterItemMotion();
  const reference = resolveEntryReference(entry);
  const connections = entryProviders(entry, providers).map(provider => describeProvider(provider, branding));
  const upstream = entry.profiles[0].identity;
  let caption = '';
  // Several routes to one model repeat its name; the caption names each distinct model once.
  if (entry.profiles.length > 1) caption = joinPhrases(t, [...new Set(entry.profiles.map(profile => profile.metadata?.name || profile.identity))]);
  else if (reference) caption = reference.name;
  else if (upstream !== entry.identity) caption = upstream;
  const { price } = ledger;

  return <m.li {...filterMotion} className={styles['model-row']}>
    <IconTileButton className={styles['model-icon']} label={t('models.change_icon_for', { model: entry.identity })} data-model-icon={entry.identity} onClick={() => onPickIcon(entry.identity)}>
      <ModelIconMark manufacturer={entry.manufacturer} iconId={iconId} size={20} />
    </IconTileButton>
    <span className={styles['model-name']}>
      <CopyModelName identity={entry.identity} />
      {caption && <span className={styles['model-caption']}>{caption}</span>}
    </span>
    <span className={styles['model-meta']}>
      <span className={styles['model-price']} data-tip={t('models.price_head')}>
        {price.status === 'priced' && <>{formatRatePer1M(price.price.prompt_price_per_1m)} / {formatRatePer1M(price.price.completion_price_per_1m)}</>}
        {price.status === 'unpriced' && (onSetPrice && ledger.pricingTargets.length > 0
          ? <button type="button" className={styles['set-price']} onClick={() => onSetPrice(entry.identity)}><StatusLabel tone="warn" trailing={<RightOutlined />}>{t('pricing.set_price')}</StatusLabel></button>
          : <StatusLabel tone="warn">{t('models.unpriced')}</StatusLabel>)}
      </span>
      <span className={styles['model-sources']}>
        {/* One connection is named. Several would wrap the card to a height its neighbours do not share,
            so they collapse to their marks and a count; the details list every one of them. */}
        {connections.length === 1
          ? <span className={styles['model-source']}><ProviderBrandIcon mark={connections[0]} size={14} />{connections[0].name}</span>
          : connections.length > 1 && <span className={styles['model-source']} data-tip={connections.map(connection => connection.name).join(', ')}>
            <span className={styles['source-marks']}>
              {connections.slice(0, MAX_SOURCE_MARKS).map(connection => <ProviderBrandIcon key={connection.id} mark={connection} size={14} />)}
            </span>
            {t('models.source_count', { count: connections.length })}
          </span>}
      </span>
    </span>
    {/* Last in the card and stretched over it: everything that is not its own control opens the details. */}
    <button type="button" className={styles['model-details']} data-focus-ring="outer" data-model-identity={entry.identity} onClick={() => onOpen(entry.identity)} aria-label={t('models.details_for', { model: entry.identity })}>
      <RightOutlined />
    </button>
  </m.li>;
});
ModelRow.displayName = 'ModelRow';

const ReferenceLinks: React.FC<{ links: readonly ModelReferenceLink[] }> = ({ links }) => <>
  {links.filter(link => isSafeReferenceURL(link.url)).map(link => <a key={link.url} className={styles['reference-link']} href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
    {link.label}<ExternalLinkOutlined />
  </a>)}
</>;

// OpenRouter names the parameters a model accepts; these two stand for capabilities an operator asks about.
const TOOL_PARAMETERS = ['tools'];
const STRUCTURED_OUTPUT_PARAMETERS = ['structured_outputs', 'response_format'];
const REASONING_PARAMETERS = ['reasoning', 'include_reasoning'];

interface ModelProfileProps {
  identity: string;
  metadata?: ModelReference;
  /** The icon the operator chose for the model this profile describes, if any. */
  iconId?: string;
  onPickIcon: () => void;
}

const ModelProfile: React.FC<ModelProfileProps> = ({ identity, metadata, iconId, onPickIcon }) => {
  const t = useT();
  const maker = resolveModelManufacturer(identity, metadata);
  const unknown = <span className={styles['is-absent']}>{t('models.unknown')}</span>;
  const limit = (value?: number) => value ? value.toLocaleString() : unknown;
  const modalities = (values: readonly string[]) => values.length ? <span className={styles['modality-list']}>
    {values.map(value => {
      const Icon = Object.prototype.hasOwnProperty.call(MODALITY_ICONS, value) ? MODALITY_ICONS[value] : undefined;
      if (!Icon) return <Tag key={value} size="small">{value}</Tag>;
      const label = translateOr(t, `models.modality.${value}`, value);
      return <Tooltip key={value} title={label}>
        <span className={styles['modality-mark']} role="img" aria-label={label} tabIndex={0}><Icon /></span>
      </Tooltip>;
    })}
  </span> : unknown;
  const flag = (isSupported: boolean, label = t('models.supported')) => isSupported
    ? <span className={styles['flag']}><CheckOutlined className={styles['flag-yes']} />{label}</span>
    : <span className={clsx(styles['flag'], styles['is-absent'])}><CloseOutlined />{t('models.unsupported')}</span>;

  if (!metadata) return <section className={styles['model-profile']}>
    <ProfileHeading identity={identity} maker={maker} iconId={iconId} onPickIcon={onPickIcon} />
    <div className={styles['profile-notice']}><Notice tone="info" title={t('models.metadata_unknown')} /></div>
    <ExternalLookup identity={identity} />
  </section>;

  const parameters = metadata.supported_parameters;
  // Parameters are the catalog's only word on a capability; with none listed it has said nothing.
  const parameterFlag = (names: readonly string[]) => parameters.length ? flag(names.some(name => parameters.includes(name))) : unknown;
  const { reasoning } = metadata;
  const reasoningMode = reasoning && t(reasoning.mandatory ? 'models.reasoning_mandatory' : reasoning.default_enabled ? 'models.reasoning_default_on' : 'models.reasoning_default_off');
  const weightsURL = metadata.hugging_face_id ? `https://huggingface.co/${metadata.hugging_face_id.split('/').map(encodeURIComponent).join('/')}` : '';

  return <section className={styles['model-profile']}>
    <ProfileHeading identity={identity} maker={maker} metadata={metadata} iconId={iconId} onPickIcon={onPickIcon} />
    {metadata.description && <p className={styles['model-description']}>{metadata.description}</p>}
    <dl className={clsx(styles['stat-tiles'], styles['limit-tiles'])}>
      <div><dt>{t('models.context_window')}</dt><dd>{limit(metadata.context_length)}</dd></div>
      <div><dt>{t('models.output_limit')}</dt><dd>{limit(metadata.max_completion_tokens)}</dd></div>
    </dl>
    <SectionHeading level="label" className={styles['fact-heading']} title={t('models.section_capabilities')} />
    <dl className={styles['model-facts']}>
      <div><dt>{t('models.input_modalities')}</dt><dd>{modalities(metadata.input_modalities)}</dd></div>
      <div><dt>{t('models.output_modalities')}</dt><dd>{modalities(metadata.output_modalities)}</dd></div>
      <div><dt>{t('models.tool_call')}</dt><dd>{parameterFlag(TOOL_PARAMETERS)}</dd></div>
      <div><dt>{t('models.structured_output')}</dt><dd>{parameterFlag(STRUCTURED_OUTPUT_PARAMETERS)}</dd></div>
      <div><dt>{t('models.reasoning')}</dt><dd>{reasoningMode ? flag(true, reasoningMode) : parameterFlag(REASONING_PARAMETERS)}</dd></div>
      {reasoning?.default_effort && <div><dt>{t('models.default_effort')}</dt><dd><EffortTag effort={reasoning.default_effort} /></dd></div>}
      {reasoning && reasoning.supported_efforts.length > 0 && <div className={styles['fact-wide']}>
        <dt>{t('models.reasoning_efforts')}</dt>
        <dd className={styles['tag-list']}>{reasoning.supported_efforts.map(level => <EffortTag key={level} effort={level} />)}</dd>
      </div>}
      <div className={styles['fact-wide']}>
        <dt>{t('models.supported_parameters')}</dt>
        <dd className={styles['tag-list']}>{parameters.length ? parameters.map(name => <Tag key={name} size="small" className={styles['parameter']}>{name}</Tag>) : unknown}</dd>
      </div>
    </dl>
    <SectionHeading level="label" className={styles['fact-heading']} title={t('models.section_details')} />
    <dl className={styles['model-facts']}>
      <div><dt>{t('models.knowledge')}</dt><dd>{metadata.knowledge_cutoff || unknown}</dd></div>
      {/* Only an open-weight model names a repository; a closed one has nothing to report missing. */}
      {weightsURL && isSafeReferenceURL(weightsURL) && <div>
        <dt>{t('models.weights')}</dt>
        <dd><a className={styles['inline-link']} href={weightsURL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{metadata.hugging_face_id}<ExternalLinkOutlined /></a></dd>
      </div>}
    </dl>
    <ExternalLookup identity={identity} metadata={metadata} />
  </section>;
};

const ProfileHeading: React.FC<{ identity: string; maker: ModelManufacturer; metadata?: ModelReference; iconId?: string; onPickIcon: () => void }> = ({ identity, maker, metadata, iconId, onPickIcon }) => {
  const t = useT();
  return <div className={styles['profile-heading']}>
    <IconTileButton size="lg" label={t('models.change_icon_for', { model: metadata?.name || identity })} data-testid="model-profile-icon" onClick={onPickIcon}>
      <ModelIconMark manufacturer={maker} iconId={iconId} size={28} />
    </IconTileButton>
    <div>
      <strong>{metadata?.name || identity}</strong>
      <code>{metadata?.id || identity}</code>
    </div>
  </div>;
};

const ExternalLookup: React.FC<{ identity: string; metadata?: ModelReference }> = ({ identity, metadata }) => {
  const t = useT();
  return <div className={styles['link-row']} aria-label={t('models.external_resources')}>
    <h3>{t('models.external_resources')}</h3>
    <ReferenceLinks links={buildModelReferenceLinks(identity, metadata)} />
  </div>;
};

interface ModelConnectionsProps {
  identity: string;
  ledger: ModelLedgerEntry;
  routes: readonly ModelSquareRoute[];
  providers: ReadonlyMap<string, ModelSquareProvider>;
  branding: ProviderBrandSources;
  pricing?: PricingResponse;
  onSetPrice?: (target: ModelPricingTarget) => void;
}

const targetKey = (target: ModelPricingTarget) => JSON.stringify([target.channel, target.model]);

/**
 * Which connections serve this model, what calling it costs and how much it has been called.
 *
 * One price reads as the model's own. When connections price it apart, each connection states and
 * edits its own price on its row, so no model-wide figure pretends to cover them all. The figures
 * are the price book's and the request records' own; this section shows them and hands off - to
 * the shared price editor, and to the request list on the same window.
 */
const ModelConnections: React.FC<ModelConnectionsProps> = ({ identity, ledger, routes, providers, branding, pricing, onSetPrice }) => {
  const t = useT();
  const { price, recentRequests, pricingTargets } = ledger;
  const isPricedApart = pricingTargets.length > 1;
  const unknown = <span className={styles['is-absent']}>{t('models.unknown')}</span>;
  const noPrice = price.status === 'unpriced' ? <span className={styles['is-absent']}>{t('models.unpriced')}</span> : unknown;
  const requestCount = recentRequests === undefined ? unknown : recentRequests.toLocaleString();
  const requestsLink = <Link className={styles['reference-link']} to={modelRequestsLink(identity)}>{t('models.view_requests')}<RightOutlined /></Link>;
  const rows = routes.map(route => ({ route, target: isPricedApart ? routePricingTarget(route, pricing, pricingTargets) : undefined }));
  const onRows = new Set(rows.flatMap(row => row.target ? [targetKey(row.target)] : []));
  // A target no listed connection carries still needs a way to be priced.
  const looseTargets = pricingTargets.filter(target => !onRows.has(targetKey(target)));
  const actions = onSetPrice ? looseTargets.map(target => <Button key={targetKey(target)} variant={target.price ? 'secondary' : 'primary'} onClick={() => onSetPrice(target)}>
    {t(target.price ? 'pricing.edit' : 'pricing.set_price')}
    {isPricedApart && <span className={styles['target-scope']}>{target.channelLabel || target.channel ? `${target.channelLabel || target.channel} / ${target.model}` : target.model}</span>}
  </Button>) : [];

  return <section className={styles['connections-section']} data-testid="model-cost">
    <SectionHeading level="label" className={styles['fact-heading']} title={t('models.section_connections_pricing')} />
    {isPricedApart
      ? <div className={styles['request-strip']}>
        <span className={styles['request-strip-label']}>{t('models.requests_24h')}</span>
        <strong>{requestCount}</strong>
        {requestsLink}
      </div>
      : <>
        {price.status === 'unpriced' && <div className={styles['profile-notice']}><Notice tone="warning" title={t('pricing.unpriced_note')} /></div>}
        <dl className={clsx(styles['stat-tiles'], styles['cost-tiles'])}>
          <div><dt>{t('models.input_price')}</dt><dd>{price.status === 'priced' ? formatRatePer1M(price.price.prompt_price_per_1m) : noPrice}</dd></div>
          <div><dt>{t('models.output_price')}</dt><dd>{price.status === 'priced' ? formatRatePer1M(price.price.completion_price_per_1m) : noPrice}</dd></div>
          <div><dt>{t('models.requests_24h')}</dt><dd>{requestCount}</dd></div>
        </dl>
      </>}
    {rows.length > 0 && <ul className={styles['connection-list']}>
      {rows.map(({ route, target }) => {
        const provider = providers.get(route.provider_id)!;
        const connection = describeProvider(provider, branding);
        const isAlias = route.upstream_model !== '' && route.upstream_model !== identity;
        return <li key={`${route.provider_id}\n${route.upstream_model}`}>
          <div className={styles['connection-main']}>
            <span className={styles['connection-name']}>
              <ProviderBrandIcon mark={connection} size={16} />
              <span className={styles['served-name']}>{connection.name}</span>
              <span className={styles['served-kind']}>{provider.is_oauth ? 'OAuth' : provider.endpoint_host}</span>
            </span>
            {isAlias && <span className={styles['connection-alias']}>{t('models.upstream_model')}<code>{route.upstream_model}</code></span>}
          </div>
          {target && <div className={styles['connection-price']}>
            <span className={styles['model-price']} data-tip={t('models.price_head')}>
              {target.price
                ? <>{formatRatePer1M(target.price.prompt_price_per_1m)} / {formatRatePer1M(target.price.completion_price_per_1m)}</>
                : <StatusLabel tone="warn">{t('models.unpriced')}</StatusLabel>}
            </span>
            {onSetPrice && <Button size="sm" variant="ghost" onClick={() => onSetPrice(target)}>{t(target.price ? 'pricing.edit' : 'pricing.set_price')}</Button>}
          </div>}
        </li>;
      })}
    </ul>}
    {(actions.length > 0 || !isPricedApart) && <div className={styles['cost-actions']}>
      {actions}
      {!isPricedApart && requestsLink}
    </div>}
  </section>;
};

/**
 * The page's one refresh: has CPA fetch its model catalogs, then re-reads everything they feed.
 *
 * CPA decides which catalogs it refreshes and which its configuration skips, so the report names
 * a catalog only when its outcome needs the operator's attention: a failure, or a skip beside a
 * refresh. The page owns its own readings and passes them in as `onReread`; the model-rule
 * catalogs elsewhere in the console are invalidated here.
 */
const CatalogRefreshButton: React.FC<{ onReread: () => Promise<unknown> }> = ({ onReread }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  // Inactive reads are only marked stale, so a model-rule drawer opened later reads the new catalog.
  const reread = () => Promise.allSettled([
    onReread(),
    queryClient.invalidateQueries({ queryKey: ['management-oauth-provider-models'] }),
    queryClient.invalidateQueries({ queryKey: ['auth-file-models'] }),
  ]);
  const report = (result: ModelCatalogRefreshResult) => {
    const catalogName = (catalog: ModelCatalogRefreshOutcome['catalog']) => t(`models.catalog_name.${catalog}`);
    const failed = result.catalogs.filter(outcome => outcome.status === 'error');
    const skipped = result.catalogs.filter(outcome => outcome.status === 'skipped');
    if (failed.length > 0) {
      // Failures lead, each with its reason; the catalogs that refreshed or were skipped follow
      // under their own headings, so the operator sees exactly which ones need attention.
      const items: ToastItem[] = [...failed, ...result.catalogs.filter(outcome => outcome.status !== 'error')].map(outcome => ({
        name: catalogName(outcome.catalog),
        group: t(`models.catalog_status.${outcome.status}`),
        reason: outcome.error_code && t(`models.catalog_error.${outcome.error_code}`),
      }));
      const isTotal = failed.length === result.catalogs.length;
      (isTotal ? toast.error : toast.warning)(t(isTotal ? 'models.catalogs_failed' : 'models.catalogs_partial'), { items });
      return;
    }
    // `ok` is the verdict: a success is reported only when the server vouches for the whole refresh.
    if (!result.ok) {
      toast.warning(t('models.catalogs_unconfirmed'));
      return;
    }
    if (skipped.length === result.catalogs.length) {
      toast.info(t('models.catalogs_all_skipped'));
      return;
    }
    if (skipped.length > 0) {
      const catalogs = joinPhrases(t, skipped.map(outcome => catalogName(outcome.catalog)));
      toast.info(t('models.catalogs_refreshed_with_skips'), { detail: t('models.catalogs_skipped_by_config', { catalogs }) });
      return;
    }
    toast.success(t('models.catalogs_refreshed'));
  };
  const refresh = useMutation({
    // Every outcome re-reads: CPA may have refreshed some catalogs even when no readable report
    // came back. The re-read belongs to the mutation, so the button stays busy until the page
    // shows what the refresh left behind and a second click cannot send a second POST.
    mutationFn: async () => {
      try {
        return await api.refreshModelCatalogs();
      } finally {
        await reread();
      }
    },
    onSuccess: report,
    onError: error => {
      if (error instanceof ApiError && error.status === 502 && isModelCatalogRefreshResult(error.data)) report(error.data);
      else if (error instanceof ApiError && error.status === 501) toast.warning(t('models.catalogs_unsupported'));
      else toast.error(t('models.catalogs_failed'), { error });
    },
  });
  return <Button
    icon={<SyncOutlined spin={refresh.isPending} />}
    aria-busy={refresh.isPending}
    disabled={refresh.isPending}
    data-testid="model-catalog-refresh"
    onClick={() => refresh.mutate()}
  >
    {t('models.refresh_catalogs')}
  </Button>;
};

export const ModelSquarePage: React.FC = () => {
  const branding = useProviderBranding();
  const t = useT();
  const [params, setParams] = useViewSearchParams();
  const search = params.get('q') ?? '';
  const manufacturerId = params.get('maker') ?? '';
  const [page, setPage] = React.useState(1);
  const [selectedIdentity, setSelectedIdentity] = React.useState<string>();
  const closeDetails = React.useCallback(() => setSelectedIdentity(undefined), []);
  const detailsRef = React.useRef<HTMLDivElement>(null);
  const toast = useToast();
  const { modelIcons, writeModelIcon, resetModelIcon } = useModelIconOverrides();
  const [iconTarget, setIconTarget] = React.useState<string>();

  const directory = useQuery({
    queryKey: ['model-square'],
    queryFn: () => api.getModelSquare(),
    staleTime: 30_000,
    // Pick up the first background sweep promptly, then follow periodic cache refreshes.
    refetchInterval: query => query.state.data?.partial.includes('routes') ? 5_000 : 60_000,
  });
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
  const ledger = React.useMemo(() => buildModelLedger(allEntries.map(entry => entry.identity), pricing.data, requests.data, directory.data?.routes), [allEntries, pricing.data, requests.data, directory.data?.routes]);
  const openEditor = useOpenPriceEditor();
  const openPriceEditor = openEditor ? (identity: string) => {
    const targets = ledger.entryFor(identity).pricingTargets;
    if (targets.length === 1) openEditor(targets[0].model, targets[0]);
    else if (targets.length > 1) setSelectedIdentity(identity);
  } : undefined;
  // The editor takes over from the details rather than opening a second drawer over them.
  const priceFromDetails = openEditor ? (target: ModelPricingTarget) => {
    closeDetails();
    openEditor(target.model, target);
  } : undefined;
  const reread = () => Promise.all([directory.refetch(), pricing.refetch(), requests.refetch()]);

  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleEntries = entries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const groups = countModelManufacturers(visibleEntries).map(({ manufacturer }) => ({
    manufacturer,
    entries: visibleEntries.filter(entry => entry.manufacturer.id === manufacturer.id),
    total: entries.filter(entry => entry.manufacturer.id === manufacturer.id).length,
  }));

  const updateParams = (change: (next: URLSearchParams) => void, options?: ViewChangeOptions) => {
    setPage(1);
    setParams(current => { const next = new URLSearchParams(current); change(next); return next; }, options);
  };
  // Typing a search is one step of Back; choosing a maker is another.
  const setParam = (name: string, value: string) => updateParams(next => { if (value) next.set(name, value); else next.delete(name); }, name === 'q' ? { coalesce: 'q' } : undefined);
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
    detailsRef.current?.closest('[data-slot="sheet-body"]')?.scrollTo({ top: 0 });
  };
  const iconEntry = iconTarget === undefined ? undefined : allEntries.find(entry => entry.identity === iconTarget);
  // Only the model's own choice can be reset; an icon inherited from its upstream is that model's to change.
  const iconOverride = iconTarget === undefined ? undefined : resolveModelIconOverride(modelIcons, iconTarget);
  const iconShown = iconEntry && (resolveModelIconOverride(modelIcons, iconEntry.identity, singleUpstreamIdentity(iconEntry)) ?? defaultModelIcon(iconEntry.manufacturer));
  const closeIconPicker = () => setIconTarget(undefined);
  // A failed write keeps the picker open; usePreference has already reported why.
  const pickIcon = async (icon: string) => {
    if (iconTarget === undefined) return false;
    const { ok } = await writeModelIcon(iconTarget, icon);
    if (ok) toast.success(t('models.icon_saved'));
    return ok;
  };
  const resetIcon = async () => {
    if (iconTarget === undefined) return false;
    const { ok } = await resetModelIcon(iconTarget);
    if (ok) toast.success(t('models.icon_reset'));
    return ok;
  };
  const selectedIcon = selected && resolveModelIconOverride(modelIcons, selected.identity, singleUpstreamIdentity(selected));
  const selectedRoutes = selected?.routes.filter(route => providers.has(route.provider_id)) ?? [];
  const matchedProfiles = selected?.profiles.filter(profile => profile.metadata !== undefined) ?? [];

  const errorCode = directory.error instanceof ApiError ? (directory.error.data as { code?: string })?.code : undefined;
  const needsKey = errorCode === 'client_key_required' || errorCode === 'client_key_missing';
  const subtitle = directory.data && t('models.summary_line', {
    models: directory.data.models.length,
    makers: countModelManufacturers(allEntries).length,
  });

  return <div className={clsx(styles['page'], 'terminal-page', 'model-square-page')}>
    <PageHeader title={t('nav.model_square')} subtitle={subtitle} actions={<CatalogRefreshButton onReread={reread} />} />
    {directory.isError && <LoadFailure title={t(needsKey ? 'models.key_required' : 'models.load_failed')} error={directory.error} onRetry={() => void directory.refetch()} />}
    {needsKey && <Link to="/api-keys">{t('models.manage_keys')}</Link>}
    {directory.isPending ? <CatalogSkeleton hasHeader={false} /> : directory.data && <>
      <Toolbar>
        <SearchInput className={styles['search']} label={t('models.search')} value={search} onChange={(text) => setParam('q', text)} />
        <span className={styles['result-count']} role="status">
          {isFiltered ? t('models.showing', { shown: entries.length, total: allEntries.length }) : ''}
        </span>
        {isFiltered && <Button variant="link" size="sm" className={styles['clear-filters']} onClick={clearFilters}>{t('models.clear_filters')}</Button>}
      </Toolbar>
      <div className={clsx(styles['chip-group'], styles['maker-strip'], 'scroll-fade-x')} role="group" aria-label={t('models.filter_makers')}>
        <button type="button" className={clsx(styles['chip'], selectionStyles['selection-control'])} aria-pressed={manufacturerId === ''} onClick={() => setParam('maker', '')}>
          {t('common.all')}<Count size="small">{searched.length}</Count>
        </button>
        {makers.map(({ manufacturer, count }) => <button key={manufacturer.id} type="button" className={clsx(styles['chip'], selectionStyles['selection-control'])} data-maker={manufacturer.id} aria-pressed={manufacturerId === manufacturer.id} onClick={() => setParam('maker', manufacturerId === manufacturer.id ? '' : manufacturer.id)}>
          <ManufacturerMark manufacturer={manufacturer} size={14} />
          {manufacturerLabel(manufacturer, t)}<Count size="small">{count}</Count>
        </button>)}
      </div>
      {directory.data.partial.length > 0 && <Notice tone="warning" title={t('models.provenance_partial')} />}
      {entries.length === 0 ? <EmptyState className={styles['empty']} title={t(directory.data.models.length ? 'models.no_results' : 'models.empty')}>
        {directory.data.models.length ? <Button onClick={clearFilters}>{t('models.clear_filters')}</Button> : <Link to="/ai-providers">{t('models.manage_connections')}</Link>}
      </EmptyState> : <ul className={styles['group-list']}>
        {groups.map(group => <li className={styles['model-group']} key={group.manufacturer.id} data-model-group={group.manufacturer.id}>
          <div className={styles['group-heading']}>
            <div className={styles['group-title']}>
              <ManufacturerMark manufacturer={group.manufacturer} size={20} />
              <h2>{manufacturerLabel(group.manufacturer, t)}</h2>
              <span>{t('models.group_count', { count: group.total })}</span>
            </div>
          </div>
          <ul className={styles['model-rows']}>
            <FilterTransition itemKeys={group.entries.map((entry) => entry.identity)}>
              {group.entries.map(entry => <ModelRow branding={branding} key={entry.identity} entry={entry} ledger={ledger.entryFor(entry.identity)} providers={providers} iconId={resolveModelIconOverride(modelIcons, entry.identity, singleUpstreamIdentity(entry))} onOpen={setSelectedIdentity} onPickIcon={setIconTarget} onSetPrice={openPriceEditor} />)}
            </FilterTransition>
          </ul>
        </li>)}
      </ul>}
      <Pager className={styles['pagination']} page={currentPage} pageSize={PAGE_SIZE} total={entries.length} onChange={setPage} />
    </>}
    <AppDrawer
      widthKey="model_details"
      title={selected?.identity ?? ''}
      extra={selected && <CopyButton text={selected.identity} label={t('models.copy_model')} />}
      open={selected !== undefined}
      onClose={closeDetails}
      className={styles['details-drawer']}
      destroyOnHidden
      footerStart={selected && selectedIndex >= 0 && entries.length > 1 && <>
        <Button icon={<UpOutlined />} disabled={selectedIndex === 0} onClick={() => stepSelection(-1)}>{t('models.previous')}</Button>
        <Button icon={<DownOutlined />} disabled={selectedIndex === entries.length - 1} onClick={() => stepSelection(1)}>{t('models.next')}</Button>
      </>}
      footer={selected && selectedIndex >= 0 && entries.length > 1 && <span className={styles['details-position']}>{selectedIndex + 1} / {entries.length}</span>}
    >
      {selected && <div ref={detailsRef}>
        {matchedProfiles.length > 0
          ? matchedProfiles.map(profile => <ModelProfile key={profile.identity} identity={profile.identity} metadata={profile.metadata} iconId={matchedProfiles.length > 1 ? resolveModelIconOverride(modelIcons, selected.identity, profile.identity) : selectedIcon} onPickIcon={() => setIconTarget(selected.identity)} />)
          // Unmatched names say so once; each connection row below names the upstream it routes to.
          : <ModelProfile identity={selected.profiles.length === 1 ? selected.profiles[0].identity : selected.identity} iconId={selectedIcon} onPickIcon={() => setIconTarget(selected.identity)} />}
        <ModelConnections identity={selected.identity} ledger={ledger.entryFor(selected.identity)} routes={selectedRoutes} providers={providers} branding={branding} pricing={pricing.data} onSetPrice={priceFromDetails} />
        {matchedProfiles.length > 0 && <p className={styles['scope-note']}>{t('models.reference_note')}</p>}
      </div>}
    </AppDrawer>
    <IconPickerModal
      open={iconTarget !== undefined}
      title={t('models.icon_picker_title')}
      currentIcon={iconShown}
      canReset={iconOverride !== undefined}
      onSelect={pickIcon}
      onReset={resetIcon}
      onClose={closeIconPicker}
    />
  </div>;
};
