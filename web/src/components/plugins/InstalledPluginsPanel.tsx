import React from 'react';
import { Button, Empty, Input, Popconfirm, Switch, Tooltip } from 'antd';
import { PageLoading } from '../common/PageLoading';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, SearchOutlined, SettingOutlined, ShopOutlined } from '../icons';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { pluginDisplayName, type PluginItem, type StorePluginItem } from '../../types/plugin';
import { StatusLabel } from '../common/StatusLabel';
import { filterInstalledPlugins } from './pluginStoreLogic';
import { formatPluginVersion, PluginLinks, PluginLogo, PluginMeta } from './PluginParts';
import styles from './Plugins.module.css';
import { useToast } from '../feedback';

interface InstalledPluginsPanelProps {
  plugins: PluginItem[];
  isLoading: boolean;
  isPluginSystemEnabled: boolean;
  /** Store listings by plugin id, when the store has been read; they supply descriptions and tags. */
  catalog: ReadonlyMap<string, StorePluginItem>;
  isDemo: boolean;
  onConfigure: (plugin: PluginItem) => void;
  onBrowseStore: () => void;
}

/**
 * The plugins CPA knows about: files in its plugin directory, entries in its configuration
 * and plugins registered with the running host.
 *
 * A row's state is stated in words, because "enabled" alone is not what an operator needs:
 * a plugin can be switched on and still not run, when the plugin system is off or the host
 * has not registered it, and that is the case the row must not hide.
 */
export function InstalledPluginsPanel({
  plugins,
  isLoading,
  isPluginSystemEnabled,
  catalog,
  isDemo,
  onConfigure,
  onBrowseStore,
}: InstalledPluginsPanelProps) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = React.useState('');

  const visible = React.useMemo(() => filterInstalledPlugins(plugins, query, catalog), [plugins, query, catalog]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
  };

  const enabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setPluginEnabled(id, enabled),
    onSuccess: (_, variables) => {
      toast.success(variables.enabled ? t('plugin.enabled_success') : t('plugin.disabled_success'));
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-config', variables.id] });
    },
    onError: (err: unknown) => toast.error(describeError(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePlugin(id),
    onSuccess: (result) => {
      if (result.restart_required) toast.warning(t('plugin.delete_restart_required'));
      else toast.success(t('plugin.delete_success'));
      invalidate();
    },
    onError: (err: unknown) => {
      // A loaded plugin cannot be removed from a running gateway; that is an outcome to
      // explain, not a failure to report as one.
      if (apiErrorCode(err) === 'plugin_delete_requires_restart') {
        toast.warning(t('plugin.delete_restart_title'), { detail: t('plugin.delete_restart_required') });
        return;
      }
      toast.error(describeError(err));
    },
  });

  if (isLoading) {
    return <PageLoading variant="block" className={styles.empty} />;
  }

  if (plugins.length === 0) {
    return (
      <Empty
        className={styles.empty}
        description={t('plugin.installed_empty')}
      >
        <Button type="primary" icon={<ShopOutlined />} onClick={onBrowseStore}>
          {t('plugin.browse_store')}
        </Button>
      </Empty>
    );
  }

  return (
    <div data-plugin-panel="installed">
      <div className={styles.toolbar}>
        <Input
          allowClear
          className={styles.search}
          prefix={<SearchOutlined />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('plugin.search_installed')}
          aria-label={t('plugin.search_installed')}
        />
      </div>

      {visible.length === 0 ? (
        <Empty className={styles.empty} description={t('plugin.search_empty')} />
      ) : (
        <div className={styles['installed-list']}>
          {visible.map((plugin) => {
            const listing = catalog.get(plugin.id);
            const name = pluginDisplayName({ id: plugin.id, metadata: { name: plugin.metadata?.name || listing?.name } });
            const logo = plugin.logo || plugin.metadata?.logo || listing?.logo;
            const version = formatPluginVersion(plugin.metadata?.version || listing?.installed_version);
            const isUpdating = enabledMutation.isPending && enabledMutation.variables?.id === plugin.id;
            const stateLabel = plugin.effective_enabled
              ? <StatusLabel tone="success">{t('plugin.state_running')}</StatusLabel>
              : plugin.enabled
                ? (
                  <Tooltip title={!isPluginSystemEnabled ? t('plugin.state_waiting_system') : t('plugin.state_waiting_register')}>
                    <span><StatusLabel tone="warn">{t('plugin.state_waiting')}</StatusLabel></span>
                  </Tooltip>
                )
                : <StatusLabel tone="neutral">{t('plugin.state_disabled')}</StatusLabel>;
            return (
              <article key={plugin.id} className={styles['installed-row']} data-plugin-id={plugin.id}>
                <PluginLogo logo={logo} />
                <div className={styles['installed-main']}>
                  <div className={styles['installed-title']}>
                    <span className={styles['installed-name']}>{name}</span>
                    <span className={styles.badges}>
                      {stateLabel}
                      {!plugin.registered && <span className={styles.badge}>{t('plugin.badge_not_registered')}</span>}
                      {plugin.supports_oauth && <span className={styles.badge}>{t('plugin.badge_oauth')}</span>}
                      {plugin.supports_quota && <span className={styles.badge}>{t('plugin.badge_quota')}</span>}
                      {listing?.update_available && (
                        <span className={`${styles.badge} ${styles['badge-accent']}`}>
                          {t('plugin.badge_update_to', { version: formatPluginVersion(listing.version) })}
                        </span>
                      )}
                    </span>
                  </div>
                  {name !== plugin.id && <span className={styles['plugin-id']}>{plugin.id}</span>}
                  <PluginMeta
                    items={[
                      version && <span className={styles['meta-strong']}>{version}</span>,
                      plugin.metadata?.author,
                      plugin.config_fields.length > 0 && t('plugin.config_field_count', { n: plugin.config_fields.length }),
                      !plugin.configured && t('plugin.not_configured'),
                    ]}
                  />
                  {listing?.description && <p className={styles.description}>{listing.description}</p>}
                </div>
                <div className={styles['installed-actions']}>
                  <span className={styles['switch-cell']}>
                    <Switch
                      size="small"
                      checked={plugin.enabled}
                      loading={isUpdating}
                      disabled={isDemo}
                      title={isDemo ? t('demo.blocked') : undefined}
                      onChange={(checked) => enabledMutation.mutate({ id: plugin.id, enabled: checked })}
                      aria-label={t('plugin.toggle_label', { name })}
                    />
                  </span>
                  <Button
                    size="small"
                    icon={<SettingOutlined />}
                    onClick={() => onConfigure(plugin)}
                    aria-label={t('plugin.configure_label', { name })}
                  >
                    {t('plugin.configure')}
                  </Button>
                  <Popconfirm
                    title={t('plugin.delete_confirm_title', { name })}
                    description={t('plugin.delete_confirm_desc')}
                    onConfirm={() => deleteMutation.mutate(plugin.id)}
                    okText={t('plugin.delete')}
                    cancelText={t('common.cancel')}
                    okButtonProps={{ danger: true }}
                    disabled={isDemo}
                  >
                    <Tooltip title={isDemo ? t('demo.blocked') : t('plugin.delete')}>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={isDemo}
                        loading={deleteMutation.isPending && deleteMutation.variables === plugin.id}
                        aria-label={t('plugin.delete_label', { name })}
                      />
                    </Tooltip>
                  </Popconfirm>
                  <PluginLinks repositoryURL={plugin.repository_url || listing?.repository_url} homepage={listing?.homepage} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
