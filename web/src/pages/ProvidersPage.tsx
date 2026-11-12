import type { MessageKey } from '../i18n/catalog';
import { FilterDisclosure } from '../components/common/FilterDisclosure';
import React, { useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PlusOutlined } from '../components/icons';
import { PageHeader } from '../components/common/PageHeader';
import { StatTiles } from '../components/common/StatTiles';
import { StatusLabel, type StatusTone } from '../components/common/StatusLabel';

import { useT } from '../i18n';
import { getProviderDefaultIcon } from '../types/providerIconIds';
import { DeferredMount } from '../components/common/DeferredMount';
import { createRouteLoader } from '../utils/routeLoader';
import { resolveProviderPickerIcon } from '../types/brandMark';
import { lookupProviderFamily, PROVIDER_FAMILIES } from '../types/providerFamilies';
import { SUCCESS_RATE_HEALTHY_PERCENT, successRateTone } from '../types/usageEventMetrics';
import { useProviderIconOverrides } from '../components/providers/useProviderIconOverrides';
import { usePluginOAuthLogos } from '../hooks/usePluginOAuthLogos';
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport';
import { useProviderList } from '../components/providers/useProviderList';
import { useProviderManagement } from '../components/providers/useProviderManagement';

import { ProviderTable } from '../components/providers/ProviderTable';
import { useProviderOrder } from '../components/providers/useProviderOrder';
import styles from './ProvidersPage.module.css';
import {
  DEFAULT_PROVIDER_FILTERS,
  needsAttention,
  providerTrafficById,
  summarizeProviders,
  totalProviderTraffic,
  type ProviderListFilters,
  type ProviderStatusFilter,
} from '../components/providers/providerOverview';
import { api } from '../api/client';
import { LoadFailure, useToast } from '../components/feedback';
import { SearchInput } from '../components/common/SearchInput';
import { Toolbar } from '../components/common/Toolbar';
import { Count } from '../components/common/Count';
import { SummaryStrip } from '../components/common/SummaryStrip';

const ProviderEditorDrawer = React.lazy(createRouteLoader(() =>
  import('../components/providers/ProviderEditorDrawer').then(module => ({ default: module.ProviderEditorDrawer }))));
const IconPickerModal = React.lazy(createRouteLoader(() =>
  import('../components/IconPickerModal').then(module => ({ default: module.IconPickerModal }))));

/**
 * The window the list's traffic column counts. It is the key list's window too, so the two pages
 * that report traffic per row agree on what "recent" means.
 */

const TRAFFIC_WINDOW_QUERY = 'preset=24h';

const STATUS_TILES: readonly { key: ProviderStatusFilter; tone: StatusTone; labelKey: MessageKey }[] = [
  { key: 'all', tone: 'neutral', labelKey: 'pro.stat_all' },
  { key: 'active', tone: 'success', labelKey: 'pro.status_active' },
  { key: 'disabled', tone: 'warn', labelKey: 'pro.status_disabled' },
  { key: 'attention', tone: 'danger', labelKey: 'pro.stat_attention' },
];

export const ProvidersPage: React.FC = () => {
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const toast = useToast();

  const { providerIcons, writeProviderIcon, shiftCachedProviderIcons } = useProviderIconOverrides();
  // A plugin-registered provider's own logo outranks everything the console stores
  // for it, because the plugin owns that provider's identity.
  const pluginLogos = usePluginOAuthLogos();
  const {
    providers,
    providersLoading,
    providersError,
    providersErr,
    refetchProviders,
    settleProviderRow,
  } = useProviderList();
  const {
    createProviderMutation,
    deleteProviderMutation,
    updateProviderMutation,
    toggleProviderStatus,
    busyProviderIds,
    testingKeyIds,
    isTestingAllKeys,
    providerDrawerOpen,
    editingProvider,
    formFamily,
    setFormFamily,
    formName,
    setFormName,
    formBaseURL,
    setFormBaseURL,
    formWebsite,
    setFormWebsite,
    formPrefix,
    setFormPrefix,
    formPriority,
    setFormPriority,
    formDisabled,
    setFormDisabled,
    formConnectionPool,
    setFormConnectionPool,
    formPolicy,
    setFormPolicy,
    formBehavior,
    setFormBehavior,
    policySectionOpen,
    setPolicySectionOpen,
    isPolicyChecked,
    formKeys,
    setFormKeys,
    formHeaders,
    setFormHeaders,
    formModels,
    setFormModels,
    formTestModel,
    setFormTestModel,
    formIcon,
    iconManuallySelected,
    setIconManuallySelected,
    iconPickerOpen,
    setIconPickerOpen,
    targetProviderForIcon,
    setTargetProviderForIcon,
    renameProvider,
    keysSectionOpen,
    setKeysSectionOpen,
    headersSectionOpen,
    setHeadersSectionOpen,
    modelsSectionOpen,
    setModelsSectionOpen,
    expandedKeyIds,
    setExpandedKeyIds,
    expandedModelIds,
    setExpandedModelIds,
    endpointModels,
    setEndpointModels,
    isPullingModels,
    modelFetchSeqRef,
    websiteInputState,
    handlePullModels,
    isModelPickerOpen,
    setIsModelPickerOpen,
    handleAddPickedModels,
    toggleModelExpanded,
    handleAddModel,
    updateModelImage,
    toggleThinkingLevel,
    setThinkingLevels,
    handleSelectIcon,
    toggleKeyExpanded,
    handleKeyAdd,
    handleTestKey,
    handleTestAllKeys,
    handleCloseProviderDrawer,
    handleOpenCreate,
    handleOpenEdit,
    handleSaveProvider,
    setFormIcon,
    setIsPullingModels,
  } = useProviderManagement({
    toast,
    t,
    providerIcons,
    writeProviderIcon,
    shiftCachedProviderIcons,
    settleProviderRow,
  });

  // A drill-down link names the provider it wants opened. The effect resolves it
  // against the loaded list rather than reopening on every render, so a closed
  // drawer stays closed while the same link is still in the address bar.
  const [searchParams] = useSearchParams();
  const targetProviderParam = searchParams.get('provider');
  const handledTargetRef = useRef<string | null>(null);

  React.useEffect(() => {
    if (!targetProviderParam || providersLoading || providers.length === 0) return;
    if (handledTargetRef.current === targetProviderParam) return;
    handledTargetRef.current = targetProviderParam;
    const norm = targetProviderParam.toLowerCase().trim();
    const matched = providers.find(
      (p) =>
        p.id.toLowerCase() === norm ||
        p.name?.toLowerCase() === norm ||
        p.upstream_name?.toLowerCase() === norm ||
        p.family?.toLowerCase() === norm
    );
    if (matched) {
      handleOpenEdit(matched);
    }
  }, [targetProviderParam, providersLoading, providers]);

  // Family labels and the picker's options both come from the family registry, so a
  // family the console manages cannot appear in one and not the other.
  const familyDisplayNames: Record<string, string> = Object.fromEntries(
    PROVIDER_FAMILIES.map((family) => [family.id, t(family.labelKey)]),
  );

  // The window's traffic per provider. It is the dashboard's own read, so a request is credited
  // to the same row here as in the dashboard's provider panel. A partial answer is withheld
  // rather than shown: a provider missing from it would read as having served nothing.
  const trafficQuery = useQuery({
    queryKey: ['dashboard-providers', TRAFFIC_WINDOW_QUERY],
    queryFn: () => api.getDashboardProviders(TRAFFIC_WINDOW_QUERY),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });
  // Read defensively: the traffic column is an addition to the list, so a malformed answer must
  // leave the column unknown rather than take the page down with it.
  const windowProviders = Array.isArray(trafficQuery.data?.providers) && !trafficQuery.data.partial_errors?.length
    ? trafficQuery.data.providers
    : undefined;
  const windowCredentials = trafficQuery.data?.credentials;
  const traffic = React.useMemo(
    () => providerTrafficById(providers, windowProviders, Array.isArray(windowCredentials) ? windowCredentials : []),
    [providers, windowProviders, windowCredentials],
  );
  const windowTotals = React.useMemo(() => totalProviderTraffic(providers, traffic), [providers, traffic]);

  const [filters, setFilters] = React.useState<ProviderListFilters>(DEFAULT_PROVIDER_FILTERS);
  const updateFilters = (patch: Partial<ProviderListFilters>) => setFilters((previous) => ({ ...previous, ...patch }));
  const isFiltered = filters.status !== 'all' || filters.family !== 'all' || filters.search.trim() !== '';

  // The same reading of "is this provider on?" the row's switch and label use, so a tile never
  // counts a row as enabled while the row itself shows the operator's newer intent.
  const providerOrder = useProviderOrder(providers);
  const overview = summarizeProviders(
    providerOrder.ordered,
    filters,
    (provider) => !provider.disabled,
    traffic,
  );
  const hasList = !providersLoading && !(providersError && providers.length === 0);

  const totalProviders = providers.length;
  const isProviderEnabled = (p: typeof providers[number]) => !p.disabled;
  const activeCount = providers.filter((p) => isProviderEnabled(p)).length;
  const attentionCount = providers.filter((p) => {
    const enabled = isProviderEnabled(p);
    return needsAttention(p, enabled, traffic?.get(p.id));
  }).length;
  const disabledCount = providers.filter((p) => !isProviderEnabled(p)).length;

  const summary = (hasList && totalProviders > 0) || providersLoading ? (
    <SummaryStrip>
      <SummaryStrip.Total>
        {t('af.meta_total', { n: providersLoading ? '—' : totalProviders })}
      </SummaryStrip.Total>
      <SummaryStrip.Divider />
      <SummaryStrip.Item tone="healthy">
        {t('af.meta_active', { n: providersLoading ? '—' : activeCount })}
      </SummaryStrip.Item>
      {(!providersLoading && attentionCount > 0) && (
        <>
          <SummaryStrip.Divider />
          <SummaryStrip.Item tone="attention">
            {t('omc.quota_filter_attention')} {attentionCount}
          </SummaryStrip.Item>
        </>
      )}
      {(!providersLoading && disabledCount > 0) && (
        <>
          <SummaryStrip.Divider />
          <SummaryStrip.Item tone="disabled">
            {t('af.meta_disabled', { n: disabledCount })}
          </SummaryStrip.Item>
        </>
      )}
    </SummaryStrip>
  ) : undefined;

  // Families present in the list, in the registry's order, then any the registry does not know.
  const familyOptions = [
    ...PROVIDER_FAMILIES.map((family) => family.id),
    ...Object.keys(overview.familyCounts).filter((family) => !lookupProviderFamily(family)),
  ].filter((family) => family === filters.family || (overview.familyCounts[family] ?? 0) > 0);

  const rateTone = successRateTone(windowTotals?.successRate);

  return (
    <div className="terminal-page terminal-page-stack providers-page">
      <PageHeader
        title={t('pro.title')}
        mobileActions={(
          <>
            <Button variant="primary" icon={<PlusOutlined />} onClick={handleOpenCreate}>{t('pro.add_provider')}</Button>
          </>
        )}
        actions={(
          <>
            {/* Creating a provider writes the gateway's configuration, which the demonstration
                refuses; the drawer still opens so the form can be read. */}
            <Button variant="primary" icon={<PlusOutlined />} onClick={handleOpenCreate}>
              {t('pro.add_provider')}
            </Button>
          </>
        )}
      >
        {/* On a phone the status filter below states the same counts, one line further down. */}
        {!isPhone && summary}
      </PageHeader>

      {providersError && (
        <LoadFailure title={t('common.load_failed_title')} error={providersErr} onRetry={() => void refetchProviders()} />
      )}

      <section className={styles['provider-overview']}>
        <StatTiles
          ariaLabel={t('pro.status_filter')}
          testId="provider-stats"
          tileTestIdPrefix="provider-stat"
          selected={filters.status}
          onSelect={(status) => updateFilters({ status })}
          tiles={STATUS_TILES.map((tile) => ({
            key: tile.key,
            label: t(tile.labelKey),
            count: hasList ? overview.statusCounts[tile.key] : undefined,
            tone: tile.tone,
            hint: tile.key === 'attention' ? t('pro.stat_attention_hint', { n: SUCCESS_RATE_HEALTHY_PERCENT }) : undefined,
          }))}
        />

        <Toolbar variant="ruled" className="logs-toolbar">
          <SearchInput
            className={styles['provider-search']}
            label={t('pro.search_placeholder')}
            value={filters.search}
            onChange={(text) => updateFilters({ search: text })}
          />
          <FilterDisclosure activeLabel={filters.family !== 'all' ? familyDisplayNames[filters.family] ?? filters.family : undefined}>
            <Select
              className={styles['provider-family-filter']}
              value={filters.family}
              aria-label={t('pro.family_filter')}
              popupMatchSelectWidth={false}
              onChange={(family: string) => updateFilters({ family })}
              options={[
                { value: 'all', label: t('pro.family_all') },
                ...familyOptions.map((family) => ({
                  value: family,
                  label: (
                    <span className={styles['family-option']}>
                      <span>{familyDisplayNames[family] ?? family}</span>
                      <Count>{overview.familyCounts[family] ?? 0}</Count>
                    </span>
                  ),
                })),
              ]}
            />
            {isFiltered && (
              <Button variant="link" size="sm" onClick={() => setFilters(DEFAULT_PROVIDER_FILTERS)}>
                {t('pro.clear_filters')}
              </Button>
            )}
          </FilterDisclosure>
          {/* The window's totals over every configured provider, whatever the filters show: the
              line answers "how busy is the gateway's provider pool", not "how busy is this view". */}
          <div className={styles['window-summary']} data-testid="provider-window-summary">
            <span className={styles['window-label']}>{t('pro.window_24h')}</span>
            {windowTotals ? (
              <>
                <span>{t('pro.traffic_requests', { n: windowTotals.total.toLocaleString() })}</span>
                {windowTotals.successRate !== null && (
                  <StatusLabel tone={rateTone}>
                    {t('pro.window_success_rate', { rate: windowTotals.successRate.toFixed(1) })}
                  </StatusLabel>
                )}
              </>
            ) : (
              <span>{trafficQuery.isPending ? '…' : t('pro.traffic_unknown')}</span>
            )}
          </div>
        </Toolbar>
      </section>

      <ProviderTable
        providers={overview.visible}
        providersLoading={providersLoading}
        isBlocked={providersError && providers.length === 0}
        emptyText={providers.length > 0 ? t('pro.providers_filter_empty') : t('pro.providers_empty')}
        traffic={traffic}
        providerIcons={providerIcons}
        pluginLogos={pluginLogos}
        toggleProviderStatus={toggleProviderStatus}
        busyProviderIds={busyProviderIds}
        deleteProviderMutation={deleteProviderMutation}
        handleOpenEdit={handleOpenEdit}
        setIconPickerOpen={setIconPickerOpen}
        setTargetProviderForIcon={setTargetProviderForIcon}
        onRename={renameProvider}
        onMove={providerOrder.loaded ? providerOrder.move : undefined}
      />

      {/* Provider Rich Drawer */}
      <DeferredMount isActive={providerDrawerOpen}>
        <ProviderEditorDrawer
          familyDisplayNames={familyDisplayNames}
          createProviderMutation={createProviderMutation}
          updateProviderMutation={updateProviderMutation}
          providerDrawerOpen={providerDrawerOpen}
          editingProvider={editingProvider}
          formFamily={formFamily}
          setFormFamily={setFormFamily}
          formName={formName}
          setFormName={setFormName}
          formBaseURL={formBaseURL}
          setFormBaseURL={setFormBaseURL}
          formWebsite={formWebsite}
          setFormWebsite={setFormWebsite}
          formPrefix={formPrefix}
          setFormPrefix={setFormPrefix}
          formPriority={formPriority}
          setFormPriority={setFormPriority}
          formDisabled={formDisabled}
          setFormDisabled={setFormDisabled}
          formConnectionPool={formConnectionPool}
          setFormConnectionPool={setFormConnectionPool}
          formPolicy={formPolicy}
          setFormPolicy={setFormPolicy}
          formBehavior={formBehavior}
          setFormBehavior={setFormBehavior}
          policySectionOpen={policySectionOpen}
          setPolicySectionOpen={setPolicySectionOpen}
          isPolicyChecked={isPolicyChecked}
          formKeys={formKeys}
          setFormKeys={setFormKeys}
          formHeaders={formHeaders}
          setFormHeaders={setFormHeaders}
          formModels={formModels}
          setFormModels={setFormModels}
          formTestModel={formTestModel}
          setFormTestModel={setFormTestModel}
          formIcon={formIcon}
          iconManuallySelected={iconManuallySelected}
          setIconManuallySelected={setIconManuallySelected}
          setIconPickerOpen={setIconPickerOpen}
          setTargetProviderForIcon={setTargetProviderForIcon}
          setFormIcon={setFormIcon}
          setIsPullingModels={setIsPullingModels}
          keysSectionOpen={keysSectionOpen}
          setKeysSectionOpen={setKeysSectionOpen}
          headersSectionOpen={headersSectionOpen}
          setHeadersSectionOpen={setHeadersSectionOpen}
          modelsSectionOpen={modelsSectionOpen}
          setModelsSectionOpen={setModelsSectionOpen}
          expandedKeyIds={expandedKeyIds}
          setExpandedKeyIds={setExpandedKeyIds}
          expandedModelIds={expandedModelIds}
          setExpandedModelIds={setExpandedModelIds}
          endpointModels={endpointModels}
          setEndpointModels={setEndpointModels}
          isPullingModels={isPullingModels}
          modelFetchSeqRef={modelFetchSeqRef}
          websiteInputState={websiteInputState}
          handlePullModels={handlePullModels}
          isModelPickerOpen={isModelPickerOpen}
          setIsModelPickerOpen={setIsModelPickerOpen}
          handleAddPickedModels={handleAddPickedModels}
          toggleModelExpanded={toggleModelExpanded}
          handleAddModel={handleAddModel}
          updateModelImage={updateModelImage}
          toggleThinkingLevel={toggleThinkingLevel}
          setThinkingLevels={setThinkingLevels}
          toggleKeyExpanded={toggleKeyExpanded}
          handleKeyAdd={handleKeyAdd}
          testingKeyIds={testingKeyIds}
          isTestingAllKeys={isTestingAllKeys}
          handleTestKey={handleTestKey}
          handleTestAllKeys={handleTestAllKeys}
          handleCloseProviderDrawer={handleCloseProviderDrawer}
          handleSaveProvider={handleSaveProvider}
        />
      </DeferredMount>

      {/* LobeHub Icon Picker Modal */}
      <DeferredMount isActive={iconPickerOpen}>
        <IconPickerModal
          open={iconPickerOpen}
          currentIcon={
            targetProviderForIcon
              ? resolveProviderPickerIcon(targetProviderForIcon, { providerIcons, pluginLogos })
              : formIcon
          }
          onSelect={handleSelectIcon}
          onDeleted={(id) => {
            if (formIcon === `custom:${id}`) {
              setFormIcon(getProviderDefaultIcon(formFamily, formName, formBaseURL));
              setIconManuallySelected(false);
            }
          }}
          onClose={() => {
            setIconPickerOpen(false);
            setTargetProviderForIcon(null);
          }}
        />
      </DeferredMount>
    </div>
  );
};
