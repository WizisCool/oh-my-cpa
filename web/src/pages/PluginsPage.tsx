import { ActionMenu } from '../components/common/ActionMenu';
import React from 'react';
import { Button, Card, Segmented } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import type { PluginItem } from '../types/plugin';
import { PageHeader } from '../components/common/PageHeader';
import { RefreshButton } from '../components/common/RefreshButton';
import { InstalledPluginsPanel } from '../components/plugins/InstalledPluginsPanel';
import { PluginStorePanel } from '../components/plugins/PluginStorePanel';
import { PluginSettingsPanel } from '../components/plugins/PluginSettingsPanel';
import { PluginConfigDrawer } from '../components/plugins/PluginConfigDrawer';
import { storeListingsByPluginId } from '../components/plugins/pluginStoreLogic';
import styles from '../components/plugins/Plugins.module.css';
import { LoadFailure, Notice } from '../components/feedback';

const PLUGIN_TABS = ['installed', 'store', 'settings'] as const;
type PluginTab = (typeof PLUGIN_TABS)[number];

function parseTab(value: string | null): PluginTab {
  return PLUGIN_TABS.includes(value as PluginTab) ? (value as PluginTab) : 'installed';
}

/**
 * Plugin management: what is installed, what the store offers, and how the plugin system
 * itself is configured, on one page.
 *
 * The three are one surface because they are one workflow - find a plugin, install it,
 * configure it, switch the system on - and the operator should not have to cross to the
 * configuration page for the last step. The tab lives in the URL (`?tab=store`), so the
 * store and the settings can be linked to directly; `?plugin=<id>` opens that plugin's
 * settings.
 *
 * The store is only read once its tab is opened: reading it makes CPA fetch every
 * registry, which is slow and rate limited, and the installed list must not wait on it.
 * Once read, it also supplies the descriptions and links the installed list shows.
 */
export const PluginsPage: React.FC = () => {
  const t = useT();
  const isDemo = isDemoMode();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const [hasVisitedStore, setHasVisitedStore] = React.useState(tab === 'store');
  const [configuring, setConfiguring] = React.useState<PluginItem | null>(null);

  const pluginsQuery = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 15000,
  });

  React.useEffect(() => {
    if (tab === 'store') setHasVisitedStore(true);
  }, [tab]);

  const storeQuery = useQuery({
    queryKey: ['management-plugin-store'],
    queryFn: api.getPluginStore,
    enabled: hasVisitedStore,
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

  const selectTab = (next: PluginTab) => updateParams((params) => {
    if (next === 'installed') params.delete('tab');
    else params.set('tab', next);
  });

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

  const manage = (pluginId: string) => {
    updateParams((params) => {
      params.delete('tab');
      params.set('plugin', pluginId);
    });
  };

  const refresh = () => {
    void pluginsQuery.refetch();
    if (tab === 'store' || storeQuery.data) void storeQuery.refetch();
    if (tab === 'settings') void queryClient.invalidateQueries({ queryKey: ['management-plugin-settings'] });
  };
  const isRefreshing = pluginsQuery.isFetching || (tab === 'store' && storeQuery.isFetching);

  const effectiveCount = plugins.filter((plugin) => plugin.effective_enabled).length;
  const activeError = tab === 'store' ? storeQuery.error : pluginsQuery.error;
  const isActiveError = tab === 'store' ? storeQuery.isError : pluginsQuery.isError;

  return (
    <div className="terminal-page terminal-page-stack plugins-page">
      <PageHeader
        title={t('nav.plugins')}
        mobileActions={(
          <>
            <Segmented className="plugins-tabs" value={tab} onChange={(value) => selectTab(value as PluginTab)} options={[
              { value: 'installed', label: t('plugin.tab_installed', { n: plugins.length }) },
              { value: 'store', label: t('plugin.tab_store') }, { value: 'settings', label: t('plugin.tab_settings') },
            ]} />
            <ActionMenu><RefreshButton onRefresh={refresh} isRefreshing={isRefreshing} /></ActionMenu>
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
            <RefreshButton onRefresh={refresh} isRefreshing={isRefreshing} />
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
        <Card>
          <InstalledPluginsPanel
            plugins={plugins}
            isLoading={pluginsQuery.isLoading}
            isPluginSystemEnabled={isSystemEnabled}
            catalog={catalog}
            isDemo={isDemo}
            onConfigure={setConfiguring}
            onBrowseStore={() => selectTab('store')}
          />
        </Card>
      )}
      {tab === 'store' && (
        <PluginStorePanel
          store={storeQuery.data}
          isLoading={storeQuery.isLoading}
          isDemo={isDemo}
          onManage={manage}
          onOpenSettings={() => selectTab('settings')}
        />
      )}
      {tab === 'settings' && <PluginSettingsPanel isDemo={isDemo} />}

      <PluginConfigDrawer plugin={configuring} isDemo={isDemo} onClose={() => setConfiguring(null)} />
    </div>
  );
};
