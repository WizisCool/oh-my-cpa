import React from 'react';
import { Button, Dropdown, Empty, Input, Popconfirm, Tooltip } from 'antd';
import { Switch } from '../common/Switch';
import { PageLoading } from '../common/PageLoading';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, ExternalLinkOutlined, GithubOutlined, MoreOutlined, SearchOutlined, SettingOutlined, ShopOutlined } from '../icons';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { pluginDisplayName, type PluginItem, type StorePluginItem } from '../../types/plugin';
import { safeExternalURL } from '../../utils/externalUrl';
import { StatusLabel } from '../common/StatusLabel';
import { filterInstalledPlugins } from './pluginStoreLogic';
import { waitForPluginRuntime } from './pluginRuntime';
import { formatPluginVersion, PluginLogo, PluginMeta } from './PluginParts';
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
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);
  const moreButtonRefs = React.useRef(new Map<string, HTMLElement>());
  const previousDeleteIdRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    const previousDeleteId = previousDeleteIdRef.current;
    previousDeleteIdRef.current = pendingDeleteId;
    // Confirmation replaces the menu trigger, so its old DOM node cannot restore focus.
    if (previousDeleteId && !pendingDeleteId) moreButtonRefs.current.get(previousDeleteId)?.focus();
  }, [pendingDeleteId]);

  const visible = React.useMemo(() => filterInstalledPlugins(plugins, query, catalog), [plugins, query, catalog]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
  };

  const enabledMutation = useMutation({
    // The switch stays busy until the gateway has loaded or unloaded the plugin, so the
    // row and the navigation's plugin pages change together with the acknowledgement.
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await api.setPluginEnabled(id, enabled);
      // The write is done from here on. A list read that fails afterwards leaves the
      // running state unconfirmed; it must not be reported as the switch having failed.
      try {
        return await waitForPluginRuntime(id, enabled, api.getPlugins);
      } catch {
        return null;
      }
    },
    onSuccess: (result, variables) => {
      if (result) queryClient.setQueryData(['management-plugins'], result.response);
      if (!result) toast.warning(t('plugin.runtime_unconfirmed'));
      else if (result.status === 'timeout') toast.warning(t('plugin.runtime_pending'));
      else if (result.status === 'system-disabled') toast.warning(t('plugin.runtime_system_disabled'));
      else toast.success(variables.enabled ? t('plugin.enabled_success') : t('plugin.disabled_success'));
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
            const isDeleting = deleteMutation.isPending && deleteMutation.variables === plugin.id;
            const repositoryURL = safeExternalURL(plugin.repository_url || listing?.repository_url);
            const homepageURL = safeExternalURL(listing?.homepage);
            const hasHomepage = homepageURL !== undefined && homepageURL !== repositoryURL;
            const moreButton = (
              <Button
                size="small"
                className="row-action-btn"
                ref={(button) => {
                  if (button) moreButtonRefs.current.set(plugin.id, button);
                  else moreButtonRefs.current.delete(plugin.id);
                }}
                icon={<MoreOutlined />}
                loading={isDeleting}
                disabled={isDeleting}
                aria-label={`${t('common.more')}: ${name}`}
                aria-haspopup="menu"
              />
            );
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
                      {plugin.supports_oauth && <span className={styles.badge}>{t('plugin.badge_auth_provider')}</span>}
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
                      disabled={isDemo || isDeleting}
                      title={isDemo ? t('demo.blocked') : undefined}
                      onChange={(checked) => enabledMutation.mutate({ id: plugin.id, enabled: checked })}
                      aria-label={t('plugin.toggle_label', { name })}
                    />
                  </span>
                  <div className="row-actions">
                    <Tooltip title={t('plugin.configure')}>
                      <Button
                        size="small"
                        className="row-action-btn"
                        icon={<SettingOutlined />}
                        disabled={isDeleting}
                        onClick={() => onConfigure(plugin)}
                        aria-label={t('plugin.configure_label', { name })}
                      />
                    </Tooltip>
                    {pendingDeleteId === plugin.id ? (
                      <Popconfirm
                        open
                        title={t('plugin.delete_confirm_title', { name })}
                        description={t('plugin.delete_confirm_desc')}
                        onConfirm={() => {
                          setPendingDeleteId(null);
                          deleteMutation.mutate(plugin.id);
                        }}
                        onCancel={() => setPendingDeleteId(null)}
                        onOpenChange={(isOpen) => {
                          if (!isOpen) setPendingDeleteId(null);
                        }}
                        okText={t('plugin.delete')}
                        cancelText={t('common.cancel')}
                        okButtonProps={{ danger: true }}
                      >
                        {moreButton}
                      </Popconfirm>
                    ) : (
                      <Dropdown
                        trigger={['click']}
                        placement="bottomRight"
                        menu={{
                          items: [
                            ...(repositoryURL ? [{
                              key: 'repository',
                              icon: <GithubOutlined />,
                              label: <a href={repositoryURL} target="_blank" rel="noreferrer noopener">{t('plugin.open_repository')}</a>,
                            }] : []),
                            ...(hasHomepage ? [{
                              key: 'homepage',
                              icon: <ExternalLinkOutlined />,
                              label: <a href={homepageURL} target="_blank" rel="noreferrer noopener">{t('plugin.open_homepage')}</a>,
                            }] : []),
                            ...(repositoryURL || hasHomepage ? [{ type: 'divider' as const }] : []),
                            {
                              key: 'delete',
                              icon: <DeleteOutlined />,
                              label: isDemo ? <Tooltip title={t('demo.blocked')}>{t('plugin.delete')}</Tooltip> : t('plugin.delete'),
                              danger: true,
                              disabled: isDemo || isUpdating,
                              onClick: () => setPendingDeleteId(plugin.id),
                            },
                          ],
                        }}
                      >
                        {moreButton}
                      </Dropdown>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
