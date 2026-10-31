import React from 'react';
import { Button } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import type { PluginItem } from '../types/plugin';
import { PageHeader } from '../components/common/PageHeader';
import { RefreshButton } from '../components/common/RefreshButton';
import { ToolButton } from '../components/common/ToolButton';
import { SettingOutlined, ShopOutlined, SyncOutlined } from '../components/icons';
import { InstalledPluginsPanel } from '../components/plugins/InstalledPluginsPanel';
import { PluginStorePanel, type StoreSection } from '../components/plugins/PluginStorePanel';
import { BUILTIN_PLUGINS_QUERY_KEY, BuiltinPluginsPanel, useBuiltinActions } from '../components/plugins/BuiltinPluginsPanel';
import { hasPendingBuiltin } from '../components/plugins/builtinPluginLogic';
import { PluginSettingsPanel } from '../components/plugins/PluginSettingsPanel';
import { PluginConfigDrawer } from '../components/plugins/PluginConfigDrawer';
import { cpaStoreSources, storeListingsBySource } from '../components/plugins/pluginStoreLogic';
import styles from '../components/plugins/Plugins.module.css';
import { LoadFailure, Notice } from '../components/feedback';
import { Panel } from '../components/common/Panel';

/** Under the store's key, so an install from any registry refreshes every store read. */
const OMC_REGISTRY_QUERY_KEY = ['management-plugin-store', 'omc'] as const;

/**
 * The page's views. Three are places of their own in the navigation - the built-in plugins,
 * the plugins the operator installed, and the store; the plugin system settings are reached
 * from the installed list and the store, and the navigation files them under the former.
 */
const PLUGIN_VIEWS = ['builtins', 'browse', 'installed', 'settings'] as const;
type PluginView = (typeof PLUGIN_VIEWS)[number];

const VIEW_PATHS: Record<PluginView, string> = {
  builtins: '/plugins/builtins',
  browse: '/plugins/store',
  installed: '/plugins',
  settings: '/plugins/settings',
};

function viewOfPath(pathname: string): PluginView {
  const segment = pathname.replace(/\/+$/, '').split('/').pop();
  if (segment === 'builtins' || segment === 'settings') return segment;
  return segment === 'store' ? 'browse' : 'installed';
}

/** `?tab=` was a view's address before each had a path; links that carry it still land. */
const LEGACY_TABS: Record<string, PluginView> = { installed: 'installed', builtins: 'builtins', store: 'browse', settings: 'settings' };

/** The store's source filter: both default registries, or one registry. */
const ALL_SOURCES = 'all';
const OFFICIAL_SOURCE = 'official';
const OMC_SOURCE = 'omc';

/**
 * Plugins, in three places with one way of reading them.
 *
 * The built-in plugins are signed and kept current by Oh My CPA's automation. The installed
 * list is what the operator put into CPA by hand; the store is where they find more: CPA's
 * official registry and Oh My CPA's plugin registry side by side, and any registry the
 * operator added. Each place has its own address and its own heading, and a plugin row
 * looks the same in the first two. `?plugin=<id>` opens an installed plugin's settings and
 * `/plugins/store?source=<id>` one registry.
 *
 * Each registry is its own read, so a slow or failing one never holds up another, and
 * none is read until the store is opened: reading a registry is slow and rate limited,
 * and the installed list must not wait on it.
 */
export const PluginsPage: React.FC = () => {
  const t = useT();
  const isDemo = isDemoMode();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = viewOfPath(location.pathname);

  const legacyTab = searchParams.get('tab');
  React.useEffect(() => {
    if (legacyTab === null) return;
    const params = new URLSearchParams(searchParams);
    params.delete('tab');
    const query = params.toString();
    navigate(`${VIEW_PATHS[LEGACY_TABS[legacyTab] ?? 'installed']}${query ? `?${query}` : ''}`, { replace: true });
  }, [legacyTab, navigate, searchParams]);

  const [configuring, setConfiguring] = React.useState<PluginItem | null>(null);

  const pluginsQuery = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 15000,
  });

  const sourceFilter = searchParams.get('source') || ALL_SOURCES;
  const isBrowsing = view === 'browse';
  const showsDefaults = sourceFilter === ALL_SOURCES;
  const officialQuery = useQuery({
    queryKey: ['management-plugin-store', OFFICIAL_SOURCE],
    queryFn: () => api.getPluginStore(OFFICIAL_SOURCE),
    enabled: isBrowsing && (showsDefaults || sourceFilter === OFFICIAL_SOURCE),
    staleTime: 5 * 60_000,
  });
  const omcQuery = useQuery({
    queryKey: OMC_REGISTRY_QUERY_KEY,
    queryFn: api.getOmcCommunityPlugins,
    enabled: isBrowsing && (showsDefaults || sourceFilter === OMC_SOURCE),
    staleTime: 5 * 60_000,
  });
  const isOwnSource = !showsDefaults && sourceFilter !== OFFICIAL_SOURCE && sourceFilter !== OMC_SOURCE;
  const ownSourceQuery = useQuery({
    queryKey: ['management-plugin-store', sourceFilter],
    queryFn: () => api.getPluginStore(sourceFilter),
    enabled: isBrowsing && isOwnSource,
    staleTime: 5 * 60_000,
  });

  // The worker can install, remove, or repair a plugin after this page first
  // reads it. Keep the visible state current, polling faster while it is pending.
  const builtinsQuery = useQuery({
    queryKey: BUILTIN_PLUGINS_QUERY_KEY,
    queryFn: api.getBuiltinPlugins,
    enabled: view === 'builtins',
    staleTime: 15000,
    refetchInterval: (query) => (query.state.data && hasPendingBuiltin(query.state.data.plugins) ? 5000 : 15000),
  });

  const plugins = React.useMemo(() => pluginsQuery.data?.plugins ?? [], [pluginsQuery.data]);
  const userPlugins = React.useMemo(() => plugins.filter((plugin) => plugin.source_kind !== 'builtin'), [plugins]);
  const catalog = React.useMemo(() => storeListingsBySource([
    ...(officialQuery.data?.plugins ?? []), ...(omcQuery.data?.plugins ?? []), ...(ownSourceQuery.data?.plugins ?? []),
  ]), [officialQuery.data, omcQuery.data, ownSourceQuery.data]);
  const isSystemEnabled = pluginsQuery.data?.plugins_enabled ?? true;

  // The operator's own registries, as CPA's reads name them; the built-in catalog and Oh My
  // CPA's registry are never among them.
  const ownSources = React.useMemo(
    () => cpaStoreSources((ownSourceQuery.data ?? officialQuery.data)?.sources).filter((source) => source.source_kind === 'community'),
    [ownSourceQuery.data, officialQuery.data],
  );
  const sourceOptions = [
    { value: ALL_SOURCES, label: t('plugin.source_all') },
    { value: OFFICIAL_SOURCE, label: t('plugin.source_official') },
    { value: OMC_SOURCE, label: t('plugin.source_omc') },
    ...ownSources.map((source) => ({ value: source.id, label: source.name || source.url })),
    ...(isOwnSource && !ownSources.some((source) => source.id === sourceFilter) ? [{ value: sourceFilter, label: sourceFilter }] : []),
  ];

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      mutate(params);
      return params;
    }, { replace: true });
  };

  const selectView = (next: PluginView) => navigate(VIEW_PATHS[next]);

  // `?plugin=<id>` opens that plugin's settings once the list has it.
  const requestedPlugin = searchParams.get('plugin');
  React.useEffect(() => {
    if (!requestedPlugin || !pluginsQuery.data) return;
    const match = userPlugins.find((plugin) => plugin.id === requestedPlugin);
    if (match) setConfiguring(match);
    updateParams((params) => params.delete('plugin'));
    // Only a new request or a new list can open the editor; `updateParams` is recreated
    // every render and is deliberately not a trigger.
  }, [requestedPlugin, pluginsQuery.data, userPlugins]);

  const manage = (pluginId: string) => navigate(`${VIEW_PATHS.installed}?plugin=${encodeURIComponent(pluginId)}`);

  const selectSource = (next: string) => updateParams((params) => {
    if (next === ALL_SOURCES) params.delete('source');
    else params.set('source', next);
  });

  const storeReads = [officialQuery, omcQuery, ownSourceQuery];
  const refresh = () => {
    void pluginsQuery.refetch();
    if (view === 'builtins' || builtinsQuery.data) void builtinsQuery.refetch();
    for (const read of storeReads) if (read.data || (isBrowsing && !read.isPending)) void read.refetch();
    if (view === 'settings') void queryClient.invalidateQueries({ queryKey: ['management-plugin-settings'] });
  };
  const pageQuery = view === 'builtins' ? builtinsQuery : pluginsQuery;
  const isRefreshing = pluginsQuery.isFetching || builtinsQuery.isFetching || storeReads.some((read) => read.isFetching);

  const omcSection: StoreSection = {
    key: OMC_SOURCE,
    title: t('plugin.source_omc'),
    data: omcQuery.data,
    isLoading: omcQuery.isPending,
    error: omcQuery.error,
    onRetry: () => void omcQuery.refetch(),
    notice: omcQuery.data && !omcQuery.data.source_enabled ? (
      <Notice
        className={styles['store-notice']}
        tone="warning"
        title={t('plugin.omc_source_disabled_title')}
        description={t('plugin.omc_source_disabled_desc')}
        action={<Button size="small" onClick={() => navigate('/omc-settings')}>{t('plugin.settings_omc_source_open')}</Button>}
      />
    ) : undefined,
  };
  const officialSection: StoreSection = {
    key: OFFICIAL_SOURCE,
    title: t('plugin.source_official'),
    data: officialQuery.data,
    isLoading: officialQuery.isPending,
    error: officialQuery.error,
    onRetry: () => void officialQuery.refetch(),
  };
  const sections: StoreSection[] = showsDefaults ? [officialSection, omcSection]
    : sourceFilter === OFFICIAL_SOURCE ? [officialSection]
      : sourceFilter === OMC_SOURCE ? [omcSection]
        : [{
          key: sourceFilter,
          title: sourceOptions.find((option) => option.value === sourceFilter)?.label ?? sourceFilter,
          data: ownSourceQuery.data,
          isLoading: ownSourceQuery.isPending,
          error: ownSourceQuery.error,
          onRetry: () => void ownSourceQuery.refetch(),
        }];

  const builtinCount = plugins.length - userPlugins.length;
  const effectiveCount = userPlugins.filter((plugin) => plugin.effective_enabled).length;
  const installedById = React.useMemo(() => new Map(plugins.map((plugin) => [plugin.id, plugin])), [plugins]);

  const refreshButton = <RefreshButton onRefresh={refresh} isRefreshing={isRefreshing} />;
  // The built-in list reads itself again on a timer, so its page offers what a refresh would
  // not: asking OMC to check the catalog for updates now, and reporting what that did.
  const builtinActions = useBuiltinActions();
  const builtinPolicy = builtinsQuery.data;
  const checkButton = (
    <ToolButton
      icon={<SyncOutlined />}
      label={t('plugin.builtin_check')}
      tooltip={isDemo ? t('demo.blocked') : undefined}
      loading={builtinActions.reconcileMutation.isPending}
      disabled={isDemo || builtinActions.isWriting || !builtinPolicy?.policy.enabled
        || builtinPolicy.catalog.status !== 'ready' || !isSystemEnabled}
      onClick={() => builtinActions.reconcileMutation.mutate()}
    />
  );
  const settingsButton = (
    <ToolButton
      icon={<SettingOutlined />}
      label={view === 'browse' ? t('plugin.manage_sources') : t('plugin.settings_title')}
      onClick={() => selectView('settings')}
    />
  );
  // A phone's top bar already refreshes the page, so its header keeps only the page's own
  // actions, as glyphs on the subtitle's line.
  const headers: Record<PluginView, { title: string; subtitle?: string; tools: React.ReactNode; phoneTools?: React.ReactNode; primary?: React.ReactNode }> = {
    builtins: { title: t('nav.plugin_builtins'), subtitle: t('plugin.builtins_subtitle'), tools: checkButton, phoneTools: checkButton },
    installed: {
      title: t('nav.plugins'),
      tools: <>{settingsButton}{refreshButton}</>,
      phoneTools: (
        <>
          <ToolButton icon={<ShopOutlined />} label={t('plugin.browse_store')} onClick={() => selectView('browse')} />
          {settingsButton}
        </>
      ),
      primary: <Button icon={<ShopOutlined />} onClick={() => selectView('browse')}>{t('plugin.browse_store')}</Button>,
    },
    browse: { title: t('nav.plugin_store'), subtitle: t('plugin.store_subtitle'), tools: <>{settingsButton}{refreshButton}</>, phoneTools: settingsButton },
    settings: { title: t('plugin.settings_title'), subtitle: t('plugin.settings_subtitle'), tools: refreshButton },
  };
  const header = headers[view];

  return (
    <div className="terminal-page terminal-page-stack plugins-page">
      <PageHeader
        title={header.title}
        subtitle={header.subtitle}
        mobileActions={header.phoneTools ?? null}
        actions={<>{header.tools}{header.primary}</>}
      >
        {view === 'installed' && pluginsQuery.data && (
          <div className={styles['status-strip']} data-plugin-status>
            <span>
              {t('plugin.status_system')}
              <span className={styles['status-strip-value']} data-tone={isSystemEnabled ? undefined : 'warn'}>
                {isSystemEnabled ? t('plugin.system_enabled') : t('plugin.system_disabled')}
              </span>
            </span>
            <span>
              {t('plugin.status_running')}
              <span className={styles['status-strip-value']}>{effectiveCount} / {userPlugins.length}</span>
            </span>
            <span>
              {t('plugin.status_dir')}
              <code className={styles['status-strip-path']}>{pluginsQuery.data.plugins_dir || 'plugins'}</code>
            </span>
          </div>
        )}
      </PageHeader>

      {pluginsQuery.data && !isSystemEnabled && (view === 'installed' || view === 'browse') && (
        <Notice
          tone="warning"
          title={t('plugin.system_disabled_title')}
          description={t('plugin.system_disabled_desc')}
          action={<Button size="small" onClick={() => selectView('settings')}>{t('plugin.open_settings')}</Button>}
        />
      )}

      {(view === 'installed' || view === 'builtins') && pageQuery.isError && (
        <LoadFailure
          title={t('common.load_failed_title')}
          error={pageQuery.error}
          onRetry={() => void pageQuery.refetch()}
        />
      )}

      {view === 'installed' && (
        <Panel>
          <InstalledPluginsPanel
            plugins={userPlugins}
            isLoading={pluginsQuery.isLoading}
            isPluginSystemEnabled={isSystemEnabled}
            catalog={catalog}
            isDemo={isDemo}
            builtinCount={builtinCount}
            onConfigure={setConfiguring}
            onBrowseStore={() => selectView('browse')}
            onOpenBuiltins={() => selectView('builtins')}
          />
        </Panel>
      )}
      {view === 'builtins' && (
        <BuiltinPluginsPanel
          data={builtinsQuery.data}
          isLoading={builtinsQuery.isPending}
          isDemo={isDemo}
          isPluginSystemEnabled={isSystemEnabled}
          installed={installedById}
          actions={builtinActions}
          onOpenSettings={() => selectView('settings')}
          onConfigure={setConfiguring}
        />
      )}
      {view === 'browse' && (
        <PluginStorePanel
          sections={sections}
          sourceOptions={sourceOptions}
          sourceFilter={sourceFilter}
          onSelectSource={selectSource}
          isDemo={isDemo}
          onManage={manage}
          onOpenSettings={() => selectView('settings')}
        />
      )}
      {view === 'settings' && <PluginSettingsPanel isDemo={isDemo} />}

      <PluginConfigDrawer plugin={configuring} isDemo={isDemo} onClose={() => setConfiguring(null)} />
    </div>
  );
};
