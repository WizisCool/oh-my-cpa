import React from 'react';
import { Button, Segmented } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UPDATE_STATUS_QUERY_KEY } from '../hooks/useUpdateNotice';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, apiErrorCode, describeError } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import type { PluginItem } from '../types/plugin';
import { PageHeader } from '../components/common/PageHeader';
import { InstalledPluginsPanel } from '../components/plugins/InstalledPluginsPanel';
import { PluginStorePanel } from '../components/plugins/PluginStorePanel';
import { PluginSettingsPanel } from '../components/plugins/PluginSettingsPanel';
import { PluginConfigDrawer } from '../components/plugins/PluginConfigDrawer';
import { storeListingsByPluginId } from '../components/plugins/pluginStoreLogic';
import styles from '../components/plugins/Plugins.module.css';
import { LoadFailure, Notice, useToast } from '../components/feedback';
import { Panel } from '../components/common/Panel';

const PLUGIN_STORE_QUERY_KEY = ['management-plugin-store'] as const;

const PLUGIN_TABS = ['installed', 'store', 'settings'] as const;
type PluginTab = (typeof PLUGIN_TABS)[number];

const TAB_PATHS: Record<PluginTab, string> = {
  installed: '/plugins',
  store: '/plugins/store',
  settings: '/plugins/settings',
};

function tabOfPath(pathname: string): PluginTab {
  const segment = pathname.replace(/\/+$/, '').split('/').pop();
  return segment === 'store' || segment === 'settings' ? segment : 'installed';
}

function isPluginTab(value: string | null): value is PluginTab {
  return PLUGIN_TABS.includes(value as PluginTab);
}

/**
 * Plugin management: what is installed, what the store offers, and how the plugin system
 * itself is configured, on one page.
 *
 * The three are one surface because they are one workflow - find a plugin, install it,
 * configure it, switch the system on - and the operator should not have to cross to the
 * configuration page for the last step. Each tab has its own address (`/plugins/store`,
 * `/plugins/settings`), so the navigation can list the store beside the installed plugins
 * and either can be linked to; `?plugin=<id>` opens that plugin's settings.
 *
 * The installed tab enables a separate store query after its list contains plugins,
 * so registry reads never block the installed list.
 */
export const PluginsPage: React.FC = () => {
  const t = useT();
  const queryClient = useQueryClient();
  const toast = useToast();
  const isDemo = isDemoMode();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabOfPath(location.pathname);

  // `?tab=` was the tab's address before each tab had a path; links that carry it still land.
  const legacyTab = searchParams.get('tab');
  React.useEffect(() => {
    if (legacyTab === null) return;
    const params = new URLSearchParams(searchParams);
    params.delete('tab');
    const query = params.toString();
    navigate(`${TAB_PATHS[isPluginTab(legacyTab) ? legacyTab : 'installed']}${query ? `?${query}` : ''}`, { replace: true });
  }, [legacyTab, navigate, searchParams]);

  const [configuring, setConfiguring] = React.useState<PluginItem | null>(null);
  const [isRefreshingStore, setIsRefreshingStore] = React.useState(false);
  const storeRefreshRef = React.useRef<Promise<void> | null>(null);

  const pluginsQuery = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 15000,
  });

  const storeQuery = useQuery({
    queryKey: PLUGIN_STORE_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const store = await api.getPluginStore({ signal });
      void queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY });
      return store;
    },
    enabled: tab === 'store' || (tab === 'installed' && !!pluginsQuery.data?.plugins.length),
    staleTime: 5 * 60_000,
  });

  const plugins = React.useMemo(() => pluginsQuery.data?.plugins ?? [], [pluginsQuery.data]);
  const catalog = React.useMemo(() => storeListingsByPluginId(storeQuery.data?.plugins), [storeQuery.data]);
  const isSystemEnabled = pluginsQuery.data?.plugins_enabled ?? true;

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      mutate(params);
      return params;
    }, { replace: true });
  };

  const selectTab = (next: PluginTab) => navigate(TAB_PATHS[next]);

  // `?plugin=<id>` opens that plugin's settings once the list has it.
  const requestedPlugin = searchParams.get('plugin');
  React.useEffect(() => {
    if (!requestedPlugin || !pluginsQuery.data) return;
    const match = pluginsQuery.data.plugins.find((plugin) => plugin.id === requestedPlugin);
    if (match) setConfiguring(match);
    updateParams((params) => params.delete('plugin'));
    // Only a new request or a new list can open the editor; `updateParams` is recreated
    // every render and is deliberately not a trigger.
  }, [requestedPlugin, pluginsQuery.data]);

  const refreshStore = (isUpdateCheck: boolean): Promise<void> => {
    if (storeRefreshRef.current) return storeRefreshRef.current;
    setIsRefreshingStore(true);
    storeRefreshRef.current = (async () => {
      try {
        // A normal read must not absorb the explicit refresh or later overwrite its result.
        await queryClient.cancelQueries({ queryKey: PLUGIN_STORE_QUERY_KEY });
        const store = await api.getPluginStore({ refresh: true });
        queryClient.setQueryData(PLUGIN_STORE_QUERY_KEY, store);
        void queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY });
        const listings = storeListingsByPluginId(store.plugins);
        const count = plugins.filter((plugin) => listings.get(plugin.id)?.update_available).length;
        if (store.source_errors.length > 0) {
          toast.warning(t(isUpdateCheck && count > 0 ? 'plugin.check_updates_found' : 'plugin.store_refresh_partial', { n: count }), {
            items: store.source_errors.map((source) => ({ name: source.source_name, reason: source.message })),
            actions: <Button size="small" onClick={() => selectTab('settings')}>{t('plugin.open_settings')}</Button>,
          });
        } else if (isUpdateCheck) {
          // CPA can retain a previous version after a failed release lookup; zero is not proof of freshness.
          if (count > 0) toast.success(t('plugin.check_updates_found', { n: count }));
          else toast.info(t('plugin.check_updates_none'));
        } else {
          toast.success(t('plugin.store_refreshed'));
        }
      } catch (error: unknown) {
        const isRateLimited = error instanceof ApiError && (error.status === 429 || apiErrorCode(error) === 'plugin_store_rate_limited');
        const retryAfter = error instanceof ApiError && error.data !== null && typeof error.data === 'object' && 'retry_after' in error.data
          ? error.data.retry_after : undefined;
        const detail = [describeError(error), typeof retryAfter === 'number' && retryAfter > 0 && Number.isFinite(retryAfter)
          ? t('plugin.retry_after_seconds', { n: Math.ceil(retryAfter) }) : ''].filter(Boolean).join(' ');
        toast.error(t(isRateLimited ? 'plugin.rate_limited' : isUpdateCheck ? 'plugin.check_updates_failed' : 'plugin.store_refresh_failed'), {
          detail,
          actions: isRateLimited ? <Button size="small" onClick={() => selectTab('settings')}>{t('plugin.open_settings')}</Button> : undefined,
        });
      } finally {
        setIsRefreshingStore(false);
        storeRefreshRef.current = null;
      }
    })();
    return storeRefreshRef.current;
  };

  const manage = (pluginId: string) => navigate(`${TAB_PATHS.installed}?plugin=${encodeURIComponent(pluginId)}`);

  // The head names the destination, not the surface: the store is its own entry in the
  // navigation (`/plugins/store`), so it reads as the store here while the installed list
  // and settings stay under plugin management, which is the entry that owns them.
  const pageTitle = tab === 'store' ? t('nav.plugin_store') : t('nav.plugins');

  const effectiveCount = plugins.filter((plugin) => plugin.effective_enabled).length;
  const activeError = tab === 'store' ? storeQuery.error : pluginsQuery.error;
  const isActiveError = tab === 'store' ? storeQuery.isError : pluginsQuery.isError;

  return (
    <div className="terminal-page terminal-page-stack plugins-page">
      <PageHeader
        title={pageTitle}
        mobileActions={(
          <>
            <Segmented className="plugins-tabs" value={tab} onChange={(value) => selectTab(value as PluginTab)} options={[
              { value: 'installed', label: t('plugin.tab_installed', { n: plugins.length }) },
              { value: 'store', label: t('plugin.tab_store') }, { value: 'settings', label: t('plugin.tab_settings') },
            ]} />
          </>
        )}
        actions={(
          <>
            <Segmented
              className="plugins-tabs"
              value={tab}
              onChange={(value) => selectTab(value as PluginTab)}
              options={[
                { value: 'installed', label: t('plugin.tab_installed', { n: plugins.length }) },
                { value: 'store', label: t('plugin.tab_store') },
                { value: 'settings', label: t('plugin.tab_settings') },
              ]}
            />
          </>
        )}
      >
        {pluginsQuery.data && (
          <div className={styles['status-strip']} data-plugin-status>
            <span>
              {t('plugin.status_system')}
              <span className={styles['status-strip-value']}>
                {isSystemEnabled ? t('plugin.system_enabled') : t('plugin.system_disabled')}
              </span>
            </span>
            <span>
              {t('plugin.status_dir')}
              <code className={styles['status-strip-path']}>{pluginsQuery.data.plugins_dir || 'plugins'}</code>
            </span>
            <span>
              {t('plugin.status_running')}
              <span className={styles['status-strip-value']}>{effectiveCount} / {plugins.length}</span>
            </span>
          </div>
        )}
      </PageHeader>

      {pluginsQuery.data && !isSystemEnabled && tab !== 'settings' && (
        <Notice
          tone="warning"
          title={t('plugin.system_disabled_title')}
          description={t('plugin.system_disabled_desc')}
          action={<Button size="small" onClick={() => selectTab('settings')}>{t('plugin.open_settings')}</Button>}
        />
      )}

      {isActiveError && (
        <LoadFailure
          title={t('common.load_failed_title')}
          error={activeError}
          onRetry={() => void (tab === 'store' ? storeQuery.refetch() : pluginsQuery.refetch())}
        />
      )}

      {tab === 'installed' && (
        <Panel>
          <InstalledPluginsPanel
            plugins={plugins}
            isLoading={pluginsQuery.isLoading}
            isPluginSystemEnabled={isSystemEnabled}
            catalog={catalog}
            isDemo={isDemo}
            onConfigure={setConfiguring}
            onBrowseStore={() => selectTab('store')}
            onOpenSettings={() => selectTab('settings')}
            onCheckUpdates={() => refreshStore(true)}
            isCheckingUpdates={isRefreshingStore}
          />
        </Panel>
      )}
      {tab === 'store' && (
        <PluginStorePanel
          store={storeQuery.data}
          isLoading={storeQuery.isPending}
          isDemo={isDemo}
          onRefresh={() => void refreshStore(false)}
          isRefreshing={isRefreshingStore}
          onManage={manage}
          onOpenSettings={() => selectTab('settings')}
        />
      )}
      {tab === 'settings' && <PluginSettingsPanel isDemo={isDemo} />}

      <PluginConfigDrawer
        plugin={configuring}
        listing={configuring ? catalog.get(configuring.id) : undefined}
        isPluginSystemEnabled={isSystemEnabled}
        isDemo={isDemo}
        onClose={() => setConfiguring(null)}
      />
    </div>
  );
};
