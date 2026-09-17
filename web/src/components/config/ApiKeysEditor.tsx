import React from 'react';
import {
  App as AntdApp,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  BarsOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  PlusOutlined,
  SearchOutlined,
  TagOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import type { ClientAPIKeyItem, ClientKeyUsageItem } from '../../types/providers';
import styles from './ApiKeysEditor.module.css';

const { Text } = Typography;

/** One rendered row: the CPA key itself plus the identity and traffic Oh My CPA
 *  knows about it. A key CPA reports but the console has never seen traffic from
 *  still gets a row - it is configured, just unused. */
export interface ApiKeyRecord {
  id: string;
  index: number;
  key: string;
  /** Usage records identity, absent when it could not be computed. */
  usageFingerprint?: string;
  alias?: string;
  aliasVersion: number;
  usage?: ClientKeyUsageItem;
}

export interface ApiKeysEditorProps {
  /** The current key list. The editor never owns it: the caller's draft does. */
  apiKeys: string[];
  /** The stored keys and their aliases, keyed by position in `apiKeys`. */
  metadata?: ClientAPIKeyItem[];
  /** Keyed by usage fingerprint. */
  usage?: Record<string, ClientKeyUsageItem>;
  /**
   * Formats a timestamp for the last-used cell. Injected so the page renders it
   * through the same format the request list prints, so a key's last use and the
   * request row it links to cannot disagree about what a time looks like.
   */
  formatTime: (ms: number) => string;
  /** The window the usage counts describe, for the scope note. */
  usageRangeLabel: string;
  /** Replaces the whole list, so the caller stays the single source of truth. */
  onChange: (next: string[]) => void;
  /** Opens the add/edit dialog the caller owns. */
  onAdd: () => void;
  onEdit: (index: number, key: string) => void;
  /** Saves one alias. The caller owns the request and its conflict handling. */
  onRename: (record: ApiKeyRecord, alias: string) => Promise<void>;
  /** Navigates to the request console filtered by this key's identity. */
  onViewRequests: (record: ApiKeyRecord) => void;
}

/**
 * ApiKeysEditor is the presentational API-key management surface.
 *
 * It is controlled on purpose. The console persists these keys as part of the
 * visual configuration document, not through the immediate `/management/api-keys`
 * mutations, so the list has to be a view over the caller's draft.
 *
 * Supports responsive layout: sleek high-density table on desktop, and adaptive
 * card view on mobile to prevent horizontal overflow and awkward mobile interaction.
 */
export const ApiKeysEditor: React.FC<ApiKeysEditorProps> = ({
  apiKeys,
  metadata,
  usage,
  formatTime,
  usageRangeLabel,
  onChange,
  onAdd,
  onEdit,
  onRename,
  onViewRequests,
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const isNarrow = useIsNarrowViewport();

  const [revealedKeys, setRevealedKeys] = React.useState<Record<number, boolean>>({});
  const [renaming, setRenaming] = React.useState<ApiKeyRecord | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [isSavingName, setIsSavingName] = React.useState(false);

  // Search and filter state
  const [searchQuery, setSearchQuery] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<'all' | 'active' | 'idle'>('all');
  const [viewPreference, setViewPreference] = React.useState<'table' | 'cards' | null>(null);

  // Active view: on narrow screens force cards unless user specifically overrides
  const activeView = viewPreference ?? (isNarrow ? 'cards' : 'table');

  // Metadata is joined by position because CPA's list and Oh My CPA's overlay are
  // both ordered by the same document.
  const dataSource: ApiKeyRecord[] = React.useMemo(() => {
    return apiKeys.map((key, index) => {
      const entry = metadata?.[index];
      const matchesStored = entry !== undefined && entry.key === key;
      const usageFingerprint = matchesStored ? entry.usage_fingerprint : undefined;
      return {
        id: `${index}-${key}`,
        index,
        key,
        usageFingerprint,
        alias: matchesStored ? entry.alias : undefined,
        aliasVersion: matchesStored ? entry.alias_version : 0,
        usage: usageFingerprint ? usage?.[usageFingerprint] : undefined,
      };
    });
  }, [apiKeys, metadata, usage]);

  const activeCount = React.useMemo(
    () => dataSource.filter((r) => (r.usage?.requests ?? 0) > 0).length,
    [dataSource],
  );
  const idleCount = dataSource.length - activeCount;

  // Filtered keys
  const filteredData = React.useMemo(() => {
    return dataSource.filter((record) => {
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const aliasMatch = (record.alias ?? '').toLowerCase().includes(q);
        const keyMatch = record.key.toLowerCase().includes(q);
        if (!aliasMatch && !keyMatch) return false;
      }
      if (filterStatus === 'active') {
        return (record.usage?.requests ?? 0) > 0;
      }
      if (filterStatus === 'idle') {
        return !record.usage || record.usage.requests === 0;
      }
      return true;
    });
  }, [dataSource, searchQuery, filterStatus]);

  const handleDelete = (index: number) => {
    onChange(apiKeys.filter((_, position) => position !== index));
    setRevealedKeys({});
  };

  const openRename = (record: ApiKeyRecord) => {
    setRenaming(record);
    setRenameValue(record.alias ?? '');
  };

  const submitRename = async () => {
    if (!renaming) return;
    setIsSavingName(true);
    try {
      await onRename(renaming, renameValue.trim());
      setRenaming(null);
      setRenameValue('');
    } catch {
      // The caller reports failure; dialog stays open.
    } finally {
      setIsSavingName(false);
    }
  };

  const handleCopy = async (keyText: string) => {
    try {
      await navigator.clipboard.writeText(keyText);
      message.success(t('cfg.source_copy_success'));
    } catch {
      message.error(t('cfg.copy_failed'));
    }
  };

  return (
    <div className="settings-group">
      {/* settings-group-head retains classes and selectors expected by acceptance tests */}
      <div className="settings-group-head" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyOutlined />
          <h3 className="settings-group-title">{t('cfg.api_keys_list')}</h3>
          <Tag style={{ margin: 0 }}>{t('cfg.api_keys_count', { n: apiKeys.length })}</Tag>
        </div>
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={onAdd}
          className="config-add-key-btn"
        >
          {t('cfg.api_keys_add')}
        </Button>
      </div>

      {/* Toolbar: Search, Status Filter, View Mode */}
      {apiKeys.length > 0 && (
        <div className={styles['toolbar']}>
          <div className={styles['toolbar-left']}>
            <Input
              size="small"
              allowClear
              placeholder={t('keys.search_placeholder')}
              prefix={<SearchOutlined style={{ color: 'var(--muted)' }} />}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={styles['toolbar-search']}
            />
            <Segmented
              size="small"
              value={filterStatus}
              onChange={(val) => setFilterStatus(val as 'all' | 'active' | 'idle')}
              options={[
                { label: t('keys.filter_all', { n: dataSource.length }), value: 'all' },
                { label: t('keys.filter_active', { n: activeCount }), value: 'active' },
                { label: t('keys.filter_idle', { n: idleCount }), value: 'idle' },
              ]}
            />
          </div>
          {!isNarrow && (
            <div className={styles['toolbar-right']}>
              <Segmented
                size="small"
                value={activeView}
                onChange={(val) => setViewPreference(val as 'table' | 'cards')}
                options={[
                  { label: t('keys.view_mode_table'), value: 'table', icon: <BarsOutlined /> },
                  { label: t('keys.view_mode_cards'), value: 'cards', icon: <AppstoreOutlined /> },
                ]}
              />
            </div>
          )}
        </div>
      )}

      {/* Empty State */}
      {apiKeys.length === 0 ? (
        <div className={styles['empty-box']}>
          <KeyOutlined className={styles['empty-icon']} />
          <div className={styles['empty-title']}>{t('keys.empty_title')}</div>
          <div className={styles['empty-desc']}>{t('keys.empty_desc')}</div>
          <Button type="primary" icon={<PlusOutlined />} onClick={onAdd} style={{ marginTop: 4 }}>
            {t('keys.empty_cta')}
          </Button>
        </div>
      ) : filteredData.length === 0 ? (
        <div className={styles['empty-box']}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('cfg.api_keys_empty')} />
        </div>
      ) : activeView === 'table' ? (
        /* Desktop Table View */
        <Table<ApiKeyRecord>
          className="config-api-keys-table"
          size="small"
          rowKey="id"
          dataSource={filteredData}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: t('cfg.api_keys_empty') }}
          columns={[
            {
              title: t('keys.col_name'),
              key: 'name',
              render: (_: unknown, record: ApiKeyRecord) => {
                const isActive = (record.usage?.requests ?? 0) > 0;
                return (
                  <div className={styles['name-cell']}>
                    <span
                      className={`${styles['status-pip']} ${
                        isActive ? styles['status-pip-active'] : styles['status-pip-idle']
                      }`}
                      title={isActive ? t('keys.status_active') : t('keys.status_idle')}
                    />
                    {record.alias ? (
                      <Text strong className={styles['name-text']}>{record.alias}</Text>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openRename(record)}
                        className={styles['unnamed-btn']}
                        title={t('keys.rename_title')}
                      >
                        <TagOutlined /> {t('keys.unnamed')}
                      </button>
                    )}
                  </div>
                );
              },
            },
            {
              title: t('keys.col_key'),
              key: 'key',
              render: (_: unknown, record: ApiKeyRecord) => (
                <div className="config-key-box">
                  <span className="config-key-text">
                    {revealedKeys[record.index] ? record.key : maskKeyText(record.key)}
                  </span>
                </div>
              ),
            },
            {
              title: t('keys.col_requests'),
              key: 'requests',
              width: 120,
              render: (_: unknown, record: ApiKeyRecord) =>
                record.usage ? (
                  <Text className="mono-num">{record.usage.requests.toLocaleString()}</Text>
                ) : (
                  <Tooltip title={t('keys.not_linked')}>
                    <Text type="secondary">—</Text>
                  </Tooltip>
                ),
            },
            {
              title: t('keys.col_last_used'),
              key: 'lastUsed',
              width: 150,
              render: (_: unknown, record: ApiKeyRecord) =>
                record.usage && record.usage.last_used_ms > 0 ? (
                  <time dateTime={new Date(record.usage.last_used_ms).toISOString()}>
                    <Text type="secondary">{formatTime(record.usage.last_used_ms)}</Text>
                  </time>
                ) : (
                  <Text type="secondary">—</Text>
                ),
            },
            {
              title: t('keys.col_actions'),
              key: 'actions',
              width: 210,
              align: 'right' as const,
              render: (_: unknown, record: ApiKeyRecord) => (
                <Space size={6}>
                  <Tooltip title={t('keys.rename')}>
                    <button
                      type="button"
                      className="config-key-action"
                      onClick={() => openRename(record)}
                      aria-label={`${t('keys.rename')}: ${record.alias ?? t('keys.unnamed')}`}
                    >
                      <TagOutlined />
                    </button>
                  </Tooltip>
                  <Tooltip
                    title={
                      record.usageFingerprint
                        ? t('keys.view_requests')
                        : t('keys.not_linked')
                    }
                  >
                    <button
                      type="button"
                      className="config-key-action"
                      disabled={!record.usageFingerprint}
                      onClick={() => onViewRequests(record)}
                      aria-label={`${t('keys.view_requests')}: ${record.alias ?? t('keys.unnamed')}`}
                    >
                      <SearchOutlined />
                    </button>
                  </Tooltip>
                  <Tooltip
                    title={
                      revealedKeys[record.index]
                        ? t('common.hide_secret')
                        : t('common.reveal_secret')
                    }
                  >
                    <button
                      type="button"
                      className="config-key-action"
                      onClick={() =>
                        setRevealedKeys((prev) => ({
                          ...prev,
                          [record.index]: !prev[record.index],
                        }))
                      }
                      aria-label={
                        revealedKeys[record.index]
                          ? t('common.hide_secret')
                          : t('common.reveal_secret')
                      }
                    >
                      {revealedKeys[record.index] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                    </button>
                  </Tooltip>
                  <Tooltip title={t('cfg.api_keys_copy')}>
                    <button
                      type="button"
                      className="config-key-action"
                      onClick={() => void handleCopy(record.key)}
                      aria-label={t('cfg.api_keys_copy')}
                    >
                      <CopyOutlined />
                    </button>
                  </Tooltip>
                  <Tooltip title={t('cfg.api_keys_edit')}>
                    <button
                      type="button"
                      className="config-key-action"
                      onClick={() => onEdit(record.index, record.key)}
                      aria-label={t('cfg.api_keys_edit')}
                    >
                      <EditOutlined />
                    </button>
                  </Tooltip>
                  <Popconfirm
                    title={t('cfg.api_keys_delete_confirm')}
                    onConfirm={() => handleDelete(record.index)}
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                  >
                    <Tooltip title={t('cfg.api_keys_delete')}>
                      <button
                        type="button"
                        className="config-key-action is-danger"
                        aria-label={t('cfg.api_keys_delete')}
                      >
                        <DeleteOutlined />
                      </button>
                    </Tooltip>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      ) : (
        /* Mobile / Cards View */
        <div className={styles['mobile-cards']}>
          {filteredData.map((record) => {
            const isActive = (record.usage?.requests ?? 0) > 0;
            return (
              <div key={record.id} className={styles['key-card']}>
                <div className={styles['key-card-head']}>
                  <div className={styles['key-card-title']}>
                    <span
                      className={`${styles['status-pip']} ${
                        isActive ? styles['status-pip-active'] : styles['status-pip-idle']
                      }`}
                      title={isActive ? t('keys.status_active') : t('keys.status_idle')}
                    />
                    <span className={styles['name-text']}>
                      {record.alias ? record.alias : t('keys.unnamed')}
                    </span>
                  </div>
                  <Button
                    size="small"
                    icon={<TagOutlined />}
                    onClick={() => openRename(record)}
                  >
                    {t('keys.rename')}
                  </Button>
                </div>

                <div className={styles['key-card-token-row']}>
                  <span className={styles['key-card-token-text']}>
                    {revealedKeys[record.index] ? record.key : maskKeyText(record.key)}
                  </span>
                  <Space size={4}>
                    <Button
                      size="small"
                      type="text"
                      icon={revealedKeys[record.index] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                      onClick={() =>
                        setRevealedKeys((prev) => ({
                          ...prev,
                          [record.index]: !prev[record.index],
                        }))
                      }
                      title={revealedKeys[record.index] ? t('common.hide_secret') : t('common.reveal_secret')}
                    />
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      onClick={() => void handleCopy(record.key)}
                      title={t('cfg.api_keys_copy')}
                    />
                  </Space>
                </div>

                <div className={styles['key-card-stats']}>
                  <div className={styles['key-card-stat-item']}>
                    <span className={styles['key-card-stat-label']}>{t('keys.col_requests')}</span>
                    <span className={styles['key-card-stat-value']}>
                      {record.usage ? record.usage.requests.toLocaleString() : '—'}
                    </span>
                  </div>
                  <div className={styles['key-card-stat-item']}>
                    <span className={styles['key-card-stat-label']}>{t('keys.col_last_used')}</span>
                    <span className={styles['key-card-stat-value']}>
                      {record.usage && record.usage.last_used_ms > 0
                        ? formatTime(record.usage.last_used_ms)
                        : '—'}
                    </span>
                  </div>
                </div>

                <div className={styles['key-card-actions']}>
                  <Button
                    size="small"
                    icon={<SearchOutlined />}
                    disabled={!record.usageFingerprint}
                    onClick={() => onViewRequests(record)}
                  >
                    {t('keys.view_requests')}
                  </Button>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => onEdit(record.index, record.key)}
                  >
                    {t('cfg.api_keys_edit')}
                  </Button>
                  <Popconfirm
                    title={t('cfg.api_keys_delete_confirm')}
                    onConfirm={() => handleDelete(record.index)}
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      {t('cfg.api_keys_delete')}
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {apiKeys.length > 0 && (
        <p className={styles['scope-note']}>
          {t('keys.usage_scope', { range: usageRangeLabel })}
        </p>
      )}

      {/* Rename Modal */}
      <Modal
        title={t('keys.rename_title')}
        open={renaming !== null}
        onOk={() => void submitRename()}
        confirmLoading={isSavingName}
        onCancel={() => {
          setRenaming(null);
          setRenameValue('');
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onPressEnter={() => void submitRename()}
            placeholder={t('keys.rename_placeholder')}
            maxLength={64}
            autoFocus
            aria-label={t('keys.rename_label')}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('keys.rename_hint')}
          </Text>
        </div>
      </Modal>
    </div>
  );
};
