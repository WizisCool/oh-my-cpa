import React from 'react';
import { Input, Select, Segmented } from 'antd';
import {
  SearchOutlined,
  AppstoreOutlined,
  TableOutlined,
  BarsOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import styles from './QuotaPage.module.css';

export type ViewMode = 'cards' | 'matrix' | 'table';
export type SortMode = 'default' | 'recovery' | 'most_remaining' | 'least_remaining' | 'name';
export type StatusFilter = 'all' | 'healthy' | 'warning' | 'exhausted' | 'cooldown';

interface ProviderCount {
  key: string;
  label: string;
  count: number;
}

interface QuotaToolbarProps {
  providers: ProviderCount[];
  activeProvider: string;
  onProviderChange: (provider: string) => void;

  searchText: string;
  onSearchChange: (val: string) => void;

  statusFilter: StatusFilter;
  onStatusFilterChange: (val: StatusFilter) => void;

  sortMode: SortMode;
  onSortModeChange: (val: SortMode) => void;

  viewMode: ViewMode;
  onViewModeChange: (val: ViewMode) => void;
}

export const QuotaToolbar: React.FC<QuotaToolbarProps> = ({
  providers,
  activeProvider,
  onProviderChange,
  searchText,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  sortMode,
  onSortModeChange,
  viewMode,
  onViewModeChange,
}) => {
  const t = useT();

  return (
    <div className={styles.toolbar}>
      {/* Top row: Provider tabs */}
      <div className={styles.toolbarTopRow}>
        <div className={styles.providerTabs}>
          {providers.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`${styles.providerTabBtn} ${activeProvider === p.key ? styles.providerTabBtnActive : ''}`}
              onClick={() => onProviderChange(p.key)}
            >
              <span>{p.label}</span>
              <span className={styles.tabBadge}>{p.count}</span>
            </button>
          ))}
        </div>

        {/* View Mode Switcher */}
        <Segmented
          value={viewMode}
          onChange={(val) => onViewModeChange(val as ViewMode)}
          options={[
            { value: 'cards', icon: <AppstoreOutlined />, label: t('quota.view_cards') },
            { value: 'matrix', icon: <TableOutlined />, label: t('quota.view_matrix') },
            { value: 'table', icon: <BarsOutlined />, label: t('quota.view_table') },
          ]}
        />
      </div>

      {/* Bottom row: Search, Status filter, Sort mode */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 260 }}>
          <Input
            placeholder={t('quota.search_placeholder')}
            prefix={<SearchOutlined style={{ color: 'var(--meta)' }} />}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            allowClear
            style={{ maxWidth: 280 }}
            size="small"
          />

          <Segmented
            size="small"
            value={statusFilter}
            onChange={(val) => onStatusFilterChange(val as StatusFilter)}
            options={[
              { value: 'all', label: t('quota.filter_all') },
              { value: 'healthy', label: t('quota.filter_normal') },
              { value: 'warning', label: t('quota.filter_warning') },
              { value: 'exhausted', label: t('quota.filter_exceeded') },
              { value: 'cooldown', label: t('quota.filter_cooldown') },
            ]}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--meta)' }}>{t('quota.sort_label')}:</span>
          <Select
            size="small"
            value={sortMode}
            onChange={onSortModeChange}
            style={{ width: 170 }}
            options={[
              { value: 'default', label: t('quota.sort_default') },
              { value: 'recovery', label: t('quota.sort_recovery') },
              { value: 'least_remaining', label: t('quota.sort_least_remaining') },
              { value: 'most_remaining', label: t('quota.sort_most_remaining') },
              { value: 'name', label: t('quota.sort_name') },
            ]}
          />
        </div>
      </div>
    </div>
  );
};
