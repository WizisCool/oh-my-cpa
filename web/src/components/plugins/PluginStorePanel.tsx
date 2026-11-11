import React from 'react';
import { Select } from 'antd';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { ListLoading } from '../common/PageLoading';
import { CloseOutlined, DownloadOutlined, GithubOutlined, LockOutlined, SettingOutlined, TagOutlined, UpgradeOutlined } from '../icons';
import { useI18n, useT } from '../../i18n';
import { selectStorePluginMetadata } from '../../types/pluginStoreMetadata';
import type { PluginStoreResponse, StorePluginItem } from '../../types/plugin';
import { useOmcPluginSource } from '../../hooks/useOmcPluginSource';
import {
  filterStorePlugins,
  isStoreInstallBlocked,
  PLUGIN_STORE_FILTERS,
  storeFilterCounts,
  storePluginOrigin,
  storeSectionPreview,
  storeSections,
  STORE_SECTION_PREVIEW,
  type PluginStoreFilter,
  type StoreSection,
} from './pluginStoreLogic';
import { formatPluginVersion, PluginLinks, PluginLogo, PluginMeta, PluginOriginBadge } from './PluginParts';
import { PluginInstallModal } from './PluginInstallModal';
import styles from './Plugins.module.css';
import { Notice, useToast } from '../feedback';
import { SearchInput } from '../common/SearchInput';
import { EmptyState } from '../common/EmptyState';
import { Toolbar } from '../common/Toolbar';
import { RefreshButton } from '../common/RefreshButton';
import { Tooltip } from '../common/Tooltip';
import { SectionHeading } from '../common/SectionHeading';
import { BrandArtwork } from '../common/BrandArtwork';
import { Count } from '../common/Count';
import { FilterDisclosure } from '../common/FilterDisclosure';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { FilterTransition, useFilterItemMotion } from '../../motion/filter';
import { m } from '../../motion';

/** Past this length a description is clamped with a toggle; shorter ones never need one. */
const DESCRIPTION_CLAMP_CHARS = 150;

/** Where Oh My CPA's registry is maintained and where plugins are submitted to it. */
const OMC_PLUGIN_REGISTRY_URL = 'https://github.com/omc-community/omc-plugins';

interface PluginStorePanelProps {
  store: PluginStoreResponse | undefined;
  isLoading: boolean;
  isDemo: boolean;
  onRefresh: () => void;
  isRefreshing: boolean;
  onManage: (pluginId: string) => void;
  onOpenSettings: () => void;
}

/**
 * The plugin store: one section per registry CPA reads.
 *
 * It is laid out for a long catalogue: with the whole store in view each registry shows
 * its first cards and a way to the rest, the source switch narrows to one registry, and a
 * card's tag narrows to its kind.
 *
 * Oh My CPA's own registry opens the store as its featured section: its plugins are built
 * for this console, and the plugins its organization maintains install without the typed
 * acknowledgement, as the gateway vendor's own do. The other registries follow, each under
 * its own name, so the source of every card is the section it sits in. Installing a plugin
 * runs its code inside the gateway, so each card still says whose code it is.
 */
export function PluginStorePanel({ store, isLoading, isDemo, onRefresh, isRefreshing, onManage, onOpenSettings }: PluginStorePanelProps) {
  const t = useT();
  const { lang } = useI18n();
  const isPhone = useIsPhoneViewport();
  const [query, setQuery] = React.useState('');
  // What the operator typed draws the field at once; what it leaves is filtered, cut to a shelf and
  // drawn again only when the main thread is free, so a large registry can never stall a keystroke.
  const filteredQuery = React.useDeferredValue(query);
  const [filter, setFilter] = React.useState<PluginStoreFilter>('all');
  const [tag, setTag] = React.useState<string | undefined>();
  const [facet, setFacet] = React.useState<string>(ALL_SOURCES);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [installing, setInstalling] = React.useState<StorePluginItem | null>(null);

  const entries = React.useMemo(() => store?.plugins ?? [], [store]);
  const counts = React.useMemo(() => storeFilterCounts(entries), [entries]);
  const visible = React.useMemo(() => filterStorePlugins(entries, filteredQuery, filter, lang, tag), [entries, filteredQuery, filter, lang, tag]);
  const sections = React.useMemo(() => storeSections(store, visible), [store, visible]);
  // Every source the store has, whatever a search leaves of it: a narrowed-away source stays chosen.
  const allSections = React.useMemo(() => storeSections(store, entries), [store, entries]);
  const isNarrowed = filteredQuery.trim() !== '' || filter !== 'all' || tag !== undefined;
  // A registry that is no longer read cannot stay chosen.
  const activeFacet = facet === ALL_SOURCES || allSections.some((section) => section.sourceId === facet) ? facet : ALL_SOURCES;
  // One registry in view is the operator's own choice, and it is drawn whole.
  const isSourceChosen = activeFacet !== ALL_SOURCES;

  const toggleDescription = React.useCallback((storeId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(storeId)) next.delete(storeId);
      else next.add(storeId);
      return next;
    });
  }, []);

  if (isLoading) {
    return <ListLoading className={styles.empty} />;
  }

  const filterLabels: Record<PluginStoreFilter, string> = {
    all: t('plugin.filter_all'),
    installed: t('plugin.filter_installed'),
    available: t('plugin.filter_available'),
    updates: t('plugin.filter_updates'),
  };
  const sectionTitle = (section: StoreSection) => {
    if (section.kind === 'omc') return t('plugin.omc_section_title');
    if (section.kind === 'omc-community') return t('plugin.omc_community_section_title');
    return section.kind === 'official' ? t('plugin.source_official') : section.name;
  };

  const sourceLabel = (section: StoreSection) => {
    if (section.kind === 'omc') return t('plugin.badge_omc');
    if (section.kind === 'omc-community') return t('plugin.badge_omc_community');
    return section.kind === 'official' ? t('plugin.source_official') : section.name;
  };

  const activeSection = allSections.find((section) => section.sourceId === activeFacet);
  const activeLabels = [
    activeSection ? sourceLabel(activeSection) : '',
    filter !== 'all' ? filterLabels[filter] : '',
    tag ?? '',
  ].filter(Boolean);
  const clearFilters = () => {
    setQuery('');
    setFilter('all');
    setTag(undefined);
    setFacet(ALL_SOURCES);
  };

  const isChosen = (section: StoreSection) => activeFacet === ALL_SOURCES || activeFacet === section.sourceId;
  const omcSection = sections.find((section) => section.kind === 'omc');
  const isOmcShown = activeFacet === ALL_SOURCES ? (!isNarrowed || (omcSection?.entries.length ?? 0) > 0) : omcSection !== undefined && isChosen(omcSection);
  const otherSections = sections.filter((section) => (
    section.kind !== 'omc' && isChosen(section) && (section.entries.length > 0 || (!isNarrowed && section.error))
  ));
  const cardProps = (entry: StorePluginItem) => ({
    entry,
    isExpanded: expanded.has(entry.store_id),
    isDemo,
    onToggleDescription: toggleDescription,
    onInstall: setInstalling,
    onManage,
    onSelectTag: setTag,
  });
  const showAll = (section: StoreSection) => (
    !isSourceChosen && section.entries.length > STORE_SECTION_PREVIEW ? (
      // Opening a registry of hundreds of cards is one deliberate step, and one React may interrupt.
      <Button variant="link" size="sm" className={styles['show-all']} onClick={() => React.startTransition(() => setFacet(section.sourceId))}>
        {t('plugin.section_show_all', { n: section.entries.length })}
      </Button>
    ) : undefined
  );
  const isEmpty = (activeFacet === ALL_SOURCES ? visible.length : sections.find((section) => section.sourceId === activeFacet)?.entries.length ?? 0) === 0;

  return (
    <div className={styles.store} data-plugin-panel="store">
      <Toolbar end={<RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} disabled={isRefreshing} />}>
        <SearchInput
          className={styles.search}
          value={query}
          onChange={setQuery}
          label={t('plugin.search_store')}
        />
        <FilterDisclosure activeLabel={activeLabels.join(' · ')}>
          {allSections.length > 1 && (
            <Select
              className={styles['source-select']}
              value={activeFacet}
              onChange={(value: string) => setFacet(value)}
              aria-label={t('plugin.facet_label')}
              popupMatchSelectWidth={false}
              options={[
                { value: ALL_SOURCES, label: <FilterOption label={t('plugin.facet_all')} count={visible.length} /> },
                ...allSections.map((section) => ({
                  value: section.sourceId,
                  label: (
                    <FilterOption
                      label={sourceLabel(section)}
                      count={sections.find((candidate) => candidate.sourceId === section.sourceId)?.entries.length ?? 0}
                      isOmc={section.kind === 'omc'}
                    />
                  ),
                })),
              ]}
            />
          )}
          {isPhone ? (
            <Select
              className={styles['source-select']}
              value={filter}
              onChange={(value: PluginStoreFilter) => setFilter(value)}
              aria-label={t('plugin.filter_label')}
              options={PLUGIN_STORE_FILTERS.map((value) => ({ value, label: <FilterOption label={filterLabels[value]} count={counts[value]} /> }))}
            />
          ) : (
            <Segmented
              className={styles['store-filters']}
              value={filter}
              onChange={(value) => setFilter(value as PluginStoreFilter)}
              aria-label={t('plugin.filter_label')}
              options={PLUGIN_STORE_FILTERS.map((value) => ({
                value,
                label: <span className={styles['filter-option']}>{filterLabels[value]}<Count size="small">{counts[value]}</Count></span>,
              }))}
            />
          )}
          {tag && (
            <button type="button" className={styles['tag-filter']} onClick={() => setTag(undefined)} aria-label={t('plugin.tag_filter_clear', { tag })}>
              <TagOutlined />{tag}<CloseOutlined />
            </button>
          )}
          {(isNarrowed || activeFacet !== ALL_SOURCES) && (
            <Button variant="link" size="sm" className={styles['show-all']} onClick={clearFilters}>
              {t('plugin.clear_filters')}
            </Button>
          )}
        </FilterDisclosure>
      </Toolbar>

      {isOmcShown && (
        <OmcShowcase section={omcSection} isDemo={isDemo} shouldHideEmpty={isNarrowed || sections.some((section) => section.kind === 'omc-community' && section.entries.length > 0)} onOpenSettings={onOpenSettings} extra={omcSection && showAll(omcSection)}>
          <FilterTransition itemKeys={omcSection ? storeSectionPreview(omcSection, isSourceChosen).map(storeCardKey) : []}>
            {omcSection && storeSectionPreview(omcSection, isSourceChosen).map((entry) => <StoreCard key={storeCardKey(entry)} isFeatured {...cardProps(entry)} />)}
          </FilterTransition>
        </OmcShowcase>
      )}

      {otherSections.map((section) => (
        <section key={section.sourceId} className={styles['store-section']} data-store-source={section.kind}>
          <SectionHeading
            as="h2"
            title={sectionTitle(section)}
            count={section.entries.length}
            description={section.kind === 'official'
              ? undefined
              : section.kind === 'omc-community'
                ? t('plugin.omc_community_section_desc')
                : <span className={styles['source-url']}>{section.url}</span>}
            extra={showAll(section)}
          />
          {section.error && <SourceErrorNotice message={section.error} onOpenSettings={onOpenSettings} />}
          {section.entries.length > 0 && (
            <div className={styles['card-grid']}>
              <FilterTransition itemKeys={storeSectionPreview(section, isSourceChosen).map(storeCardKey)}>
                {storeSectionPreview(section, isSourceChosen).map((entry) => <StoreCard key={storeCardKey(entry)} {...cardProps(entry)} />)}
              </FilterTransition>
            </div>
          )}
        </section>
      ))}

      {/* Oh My CPA's section says it is empty itself; any other chosen source has no section to. */}
      {isEmpty && (isNarrowed || (activeSection !== undefined && activeSection.kind !== 'omc')) && (
        <EmptyState className={styles.empty} title={isNarrowed ? t('plugin.search_empty') : t('plugin.source_empty')} />
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

const ALL_SOURCES = '*';

/** A filter choice with the number of plugins it leaves, set apart at the trailing edge. */
function FilterOption({ label, count, isOmc = false }: { label: string; count: number; isOmc?: boolean }) {
  return (
    <span className={styles['filter-option']}>
      <span className={styles['filter-option-label']}>
        {isOmc && <BrandArtwork shape="mark" height={12} />}
        {label}
      </span>
      <Count size="small">{count}</Count>
    </span>
  );
}

const storeCardKey = (entry: StorePluginItem) => entry.store_id || `${entry.source_id}/${entry.id}`;

function SourceErrorNotice({ message, onOpenSettings }: { message: string; onOpenSettings: () => void }) {
  const t = useT();
  return (
    <Notice
      tone="warning"
      title={t('plugin.source_error_title')}
      description={message}
      action={<Button size="sm" onClick={onOpenSettings}>{t('plugin.open_settings')}</Button>}
    />
  );
}

interface OmcShowcaseProps {
  section: StoreSection | undefined;
  isDemo: boolean;
  /** No "lists nothing" line: a search narrowed it, or the registry's curated half has entries. */
  shouldHideEmpty: boolean;
  onOpenSettings: () => void;
  /** A control for the whole section, beside the registry link. */
  extra?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Oh My CPA's registry, set apart at the top of the store. While the registry is switched
 * off the section stays, offering the switch itself: it is the source this console ships
 * with, and turning it back on should not take a trip to another page.
 */
function OmcShowcase({ section, isDemo, shouldHideEmpty, onOpenSettings, extra, children }: OmcShowcaseProps) {
  const t = useT();
  const toast = useToast();
  const source = useOmcPluginSource();
  const [isEnabling, setIsEnabling] = React.useState(false);
  const isSourceOff = source.isLoaded && !source.isEnabled;

  const enable = async () => {
    setIsEnabling(true);
    const outcome = await source.setEnabled(true);
    setIsEnabling(false);
    if (outcome.ok) toast.success(t('plugin.omc_source_on_success'));
  };

  return (
    <section className={styles.showcase} data-store-source="omc">
      <div className={styles['showcase-head']}>
        <span className={styles['showcase-mark']} aria-hidden="true"><BrandArtwork shape="mark" height={22} /></span>
        <SectionHeading
          as="h2"
          className={styles['showcase-heading']}
          title={t('plugin.omc_section_title')}
          count={section?.entries.length}
          description={t('plugin.omc_section_desc')}
          extra={(
            <span className={styles['card-links']}>
              {extra}
              <Tooltip title={t('plugin.omc_registry_open')}>
                <a className={styles['icon-link']} href={OMC_PLUGIN_REGISTRY_URL} target="_blank" rel="noreferrer noopener" aria-label={t('plugin.omc_registry_open')}>
                  <GithubOutlined />
                </a>
              </Tooltip>
            </span>
          )}
        />
      </div>
      {isSourceOff ? (
        <EmptyState size="compact" title={t('plugin.omc_source_off')}>
          <Tooltip title={isDemo ? t('demo.blocked') : undefined}>
            <Button variant="primary" disabled={isDemo} loading={isEnabling} onClick={() => void enable()} data-testid="plugin-omc-source-enable">
              {t('plugin.omc_source_enable')}
            </Button>
          </Tooltip>
        </EmptyState>
      ) : (
        <>
          {section?.error && <SourceErrorNotice message={section.error} onOpenSettings={onOpenSettings} />}
          {(section?.entries.length ?? 0) > 0
            ? <div className={styles['showcase-grid']}>{children}</div>
            : !section?.error && !shouldHideEmpty && <EmptyState size="compact" title={t('plugin.omc_section_empty')} />}
        </>
      )}
    </section>
  );
}

interface StoreCardProps {
  entry: StorePluginItem;
  isFeatured?: boolean;
  isExpanded: boolean;
  isDemo: boolean;
  /** The panel's own handlers, kept stable so an unchanged card is not redrawn as the search narrows. */
  onToggleDescription: (storeId: string) => void;
  onInstall: (entry: StorePluginItem) => void;
  onManage: (pluginId: string) => void;
  onSelectTag: (tag: string) => void;
}

/**
 * One store entry. Memoized because a keystroke in the search redraws the whole store otherwise: the
 * cards that a narrower search keeps are the same cards, and only the grid places them differently -
 * which the layout transition draws without React touching them.
 */
const StoreCard = React.memo(function StoreCard({ entry, isFeatured = false, isExpanded, isDemo, onToggleDescription, onInstall, onManage, onSelectTag }: StoreCardProps) {
  const t = useT();
  const filterMotion = useFilterItemMotion();
  const { lang } = useI18n();
  const metadata = selectStorePluginMetadata(entry, lang);
  const origin = storePluginOrigin(entry);
  const blocked = isStoreInstallBlocked(entry);
  const isFromOtherSource = entry.installed && entry.install_source_status === 'different';
  const isUpdate = entry.installed && entry.update_available;
  const version = isUpdate && entry.installed_version
    ? t('plugin.version_arrow', { from: formatPluginVersion(entry.installed_version), to: formatPluginVersion(entry.version) })
    : formatPluginVersion(entry.installed ? entry.installed_version || entry.version : entry.version);
  const description = metadata.description?.trim() ?? '';
  const isLong = description.length > DESCRIPTION_CLAMP_CHARS;
  const actionTitle = isDemo ? t('demo.blocked') : blocked === 'auth' ? t('plugin.auth_required_hint') : undefined;
  // Inside Oh My CPA's section every entry is tagged with the project's name; the tag says nothing there.
  const tags = isFeatured ? metadata.tags.filter((tag) => !/^(omc|oh[- ]?my[- ]?cpa)$/i.test(tag)) : metadata.tags;

  return (
    <m.article
      {...filterMotion}
      className={`${styles['store-card']} ${isFeatured ? styles['store-card-featured'] : ''}`}
      data-store-id={entry.store_id}
      data-plugin-id={entry.id}
      data-store-origin={origin}
    >
      <div className={styles['card-head']}>
        <PluginLogo logo={entry.logo} />
        <div className={styles['card-title']}>
          <span className={styles['card-name']} title={metadata.name || entry.id}>{metadata.name || entry.id}</span>
          <PluginMeta
            items={[
              version && <span className={styles['meta-strong']}>{version}</span>,
              metadata.author && t('plugin.by_author', { author: metadata.author }),
            ]}
          />
        </div>
      </div>

      <span className={styles.badges}>
        <PluginOriginBadge origin={origin} />
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
            <button type="button" className={styles['text-toggle']} onClick={() => onToggleDescription(entry.store_id)} aria-expanded={isExpanded}>
              {isExpanded ? t('plugin.show_less') : t('plugin.show_more')}
            </button>
          )}
        </>
      ) : (
        <p className={`${styles['card-description']} ${styles['card-description-muted']}`}>{t('plugin.no_description')}</p>
      )}

      {tags.length > 0 && (
        <div className={styles.tags}>
          {tags.map((tag) => (
            <button key={tag} type="button" className={`${styles.tag} ${styles['tag-button']}`} onClick={() => onSelectTag(tag)} aria-label={t('plugin.tag_filter_apply', { tag })}>
              {tag}
            </button>
          ))}
        </div>
      )}

      <div className={styles['card-footer']}>
        <span className={styles['card-actions']}>
          {!entry.installed && (
            <Tooltip title={actionTitle}>
              <Button variant="primary" size="sm" icon={<DownloadOutlined />} disabled={isDemo || blocked !== undefined} onClick={() => onInstall(entry)}>
                {t('plugin.install')}
              </Button>
            </Tooltip>
          )}
          {isUpdate && (
            <Tooltip title={actionTitle}>
              <Button variant="primary" size="sm" icon={<UpgradeOutlined />} disabled={isDemo || blocked !== undefined} onClick={() => onInstall(entry)}>
                {t('plugin.update')}
              </Button>
            </Tooltip>
          )}
          {entry.installed && (
            <Button size="sm" icon={<SettingOutlined />} onClick={() => onManage(entry.id)}>
              {t('plugin.manage')}
            </Button>
          )}
        </span>
        <PluginLinks repositoryURL={entry.repository_url} homepage={metadata.homepage} />
      </div>
    </m.article>
  );
});
