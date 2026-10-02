import React from 'react';
import { Button, Empty, Input, Modal, Radio, Segmented, Tooltip } from 'antd';
import { PageLoading } from '../common/PageLoading';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DownloadOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  SyncOutlined,
  WarningOutlined,
} from '../icons';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import type { PluginStoreResponse, StorePluginItem } from '../../types/plugin';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import {
  filterStorePlugins,
  isStoreInstallBlocked,
  PLUGIN_STORE_FILTERS,
  storeFilterCounts,
  storeInstallConfirmToken,
  type PluginStoreFilter,
} from './pluginStoreLogic';
import { formatPluginVersion, PluginLinks, PluginLogo, PluginMeta } from './PluginParts';
import styles from './Plugins.module.css';
import { useToast } from '../feedback';
import { Notice } from '../feedback';

/** Past this length a description is clamped with a toggle; shorter ones never need one. */
const DESCRIPTION_CLAMP_CHARS = 150;

interface PluginStorePanelProps {
  store: PluginStoreResponse | undefined;
  isLoading: boolean;
  isDemo: boolean;
  onManage: (pluginId: string) => void;
  onOpenSettings: () => void;
}

/**
 * The plugin store: every registry CPA is configured with, as cards.
 *
 * Installing a plugin runs its code inside the gateway, so the card says where it comes
 * from before anything else: the built-in registry with a first-party repository is
 * marked official, and everything else is marked third-party and has to be confirmed by
 * typing the plugin's id.
 */
export function PluginStorePanel({ store, isLoading, isDemo, onManage, onOpenSettings }: PluginStorePanelProps) {
  const t = useT();
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<PluginStoreFilter>('all');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [installing, setInstalling] = React.useState<StorePluginItem | null>(null);

  const entries = React.useMemo(() => store?.plugins ?? [], [store]);
  const counts = React.useMemo(() => storeFilterCounts(entries), [entries]);
  const visible = React.useMemo(() => filterStorePlugins(entries, query, filter), [entries, query, filter]);

  const toggleDescription = (storeId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(storeId)) next.delete(storeId);
      else next.add(storeId);
      return next;
    });
  };

  if (isLoading) {
    return <PageLoading variant="block" className={styles.empty} />;
  }

  const filterLabels: Record<PluginStoreFilter, string> = {
    all: t('plugin.filter_all'),
    installed: t('plugin.filter_installed'),
    available: t('plugin.filter_available'),
    updates: t('plugin.filter_updates'),
  };

  return (
    <div data-plugin-panel="store">
      <Notice
        className={styles['store-notice']}
        tone="info"
        icon={<SafetyCertificateOutlined />}
        title={t('plugin.store_notice_title')}
        description={t('plugin.store_notice_desc')}
      />

      {(store?.source_errors.length ?? 0) > 0 && (
        <Notice
          className={styles['store-notice']}
          tone="warning"
          title={t('plugin.source_errors_title')}
          description={(
            <ul>
              {store?.source_errors.map((sourceError) => (
                <li key={sourceError.source_id || sourceError.source_url}>
                  <strong>{sourceError.source_name || sourceError.source_url}</strong>: {sourceError.message}
                </li>
              ))}
            </ul>
          )}
          action={<Button size="small" onClick={onOpenSettings}>{t('plugin.open_settings')}</Button>}
        />
      )}

      <div className={`${styles.toolbar} ${styles['toolbar-spaced']}`}>
        <Input
          allowClear
          className={styles.search}
          prefix={<SearchOutlined />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('plugin.search_store')}
          aria-label={t('plugin.search_store')}
        />
        <Segmented
          className={styles['store-filters']}
          value={filter}
          onChange={(value) => setFilter(value as PluginStoreFilter)}
          options={PLUGIN_STORE_FILTERS.map((value) => ({
            value,
            label: `${filterLabels[value]} ${counts[value]}`,
          }))}
        />
      </div>

      {visible.length === 0 ? (
        <Empty className={styles.empty} description={entries.length === 0 ? t('plugin.store_empty') : t('plugin.search_empty')} />
      ) : (
        <div className={styles['card-grid']}>
          {visible.map((entry) => (
            <StoreCard
              key={entry.store_id || `${entry.source_id}/${entry.id}`}
              entry={entry}
              isExpanded={expanded.has(entry.store_id)}
              isDemo={isDemo}
              onToggleDescription={() => toggleDescription(entry.store_id)}
              onInstall={() => setInstalling(entry)}
              onManage={() => onManage(entry.id)}
            />
          ))}
        </div>
      )}

      <PluginInstallModal
        entry={installing}
        isPluginSystemEnabled={store?.plugins_enabled ?? true}
        onClose={() => setInstalling(null)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

interface StoreCardProps {
  entry: StorePluginItem;
  isExpanded: boolean;
  isDemo: boolean;
  onToggleDescription: () => void;
  onInstall: () => void;
  onManage: () => void;
}

function StoreCard({ entry, isExpanded, isDemo, onToggleDescription, onInstall, onManage }: StoreCardProps) {
  const t = useT();
  const blocked = isStoreInstallBlocked(entry);
  const isFromOtherSource = entry.installed && entry.install_source_status === 'different';
  const isUpdate = entry.installed && entry.update_available;
  const version = isUpdate && entry.installed_version
    ? t('plugin.version_arrow', { from: formatPluginVersion(entry.installed_version), to: formatPluginVersion(entry.version) })
    : formatPluginVersion(entry.installed ? entry.installed_version || entry.version : entry.version);
  const description = entry.description?.trim() ?? '';
  const isLong = description.length > DESCRIPTION_CLAMP_CHARS;
  const actionTitle = isDemo ? t('demo.blocked') : blocked === 'auth' ? t('plugin.auth_required_hint') : undefined;

  return (
    <article className={styles['store-card']} data-store-id={entry.store_id} data-plugin-id={entry.id}>
      <div className={styles['card-head']}>
        <PluginLogo logo={entry.logo} />
        <div className={styles['card-title']}>
          <span className={styles['card-name']} title={entry.name || entry.id}>{entry.name || entry.id}</span>
          <span className={styles['plugin-id']}>{entry.id}</span>
        </div>
      </div>

      <span className={styles.badges}>
        {entry.is_official ? (
          <span className={styles.badge}><SafetyCertificateOutlined />{t('plugin.badge_official')}</span>
        ) : (
          <span className={`${styles.badge} ${styles['badge-warn']}`}><WarningOutlined />{t('plugin.badge_third_party')}</span>
        )}
        {isUpdate ? (
          <span className={`${styles.badge} ${styles['badge-accent']}`}>{t('plugin.badge_update')}</span>
        ) : entry.installed ? (
          <span className={styles.badge}>{isFromOtherSource ? t('plugin.badge_installed_elsewhere') : t('plugin.badge_installed')}</span>
        ) : null}
        {entry.auth_required && (
          <span className={`${styles.badge} ${entry.auth_configured ? '' : styles['badge-warn']}`}>
            <LockOutlined />{entry.auth_configured ? t('plugin.badge_auth_configured') : t('plugin.badge_auth_missing')}
          </span>
        )}
      </span>

      {description ? (
        <>
          <p className={`${styles['card-description']} ${isExpanded ? styles['card-description-expanded'] : ''}`}>{description}</p>
          {isLong && (
            <button type="button" className={styles['text-toggle']} onClick={onToggleDescription} aria-expanded={isExpanded}>
              {isExpanded ? t('plugin.show_less') : t('plugin.show_more')}
            </button>
          )}
        </>
      ) : (
        <p className={`${styles['card-description']} ${styles['card-description-muted']}`}>{t('plugin.no_description')}</p>
      )}

      <PluginMeta
        items={[
          version && <span className={styles['meta-strong']}>{version}</span>,
          entry.author && t('plugin.by_author', { author: entry.author }),
          entry.license,
          entry.source_name && t('plugin.from_source', { source: entry.is_official || entry.source_id === 'official' ? t('plugin.source_official') : entry.source_name }),
        ]}
      />

      {entry.tags.length > 0 && (
        <div className={styles.tags}>
          {entry.tags.map((tag) => <span key={tag} className={styles.tag}>{tag}</span>)}
        </div>
      )}

      <div className={styles['card-footer']}>
        <span className={styles['card-actions']}>
          {!entry.installed && (
            <Tooltip title={actionTitle}>
              <Button type="primary" size="small" icon={<DownloadOutlined />} disabled={isDemo || blocked !== undefined} onClick={onInstall}>
                {t('plugin.install')}
              </Button>
            </Tooltip>
          )}
          {isUpdate && (
            <Tooltip title={actionTitle}>
              <Button type="primary" size="small" icon={<SyncOutlined />} disabled={isDemo || blocked !== undefined} onClick={onInstall}>
                {t('plugin.update')}
              </Button>
            </Tooltip>
          )}
          {entry.installed && (
            <Button size="small" icon={<SettingOutlined />} onClick={onManage}>
              {t('plugin.manage')}
            </Button>
          )}
        </span>
        <PluginLinks repositoryURL={entry.repository_url} homepage={entry.homepage} />
      </div>
    </article>
  );
}

interface PluginInstallModalProps {
  entry: StorePluginItem | null;
  isPluginSystemEnabled: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

/**
 * The install confirmation. It names the source, offers the newest release or a named
 * one, and for a third-party plugin asks for the plugin id to be typed: running someone
 * else's code in the gateway should take more than one click.
 */
function PluginInstallModal({ entry, isPluginSystemEnabled, onClose, onOpenSettings }: PluginInstallModalProps) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [versionMode, setVersionMode] = React.useState<'latest' | 'pinned'>('latest');
  const [version, setVersion] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');

  React.useEffect(() => {
    setVersionMode('latest');
    setVersion('');
    setConfirmation('');
  }, [entry?.store_id]);

  const installMutation = useMutation({
    mutationFn: (target: StorePluginItem) =>
      api.installPlugin(target.id, {
        sourceId: target.source_id,
        version: versionMode === 'pinned' ? version.trim() : undefined,
      }),
    onSuccess: (result, target) => {
      const isUpdate = target.installed;
      const outcome = isUpdate
        ? t('plugin.update_success', { name: target.name || target.id, version: formatPluginVersion(result.version) })
        : t('plugin.install_success', { name: target.name || target.id, version: formatPluginVersion(result.version) });
      // Installed while the plugin system is off is still a success, but one that will not take
      // effect: one toast says both and offers the switch, rather than a success and a dialog.
      if (result.plugins_enabled) {
        toast.success(outcome);
      } else {
        toast.warning(outcome, {
          detail: t('plugin.installed_while_disabled'),
          actions: <Button size="small" onClick={onOpenSettings}>{t('plugin.open_settings')}</Button>,
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
      onClose();
    },
    onError: (err: unknown) => {
      const code = apiErrorCode(err);
      if (code === 'plugin_update_requires_restart') {
        toast.warning(t('plugin.update_restart_required'));
        return;
      }
      if (code === 'plugin_store_rate_limited') {
        toast.error(t('plugin.rate_limited'));
        return;
      }
      toast.error(t('plugin.install_failed', { msg: describeError(err) }));
    },
  });

  const handleClose = () => {
    if (!installMutation.isPending) onClose();
  };
  useOverlayHistory({ isOpen: entry !== null, onClose: handleClose });

  if (!entry) return null;

  const isThirdParty = !entry.is_official;
  const token = storeInstallConfirmToken(entry);
  const isVersionValid = versionMode === 'latest' || /^v?[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version.trim());
  const isConfirmed = !isThirdParty || confirmation.trim() === token;
  const name = entry.name || entry.id;

  return (
    <Modal
      open
      title={entry.installed ? t('plugin.update_title', { name }) : t('plugin.install_title', { name })}
      onCancel={handleClose}
      onOk={() => installMutation.mutate(entry)}
      okText={entry.installed ? t('plugin.update') : t('plugin.install')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !isVersionValid || !isConfirmed, danger: isThirdParty }}
      confirmLoading={installMutation.isPending}
      mask={{ closable: !installMutation.isPending }}
      destroyOnHidden
    >
      <div className={styles['install-body']}>
        <PluginMeta
          items={[
            t('plugin.from_source', { source: entry.source_id === 'official' ? t('plugin.source_official') : entry.source_name }),
            entry.install_type,
            entry.platforms.length > 0 && t('plugin.platforms', { platforms: entry.platforms.join(', ') }),
          ]}
        />
        {!isPluginSystemEnabled && <Notice tone="warning" title={t('plugin.installed_while_disabled')} />}
        <div>
          <div className={styles['setting-label']}>{t('plugin.version_label')}</div>
          <Radio.Group value={versionMode} onChange={(event) => setVersionMode(event.target.value)}>
            <Radio value="latest">{t('plugin.version_latest', { version: formatPluginVersion(entry.version) || '—' })}</Radio>
            <Radio value="pinned">{t('plugin.version_pinned')}</Radio>
          </Radio.Group>
          {versionMode === 'pinned' && (
            <div className={styles['install-version-row']}>
              <Input
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder={t('plugin.version_placeholder')}
                status={version.trim() && !isVersionValid ? 'error' : undefined}
                aria-label={t('plugin.version_pinned')}
                className={styles['version-input']}
              />
            </div>
          )}
        </div>
        {isThirdParty && (
          <Notice
            tone="warning"
            title={t('plugin.third_party_title')}
            description={(
              <div className={styles['install-body']}>
                <span>{t('plugin.third_party_desc')}</span>
                <label className={styles['rule-field']}>
                  <span className={styles['rule-field-label']}>{t('plugin.third_party_confirm', { token })}</span>
                  <Input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    placeholder={token}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
            )}
          />
        )}
      </div>
    </Modal>
  );
}
