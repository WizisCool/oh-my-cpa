import React from 'react';
import { Button, Segmented } from 'antd';
import { ListLoading } from '../common/PageLoading';
import {
  DownloadOutlined,
  InfoCircleOutlined,
  LockOutlined,
  PuzzleOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  UpgradeOutlined,
  WarningOutlined,
} from '../icons';
import { useI18n, useT } from '../../i18n';
import { selectStorePluginMetadata } from '../../types/pluginStoreMetadata';
import type { PluginStoreResponse, StorePluginItem } from '../../types/plugin';
import {
  filterStorePlugins,
  isStoreInstallBlocked,
  PLUGIN_STORE_FILTERS,
  storeFilterCounts,
  storePluginOrigin,
  type PluginStoreFilter,
} from './pluginStoreLogic';
import { formatPluginVersion, PluginLinks, PluginLogo, PluginMeta } from './PluginParts';
import { PluginInstallModal } from './PluginInstallModal';
import styles from './Plugins.module.css';
import { Notice } from '../feedback';
import { SearchInput } from '../common/SearchInput';
import { EmptyState } from '../common/EmptyState';
import { Toolbar } from '../common/Toolbar';
import { Tooltip } from '../common/Tooltip';

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
    case 'omc':
      return <span className={`${styles.badge} ${styles['badge-accent']}`}><PuzzleOutlined />{t('plugin.badge_omc')}</span>;
    case 'official':
      return <span className={`${styles.badge} ${styles['badge-success']}`}><SafetyCertificateOutlined />{t('plugin.badge_official')}</span>;
    case 'official-source':
      return <span className={styles.badge}><InfoCircleOutlined />{t('plugin.badge_official_source')}</span>;
    default:
      return <span className={`${styles.badge} ${styles['badge-warn']}`}><WarningOutlined />{t('plugin.badge_third_party')}</span>;
  }
}

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
 * Installing a plugin runs its code inside the gateway, so the card says two things
 * before anything else: which registry listed the entry, and whose code it names. Oh My
 * CPA's own registry is marked and pinned above the others; the built-in registry with
 * the vendor's repository is the only combination that installs without acknowledging
 * the code by typing the plugin's id.
 */
export function PluginStorePanel({ store, isLoading, isDemo, onManage, onOpenSettings }: PluginStorePanelProps) {
  const t = useT();
  const { lang } = useI18n();
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<PluginStoreFilter>('all');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [installing, setInstalling] = React.useState<StorePluginItem | null>(null);

  const entries = React.useMemo(() => store?.plugins ?? [], [store]);
  const counts = React.useMemo(() => storeFilterCounts(entries), [entries]);
  const visible = React.useMemo(() => filterStorePlugins(entries, query, filter, lang), [entries, query, filter, lang]);

  const toggleDescription = (storeId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(storeId)) next.delete(storeId);
      else next.add(storeId);
      return next;
    });
  };

  if (isLoading) {
    return <ListLoading className={styles.empty} />;
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

      <Toolbar className={styles['toolbar-spaced']}>
        <SearchInput
          className={styles.search}
          value={query}
          onChange={setQuery}
          label={t('plugin.search_store')}
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
      </Toolbar>

      {visible.length === 0 ? (
        <EmptyState className={styles.empty} title={entries.length === 0 ? t('plugin.store_empty') : t('plugin.search_empty')} />
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
  const { lang } = useI18n();
  const metadata = selectStorePluginMetadata(entry, lang);
  const blocked = isStoreInstallBlocked(entry);
  const isFromOtherSource = entry.installed && entry.install_source_status === 'different';
  const isUpdate = entry.installed && entry.update_available;
  const version = isUpdate && entry.installed_version
    ? t('plugin.version_arrow', { from: formatPluginVersion(entry.installed_version), to: formatPluginVersion(entry.version) })
    : formatPluginVersion(entry.installed ? entry.installed_version || entry.version : entry.version);
  const description = metadata.description?.trim() ?? '';
  const isLong = description.length > DESCRIPTION_CLAMP_CHARS;
  const actionTitle = isDemo ? t('demo.blocked') : blocked === 'auth' ? t('plugin.auth_required_hint') : undefined;

  return (
    <article className={styles['store-card']} data-store-id={entry.store_id} data-plugin-id={entry.id} data-store-origin={storePluginOrigin(entry)}>
      <div className={styles['card-head']}>
        <PluginLogo logo={entry.logo} />
        <div className={styles['card-title']}>
          <span className={styles['card-name']} title={metadata.name || entry.id}>{metadata.name || entry.id}</span>
          <span className={styles['plugin-id']}>{entry.id}</span>
        </div>
      </div>

      <span className={styles.badges}>
        <StoreOriginBadge entry={entry} />
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
          metadata.author && t('plugin.by_author', { author: metadata.author }),
          metadata.license,
          entry.source_name && t('plugin.from_source', {
            source: entry.is_omc
              ? t('plugin.source_omc')
              : entry.is_official ? t('plugin.source_official') : entry.source_name,
          }),
        ]}
      />

      {metadata.tags.length > 0 && (
        <div className={styles.tags}>
          {metadata.tags.map((tag) => <span key={tag} className={styles.tag}>{tag}</span>)}
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
              <Button type="primary" size="small" icon={<UpgradeOutlined />} disabled={isDemo || blocked !== undefined} onClick={onInstall}>
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
        <PluginLinks repositoryURL={entry.repository_url} homepage={metadata.homepage} />
      </div>
    </article>
  );
}
