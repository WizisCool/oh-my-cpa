import React from 'react';
import clsx from 'clsx';
import { Select } from '@/components/ui/select';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { DropdownCaret } from '@/components/ui/dropdown-caret';
import { Segmented } from '@/components/ui/segmented';
import { SearchInput } from '../../components/common/SearchInput';
import { ToolButton } from '../../components/common/ToolButton';
import { Tooltip } from '../../components/common/Tooltip';
import {
  AppstoreOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckSquareOutlined,
  FilterOutlined,
  ListOutlined,
  SwapOutlined,
  SyncOutlined,
} from '../../components/icons';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { AuthFileStatusFilter } from '../../components/authFiles/authFileLogic';
import { HEALTH_BUCKETS, type HealthBucket, type HealthLens } from './fleetPresentation';
import type { OAuthWorkspaceLayout, OAuthWorkspaceQuotaFilter, OAuthWorkspaceSortKey } from './oauthWorkspaceLogic';
import styles from './FleetHeader.module.css';

const BUCKET_LABELS: Record<HealthBucket, MessageKey> = {
  attention: 'omc.fleet_health_attention',
  stale: 'omc.fleet_health_stale',
  healthy: 'omc.fleet_health_healthy',
  disabled: 'omc.fleet_health_disabled',
};

/**
 * The scope's health, which is also its triage filter. Each credential is counted under exactly one
 * verdict, so picking one shows exactly the credentials it counted, and picking it again shows them
 * all. A verdict nobody is in is left out, unless it is the one in force.
 */
function HealthFilter({ counts, isPending, lens, onLens }: Pick<FleetToolbarProps, 'counts' | 'isPending' | 'lens' | 'onLens'>) {
  const t = useT();
  return (
    <div className={clsx(styles.health, 'scroll-fade-x')} role="group" aria-label={t('omc.fleet_health')} data-testid="oauth-health-filter">
      {HEALTH_BUCKETS.map((bucket) => {
        const count = counts[bucket];
        const isActive = lens === bucket;
        if (!isPending && count === 0 && !isActive) return null;
        return (
          <button
            key={bucket}
            type="button"
            className={clsx(styles.lens, isActive && styles['lens-active'])}
            aria-pressed={isActive}
            onClick={() => onLens(isActive ? 'all' : bucket)}
            data-health-lens={bucket}
          >
            <span className={clsx(styles.pip, styles[`pip-${bucket}`])} aria-hidden="true" />
            <span className={styles['lens-label']}>{t(BUCKET_LABELS[bucket])}</span>
            <span className={styles['lens-count']}>{isPending ? '—' : count}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface FleetToolbarProps {
  search: string;
  onSearch: (value: string) => void;
  counts: Record<HealthBucket, number>;
  isPending: boolean;
  lens: HealthLens;
  onLens: (lens: HealthLens) => void;
  status: AuthFileStatusFilter;
  quota: OAuthWorkspaceQuotaFilter;
  sort: OAuthWorkspaceSortKey;
  isViewLoaded: boolean;
  onFilters: (changes: { status?: AuthFileStatusFilter; quota?: OAuthWorkspaceQuotaFilter }) => void;
  onSort: (sort: OAuthWorkspaceSortKey) => void;
  onReset: () => void;
  layout: OAuthWorkspaceLayout;
  onLayout: (layout: OAuthWorkspaceLayout) => void;
  /** Whether a choice of credentials is under way; the select tool starts one and clears it. */
  isSelecting: boolean;
  onSelecting: () => void;
  refresh: {
    filtered: number;
    page: number;
    all: number;
    isBusy: boolean;
    isDisabled: boolean;
    onRefresh: (scope: 'page' | 'filtered' | 'all') => void;
  };
}

const SORTS: { key: OAuthWorkspaceSortKey; label: MessageKey; icon?: React.ReactNode }[] = [
  { key: 'custom', label: 'omc.sort_custom' },
  { key: 'name-asc', label: 'af.sort_name_asc' },
  { key: 'name-desc', label: 'af.sort_name_desc' },
  { key: 'quota-desc', label: 'omc.fleet_sort_quota_desc', icon: <ArrowDownOutlined aria-hidden /> },
  { key: 'quota-asc', label: 'omc.fleet_sort_quota_asc', icon: <ArrowUpOutlined aria-hidden /> },
  { key: 'priority-desc', label: 'af.sort_priority' },
  { key: 'weight-desc', label: 'af.sort_weight' },
];

/**
 * The row over the credentials in scope: find them, triage them by health, narrow and order them,
 * choose how to look at them and refresh their quota. Only the search takes a label; the other
 * tools are glyphs that name themselves on hover.
 *
 * It is laid out on a grid of three areas rather than a wrapping row, so the parts land in the same
 * place at every width: the search, the health verdicts and the tools side by side on a wide page;
 * the search on a line of its own over the verdicts and the tools on a narrow one.
 */
export function FleetToolbar({
  search, onSearch, counts, isPending, lens, onLens, status, quota, sort, isViewLoaded, onFilters, onSort, onReset, layout, onLayout, isSelecting, onSelecting, refresh,
}: FleetToolbarProps) {
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const filterCount = Number(status !== 'all') + Number(quota !== 'all');
  const sortLabel = t(SORTS.find((entry) => entry.key === sort)?.label ?? 'omc.sort_custom');
  return (
    <div className={styles.frame}>
    <div className={styles.toolbar}>
      <SearchInput className={styles.search} value={search} onChange={onSearch} label={t('af.search_ph')} />
      <HealthFilter counts={counts} isPending={isPending} lens={lens} onLens={onLens} />
      {/* What narrows and orders the list sits with the search; how it is drawn and refreshed, with
          the verdicts. On a wide page the two groups read as one row of tools. */}
      <div className={clsx(styles.tools, styles['query-tools'])}>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant={filterCount > 0 ? 'active' : 'secondary'}
                className={styles['tool-button']}
                icon={<FilterOutlined />}
                aria-label={t('events.more_filters')}
                aria-controls="oauth-collection-filters"
                data-testid="oauth-filter-toggle"
              >
                {filterCount > 0 && <span className={styles['tool-count']}>{filterCount}</span>}
              </Button>
            }
          />
          <PopoverContent placement="bottomRight">
            <div className={styles.filters} id="oauth-collection-filters">
              <label className={styles['filter-field']}>
                <span className={styles['filter-label']}>{t('af.detail_status')}</span>
                <Select<AuthFileStatusFilter>
                  disabled={!isViewLoaded}
                  value={status}
                  onChange={(next) => onFilters({ status: next })}
                  aria-label={t('af.detail_status')}
                  options={[
                    { value: 'all', label: t('af.status_all') },
                    { value: 'enabled', label: t('af.enabled') },
                    { value: 'disabled', label: t('af.disabled') },
                    { value: 'problem', label: t('af.status_problem') },
                  ]}
                />
              </label>
              <label className={styles['filter-field']}>
                <span className={styles['filter-label']}>{t('omc.tab_quota')}</span>
                <Select<OAuthWorkspaceQuotaFilter>
                  disabled={!isViewLoaded}
                  value={quota}
                  onChange={(next) => onFilters({ quota: next })}
                  aria-label={t('omc.tab_quota')}
                  options={[
                    { value: 'all', label: t('common.all') },
                    { value: 'attention', label: t('omc.quota_filter_attention') },
                    { value: 'healthy', label: t('quota.status_normal') },
                    { value: 'warning', label: t('quota.status_warning') },
                    { value: 'exhausted', label: t('quota.status_exceeded') },
                    { value: 'cooldown', label: t('quota.status_cooldown') },
                    { value: 'stale', label: t('quota.status_stale') },
                    { value: 'error', label: t('quota.status_error') },
                    { value: 'unobserved', label: t('omc.quota_unobserved') },
                    { value: 'unsupported', label: t('omc.quota_unsupported') },
                  ]}
                />
              </label>
              <Button size="sm" variant="ghost" disabled={!isViewLoaded} onClick={onReset} className={styles['filter-reset']}>
                {t('omc.reset_filters')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={!isViewLoaded}
            render={
              <Tooltip title={`${t('af.sort_label')}: ${sortLabel}`}>
                <Button
                  variant={sort !== 'custom' ? 'active' : 'secondary'}
                  className={styles['tool-button']}
                  icon={<SwapOutlined rotate={90} />}
                  disabled={!isViewLoaded}
                  aria-label={`${t('af.sort_label')}: ${sortLabel}`}
                />
              </Tooltip>
            }
          />
          <DropdownMenuContent placement="bottomRight">
            <DropdownMenuRadioGroup value={sort} onValueChange={(next) => onSort(next as OAuthWorkspaceSortKey)}>
              {SORTS.map((entry) => (
                <DropdownMenuRadioItem key={entry.key} value={entry.key} icon={entry.icon}>
                  {t(entry.label)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton
          icon={<CheckSquareOutlined />}
          label={t('omc.fleet_action_select')}
          variant={isSelecting ? 'active' : 'secondary'}
          aria-pressed={isSelecting}
          disabled={!isViewLoaded}
          onClick={onSelecting}
          data-testid="oauth-select-mode"
        />
      </div>
      <div className={clsx(styles.tools, styles['view-tools'])}>
        <Segmented<OAuthWorkspaceLayout>
          className={styles.layout}
          value={layout}
          onChange={onLayout}
          options={[
            { value: 'list', icon: <ListOutlined aria-hidden />, title: t('omc.fleet_layout_list'), label: <span className="sr-only">{t('omc.fleet_layout_list')}</span> },
            { value: 'cards', icon: <AppstoreOutlined aria-hidden />, title: t('omc.fleet_layout_cards'), label: <span className="sr-only">{t('omc.fleet_layout_cards')}</span> },
          ]}
          data-testid="oauth-layout-toggle"
        />
        {/* The main segment refreshes what the workspace is showing; the caret offers the other scopes. */}
        <ButtonGroup>
          {/* Fetching quota is a call to every provider in scope, so the button says what it does; a
              phone's line also holds the verdicts, so there it is the glyph its tooltip names. */}
          <Tooltip title={t('omc.refresh_quota_count', { n: refresh.filtered })}>
            <Button
              icon={<SyncOutlined spin={refresh.isBusy} />}
              disabled={refresh.isDisabled}
              onClick={() => refresh.onRefresh('filtered')}
              aria-label={t('omc.refresh_quota_count', { n: refresh.filtered })}
              data-testid="oauth-refresh-quota"
            >
              {isPhone ? null : t('quota.btn_refresh_quota')}
            </Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={refresh.isDisabled}
              render={
                <Button className={styles.caret} data-split-caret="" icon={<DropdownCaret />} disabled={refresh.isDisabled} aria-label={t('omc.fleet_refresh_scopes')} />
              }
            />
            <DropdownMenuContent placement="bottomRight">
              <DropdownMenuItem onClick={() => refresh.onRefresh('page')}>
                {t('omc.refresh_scope_page', { n: refresh.page })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => refresh.onRefresh('filtered')}>
                {t('omc.refresh_scope_filtered', { n: refresh.filtered })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => refresh.onRefresh('all')}>
                {t('omc.refresh_scope_all', { n: refresh.all })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </div>
    </div>
    </div>
  );
}
