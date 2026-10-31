import React from 'react';
import { Button, Input, Modal, Radio, Segmented, Select } from 'antd';
import { ListLoading } from '../common/PageLoading';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DownloadOutlined,
  InfoCircleOutlined,
  LockOutlined,
  PuzzleOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SyncOutlined,
  TagOutlined,
  WarningOutlined,
} from '../icons';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useI18n, useT } from '../../i18n';
import { formatPluginVersion, type PluginStoreSourceError, type StorePluginItem } from '../../types/plugin';
import {
  filterStorePlugins,
  isOmcRecommended,
  sortRecommendedFirst,
  storeEntryKey,
  isStoreInstallBlocked,
  PLUGIN_STORE_FILTERS,
  STORE_INSTALL_WARNINGS,
  storeFilterCounts,
  storeInstallConfirmToken,
  storePluginOrigin,
  type PluginStoreFilter,
} from './pluginStoreLogic';
import { pluginDescription } from './pluginDescription';
import { PluginLinks, PluginLogo, PluginMeta } from './PluginParts';
import styles from './Plugins.module.css';
import { useToast } from '../feedback';
import { LoadFailure, Notice } from '../feedback';
import { SearchInput } from '../common/SearchInput';
import { EmptyState } from '../common/EmptyState';
import { Toolbar } from '../common/Toolbar';
import { Tooltip } from '../common/Tooltip';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';

/** Past this length a description is clamped with a toggle; shorter ones never need one. */
const DESCRIPTION_CLAMP_CHARS = 150;

/**
 * The card's origin mark. Its four states keep two facts apart that the operator would
 * otherwise have to infer: which registry listed the entry, and whether the gateway
 * vendor publishes its code. `official-source` is the case that otherwise reads as
 * third-party - the vendor's catalogue, a community author's repository.
 */
function StoreOriginBadge({ entry }: { entry: StorePluginItem }) {
  const t = useT();
  switch (storePluginOrigin(entry)) {
    case 'omc-community':
      return <span className={`${styles.badge} ${styles['badge-warn']}`}><PuzzleOutlined />{t('plugin.badge_omc')}</span>;
    case 'official':
      return <span className={`${styles.badge} ${styles['badge-success']}`}><SafetyCertificateOutlined />{t('plugin.badge_official')}</span>;
    case 'official-source':
      return <span className={styles.badge}><InfoCircleOutlined />{t('plugin.badge_official_source')}</span>;
    default:
      return <span className={`${styles.badge} ${styles['badge-warn']}`}><WarningOutlined />{t('plugin.badge_third_party')}</span>;
  }
}

/** One registry the store shows, read on its own: its own loading, failure and notice. */
export interface StoreSection {
  /** `official`, `omc`, or the id of a source the operator configured. */
  key: string;
  title: string;
  data: { plugins: StorePluginItem[]; source_errors: PluginStoreSourceError[]; plugins_enabled?: boolean } | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Why the registry lists nothing, when the page can say so (a source switched off). */
  notice?: React.ReactNode;
}

interface PluginStorePanelProps {
  sections: readonly StoreSection[];
  /** The source filter: every default registry, or one registry. */
  sourceOptions: ReadonlyArray<{ value: string; label: string }>;
  sourceFilter: string;
  onSelectSource: (value: string) => void;
  isDemo: boolean;
  onManage: (pluginId: string) => void;
  onOpenSettings: () => void;
}

/**
 * The plugin store: CPA's official registry and Oh My CPA's plugin registry side by side,
 * and any registry the operator added, one section per registry.
 *
 * Each registry is read on its own, so one that cannot be read, or that is switched off,
 * says so in its own section without hiding the others. A card belongs to the registry
 * that listed it: two registries may list the same plugin id, and each card installs from
 * its own registry. Installing a plugin runs its code inside the gateway, so the card says
 * two things before anything else: which registry listed the entry, and whose code it
 * names. CPA's official registry with the vendor's repository is the only combination that
 * installs without acknowledging the code by typing the plugin's id.
 *
 * Entries tagged as adapted for Oh My CPA lead their section. The tag is a recommendation
 * for compatibility, not a grant: those plugins install with the same acknowledgement,
 * and the built-in automation never manages them.
 */
export function PluginStorePanel({ sections, sourceOptions, sourceFilter, onSelectSource, isDemo, onManage, onOpenSettings }: PluginStorePanelProps) {
  const { t, lang } = useI18n();
  const isPhone = useIsPhoneViewport();
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<PluginStoreFilter>('all');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [installing, setInstalling] = React.useState<{ entry: StorePluginItem; pluginsEnabled: boolean | undefined } | null>(null);

  const entries = React.useMemo(() => sections.flatMap((section) => section.data?.plugins ?? []), [sections]);
  const counts = React.useMemo(() => storeFilterCounts(entries), [entries]);
  const isLoadingAll = sections.every((section) => section.isLoading);

  const toggleDescription = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filterLabels: Record<PluginStoreFilter, string> = {
    all: t('plugin.filter_all'),
    recommended: t('plugin.filter_recommended'),
    installed: t('plugin.filter_installed'),
    available: t('plugin.filter_available'),
    updates: t('plugin.filter_updates'),
  };

  const filterOptions = PLUGIN_STORE_FILTERS.map((value) => ({ value, label: `${filterLabels[value]} ${counts[value]}` }));

  return (
    <div data-plugin-panel="store">
      <Toolbar>
        <Select
          className={styles['source-select']}
          value={sourceFilter}
          onChange={onSelectSource}
          aria-label={t('plugin.store_source')}
          options={sourceOptions.map((option) => ({ ...option }))}
        />
        {/* Five counted filters do not fit a phone's width as tabs; there they are a list
            beside the source, and the search takes the line below. */}
        {isPhone && (
          <Select
            className={styles['source-select']}
            value={filter}
            disabled={isLoadingAll}
            onChange={(value) => setFilter(value)}
            aria-label={t('plugin.store_filter')}
            options={filterOptions}
          />
        )}
        <SearchInput
          className={styles.search}
          value={query}
          onChange={setQuery}
          label={t('plugin.search_store')}
        />
        {!isPhone && (
          <Segmented
            className={styles['store-filters']}
            value={filter}
            disabled={isLoadingAll}
            onChange={(value) => setFilter(value as PluginStoreFilter)}
            options={filterOptions}
          />
        )}
      </Toolbar>

      {sections.map((section) => {
        const listed = section.data?.plugins ?? [];
        const visible = sortRecommendedFirst(filterStorePlugins(listed, query, filter, lang));
        return (
          <section key={section.key} className={styles['store-section']} data-store-source={section.key}>
            {sections.length > 1 && (
              <h3 className={styles['section-title']}>
                <span>{section.title}</span>
                {section.data && <span className={styles['section-count']}>{listed.length}</span>}
              </h3>
            )}
            {section.isLoading ? (
              <ListLoading className={styles.empty} />
            ) : section.error ? (
              <LoadFailure className={styles['store-notice']} title={t('plugin.source_errors_title')} error={section.error} onRetry={section.onRetry} />
            ) : (
              <>
                {section.notice}
                {(section.data?.source_errors.length ?? 0) > 0 && (
                  <Notice
                    className={styles['store-notice']}
                    tone="warning"
                    title={t('plugin.source_errors_title')}
                    description={(
                      <ul>
                        {section.data?.source_errors.map((sourceError) => (
                          <li key={sourceError.source_id || sourceError.source_url}>
                            <strong>{sourceError.source_name || sourceError.source_url}</strong>: {sourceError.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    action={<Button size="small" onClick={onOpenSettings}>{t('plugin.open_settings')}</Button>}
                  />
                )}
                {visible.length > 0 ? (
                  <div className={styles['card-grid']}>
                    {visible.map((entry) => {
                      const key = storeEntryKey(entry);
                      return (
                        <StoreCard
                          key={key}
                          entry={entry}
                          description={pluginDescription(lang, entry)}
                          isExpanded={expanded.has(key)}
                          isDemo={isDemo}
                          onToggleDescription={() => toggleDescription(key)}
                          onInstall={() => setInstalling({ entry, pluginsEnabled: section.data?.plugins_enabled })}
                          onManage={() => onManage(entry.id)}
                        />
                      );
                    })}
                  </div>
                ) : !section.notice && (section.data?.source_errors.length ?? 0) === 0 && (
                  <EmptyState className={styles.empty} title={listed.length === 0 ? t('plugin.store_empty') : t('plugin.search_empty')} />
                )}
              </>
            )}
          </section>
        );
      })}

      <PluginInstallModal
        entry={installing?.entry ?? null}
        isPluginSystemEnabled={installing?.pluginsEnabled}
        onClose={() => setInstalling(null)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

interface StoreCardProps {
  entry: StorePluginItem;
  /** The description in the reading language, resolved by the caller. */
  description: string;
  isExpanded: boolean;
  isDemo: boolean;
  onToggleDescription: () => void;
  onInstall: () => void;
  onManage: () => void;
}

function StoreCard({ entry, description, isExpanded, isDemo, onToggleDescription, onInstall, onManage }: StoreCardProps) {
  const t = useT();
  const blocked = isStoreInstallBlocked(entry);
  const isFromOtherSource = entry.installed && entry.install_source_status === 'different';
  const isUpdate = entry.installed && entry.update_available;
  const version = isUpdate && entry.installed_version
    ? t('plugin.version_arrow', { from: formatPluginVersion(entry.installed_version), to: formatPluginVersion(entry.version) })
    : formatPluginVersion(entry.installed ? entry.installed_version || entry.version : entry.version);
  const isLong = description.length > DESCRIPTION_CLAMP_CHARS;
  const actionTitle = isDemo ? t('demo.blocked') : blocked === 'auth' ? t('plugin.auth_required_hint') : undefined;

  return (
    <article className={styles['store-card']} data-store-id={entry.store_id} data-plugin-id={entry.id} data-store-origin={storePluginOrigin(entry)}>
      <div className={styles['card-head']}>
        <PluginLogo logo={entry.logo} />
        <div className={styles['card-title']}>
          <span className={styles['card-name']} title={entry.name || entry.id}>{entry.name || entry.id}</span>
          <span className={styles['plugin-id']}>{entry.id}</span>
        </div>
      </div>

      <span className={styles.badges}>
        <StoreOriginBadge entry={entry} />
        {isOmcRecommended(entry) && (
          <Tooltip title={t('plugin.badge_recommended_hint')}>
            <span className={styles.badge} data-store-recommended><TagOutlined />{t('plugin.badge_recommended')}</span>
          </Tooltip>
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
          entry.source_name && t('plugin.from_source', {
            source: entry.source_kind === 'omc_community'
              ? t('plugin.source_omc')
              : entry.is_official ? t('plugin.source_official') : entry.source_name,
          }),
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
  /** CPA's plugin switch as the list read it; absent when the read could not tell. */
  isPluginSystemEnabled: boolean | undefined;
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
      if (code === 'builtin_policy_blocks_install') {
        toast.warning(t('plugin.install_blocked_builtin'));
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

  if (!entry) return null;

  const origin = storePluginOrigin(entry);
  const warning = STORE_INSTALL_WARNINGS[origin];
  const token = storeInstallConfirmToken(entry);
  const isVersionValid = versionMode === 'latest' || /^v?[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version.trim());
  // The warning block carries the only confirmation input, so its presence is the gate.
  const isConfirmed = !warning || confirmation.trim() === token;
  const name = entry.name || entry.id;

  return (
    <Modal
      open
      title={entry.installed ? t('plugin.update_title', { name }) : t('plugin.install_title', { name })}
      onCancel={handleClose}
      onOk={() => installMutation.mutate(entry)}
      okText={entry.installed ? t('plugin.update') : t('plugin.install')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !isVersionValid || !isConfirmed, danger: Boolean(warning) }}
      confirmLoading={installMutation.isPending}
      mask={{ closable: !installMutation.isPending }}
      destroyOnHidden
    >
      <div className={styles['install-body']}>
        <PluginMeta
          items={[
            t('plugin.from_source', {
              source: entry.source_kind === 'omc_community'
                ? t('plugin.source_omc')
                : entry.is_official ? t('plugin.source_official') : entry.source_name,
            }),
            entry.install_type,
            entry.platforms.length > 0 && t('plugin.platforms', { platforms: entry.platforms.join(', ') }),
          ]}
        />
        {isPluginSystemEnabled === false && <Notice tone="warning" title={t('plugin.installed_while_disabled')} />}
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
        {warning && (
          <Notice
            tone="warning"
            title={t(warning.title)}
            description={(
              <div className={styles['install-body']}>
                <span>{t(warning.description)}</span>
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
