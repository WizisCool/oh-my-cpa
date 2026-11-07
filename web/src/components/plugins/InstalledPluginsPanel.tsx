import React from 'react';
import { Button, Dropdown, Segmented } from 'antd';
import { Switch } from '../common/Switch';
import { ListLoading } from '../common/PageLoading';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, ExternalLinkOutlined, GithubOutlined, MoreOutlined, PackageSearchOutlined, SettingOutlined, ShopOutlined, UpgradeOutlined } from '../icons';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useI18n, useT } from '../../i18n';
import { selectInstalledPluginMetadata } from '../../types/pluginStoreMetadata';
import type { PluginItem, StorePluginItem } from '../../types/plugin';
import { safeExternalURL } from '../../utils/externalUrl';
import { filterInstalledPlugins, isStoreInstallBlocked, matchesInstalledState, storePluginOrigin, type InstalledStateFilter } from './pluginStoreLogic';
import type { MessageKey } from '../../i18n/catalog';
import { PluginInstallModal } from './PluginInstallModal';
import { waitForPluginRuntime } from './pluginRuntime';
import { formatPluginVersion, PluginLogo, PluginMeta, PluginOriginBadge, PluginStateLabel } from './PluginParts';
import styles from './Plugins.module.css';
import { useToast } from '../feedback';
import { SearchInput } from '../common/SearchInput';
import { EmptyState } from '../common/EmptyState';
import { ConfirmAction } from '../common/ConfirmAction';
import { Toolbar } from '../common/Toolbar';
import { Tooltip } from '../common/Tooltip';
import { UPDATE_STATUS_QUERY_KEY } from '../../hooks/useUpdateNotice';
import { useSortableList } from '../../hooks/useSortableList';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { ReorderHandle, RowContextHandle, RowHandleContext, RowReorder, useReorderRow } from '../common/RowReorder';

const pluginKey = (plugin: PluginItem) => plugin.id;

const INSTALLED_STATE_LABELS: Record<InstalledStateFilter, MessageKey> = {
  all: 'plugin.filter_all',
  running: 'plugin.filter_running',
  stopped: 'plugin.filter_stopped',
};

interface InstalledPluginsPanelProps {
  plugins: PluginItem[];
  isLoading: boolean;
  isPluginSystemEnabled: boolean;
  /** Store listings by plugin id, when the store has been read; they supply descriptions and tags. */
  catalog: ReadonlyMap<string, StorePluginItem>;
  isDemo: boolean;
  onConfigure: (plugin: PluginItem) => void;
  onBrowseStore: () => void;
  onOpenSettings: () => void;
  /** Reads the store, which is what knows the newest releases; resolves to its listings by plugin id. */
  onCheckUpdates: () => Promise<ReadonlyMap<string, StorePluginItem> | null>;
  isCheckingUpdates: boolean;
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
  onOpenSettings,
  onCheckUpdates,
  isCheckingUpdates,
}: InstalledPluginsPanelProps) {
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const sortable = useSortableList('omc_plugin_order', 'installed', plugins, pluginKey);
  const { lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = React.useState('');
  const [stateFilter, setStateFilter] = React.useState<InstalledStateFilter>('all');
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);
  const [updating, setUpdating] = React.useState<StorePluginItem | null>(null);
  const moreButtonRefs = React.useRef(new Map<string, HTMLElement>());
  const previousDeleteIdRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    const previousDeleteId = previousDeleteIdRef.current;
    previousDeleteIdRef.current = pendingDeleteId;
    // Confirmation replaces the menu trigger, so its old DOM node cannot restore focus.
    if (previousDeleteId && !pendingDeleteId) moreButtonRefs.current.get(previousDeleteId)?.focus();
  }, [pendingDeleteId]);

  const visible = React.useMemo(
    () => filterInstalledPlugins(sortable.ordered, query, catalog, lang).filter((plugin) => matchesInstalledState(plugin, stateFilter)),
    [sortable.ordered, query, catalog, lang, stateFilter],
  );
  const stateCounts = React.useMemo(() => ({
    all: plugins.length,
    running: plugins.filter((plugin) => matchesInstalledState(plugin, 'running')).length,
    stopped: plugins.filter((plugin) => matchesInstalledState(plugin, 'stopped')).length,
  }), [plugins]);

  // Manual checks report their outcome; automatic checks only update the rows and navigation.
  const checkUpdates = async () => {
    const listings = await onCheckUpdates();
    if (!listings) {
      toast.error(t('plugin.check_updates_failed'));
      return;
    }
    const count = plugins.filter((plugin) => listings.get(plugin.id)?.update_available).length;
    if (count > 0) toast.success(t('plugin.check_updates_found', { n: count }));
    else toast.success(t('plugin.check_updates_none'));
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
    void queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY });
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
    return <ListLoading className={styles.empty} />;
  }

  if (plugins.length === 0) {
    return (
      <EmptyState className={styles.empty} title={t('plugin.installed_empty')}>
        <Button type="primary" icon={<ShopOutlined />} onClick={onBrowseStore}>
          {t('plugin.browse_store')}
        </Button>
      </EmptyState>
    );
  }

  return (
    <div data-plugin-panel="installed">
      <Toolbar className={styles['installed-toolbar']} end={(
        <Tooltip title={isPhone ? t('plugin.check_updates') : undefined}>
          <Button
            className={styles['check-updates']}
            icon={<PackageSearchOutlined />}
            loading={isCheckingUpdates}
            onClick={() => void checkUpdates()}
            aria-label={t('plugin.check_updates')}
            data-testid="plugin-check-updates"
          >
            {!isPhone && t('plugin.check_updates')}
          </Button>
        </Tooltip>
      )}>
        <SearchInput
          className={styles.search}
          value={query}
          onChange={setQuery}
          label={t('plugin.search_installed')}
        />
        <Segmented
          className={styles['store-filters']}
          value={stateFilter}
          aria-label={t('plugin.state_filter_label')}
          onChange={(value) => setStateFilter(value as InstalledStateFilter)}
          options={(['all', 'running', 'stopped'] as const).map((value) => ({
            value,
            label: `${t(INSTALLED_STATE_LABELS[value])} ${stateCounts[value]}`,
          }))}
        />
      </Toolbar>

      {visible.length === 0 ? (
        <EmptyState className={styles.empty} title={t('plugin.search_empty')} />
      ) : (
        <RowReorder
          {...sortable.reorder}
          items={visible.map(pluginKey)}
          onStep={(key, direction) => {
            const index = visible.findIndex((plugin) => plugin.id === key);
            const neighbour = visible[index + direction];
            if (index >= 0 && neighbour) sortable.reorder.onMove(key, neighbour.id, direction < 0 ? 'before' : 'after');
          }}
        >
          <div className={styles['installed-list']}>
            {visible.map((plugin) => {
              const listing = catalog.get(plugin.id);
              // Only the registry that supplied the installed copy can say whose code it is.
              const provenance = listing?.install_source_status === 'matched' ? listing : undefined;
              const metadata = selectInstalledPluginMetadata(plugin, listing, lang);
              const name = metadata.name;
              const logo = plugin.logo || plugin.metadata?.logo || listing?.logo;
              const version = formatPluginVersion(plugin.metadata?.version || listing?.installed_version);
              const isUpdating = enabledMutation.isPending && enabledMutation.variables?.id === plugin.id;
              const isDeleting = deleteMutation.isPending && deleteMutation.variables === plugin.id;
              const repositoryURL = safeExternalURL(plugin.repository_url || listing?.repository_url);
              const homepageURL = safeExternalURL(metadata.homepage);
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
              return (
                <InstalledPluginRow key={plugin.id} id={plugin.id} name={name} isPhone={isPhone}>
                  <PluginLogo logo={logo} />
                  <div className={styles['installed-main']}>
                    <div className={styles['installed-identity']}>
                      <div className={styles['installed-title']}>
                        <span className={styles['installed-name']}>{name}</span>
                        <span className={styles.badges}>
                          <PluginStateLabel plugin={plugin} isPluginSystemEnabled={isPluginSystemEnabled} />
                          {provenance && <PluginOriginBadge origin={storePluginOrigin(provenance)} />}
                          {!plugin.registered && <span className={styles.badge}>{t('plugin.badge_not_registered')}</span>}
                          {plugin.supports_oauth && <span className={styles.badge}>{t('plugin.badge_auth_provider')}</span>}
                          {plugin.supports_quota && <span className={styles.badge}>{t('plugin.badge_quota')}</span>}
                        </span>
                      </div>
                      {name !== plugin.id && <span className={styles['plugin-id']}>{plugin.id}</span>}
                      <PluginMeta
                        items={[
                          version && <span className={styles['meta-strong']}>{version}</span>,
                          metadata.author,
                          plugin.config_fields.length > 0 && t('plugin.config_field_count', { n: plugin.config_fields.length }),
                          !plugin.configured && t('plugin.not_configured'),
                        ]}
                      />
                    </div>
                    {metadata.description && <p className={styles.description}>{metadata.description}</p>}
                  </div>
                  <div className={styles['installed-actions']}>
                    {isPhone && <RowContextHandle name={name} variant="inline" />}
                    <div className="row-actions">
                      {listing?.update_available && (
                        <Tooltip title={isDemo ? t('demo.blocked') : isStoreInstallBlocked(listing) === 'auth' ? t('plugin.auth_required_hint') : undefined}>
                          <Button
                            type="text"
                            size="small"
                            className={styles['update-button']}
                            icon={<UpgradeOutlined />}
                            disabled={isDemo || isDeleting || isStoreInstallBlocked(listing) !== undefined}
                            onClick={() => setUpdating(listing)}
                            aria-label={t('plugin.update_label_to', { name, version: formatPluginVersion(listing.version) })}
                            data-testid="plugin-row-update"
                          >
                            {t('plugin.update_to', { version: formatPluginVersion(listing.version) })}
                          </Button>
                        </Tooltip>
                      )}
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
                        <ConfirmAction
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
                          confirmLabel={t('plugin.delete')}
                          isDanger
                        >
                          {moreButton}
                        </ConfirmAction>
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
                  </div>
                </InstalledPluginRow>
              );
            })}
          </div>
        </RowReorder>
      )}

      <PluginInstallModal
        entry={updating}
        isPluginSystemEnabled={isPluginSystemEnabled}
        onClose={() => setUpdating(null)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

function InstalledPluginRow({ id, name, isPhone, children }: {
  id: string;
  name: string;
  isPhone: boolean;
  children: React.ReactNode;
}) {
  const { row, handle } = useReorderRow(id);
  return (
    <RowHandleContext.Provider value={handle}>
      <article {...row} className={styles['installed-row']} data-plugin-id={id}>
        {!isPhone && <ReorderHandle {...handle} name={name} />}
        {children}
      </article>
    </RowHandleContext.Provider>
  );
}
