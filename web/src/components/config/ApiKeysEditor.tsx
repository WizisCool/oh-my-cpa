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
  Switch,
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
 *  knows about it. */
export interface ApiKeyRecord {
  id: string;
  index: number;
  key: string;
  disabled?: boolean;
  usageFingerprint?: string;
  alias?: string;
  aliasVersion: number;
  usage?: ClientKeyUsageItem;
}

export interface ApiKeysEditorProps {
  /** The active key list in the current draft. */
  apiKeys: string[];
  /** Temporarily disabled keys. */
  disabledKeys?: string[];
  /** Local in-flight / draft aliases. */
  pendingAliases?: Record<string, string>;
  /** The stored keys and their aliases, keyed by position or key string. */
  metadata?: ClientAPIKeyItem[];
  /** Keyed by usage fingerprint. */
  usage?: Record<string, ClientKeyUsageItem>;
  formatTime: (ms: number) => string;
  usageRangeLabel: string;
  onChange: (next: string[]) => void;
  onToggleDisable: (key: string, willBeDisabled: boolean) => void;
  onDelete: (record: ApiKeyRecord) => void;
  onAdd: () => void;
  onEdit: (index: number, key: string) => void;
  onRename: (record: ApiKeyRecord, alias: string) => Promise<void>;
  onViewRequests: (record: ApiKeyRecord) => void;
}

export const ApiKeysEditor: React.FC<ApiKeysEditorProps> = ({
  apiKeys,
  disabledKeys = [],
  pendingAliases = {},
  metadata,
  usage,
  formatTime,
  usageRangeLabel,
  onChange,
  onToggleDisable,
  onDelete,
  onAdd,
  onEdit,
  onRename,
  onViewRequests,
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const isNarrow = useIsNarrowViewport();

  const [revealedKeys, setRevealedKeys] = React.useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = React.useState<ApiKeyRecord | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [isSavingName, setIsSavingName] = React.useState(false);

  // Search and filter state
  const [searchQuery, setSearchQuery] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<'all' | 'enabled' | 'disabled'>('all');
  const [viewPreference, setViewPreference] = React.useState<'table' | 'cards' | null>(null);

  const activeView = viewPreference ?? (isNarrow ? 'cards' : 'table');

  const metaByKey = React.useMemo(() => {
    const map = new Map<string, ClientAPIKeyItem>();
    for (const item of metadata ?? []) {
      map.set(item.key, item);
    }
    return map;
  }, [metadata]);

  // Combine enabled keys from draft YAML and disabled keys from preference
  const dataSource: ApiKeyRecord[] = React.useMemo(() => {
    const activeRecords: ApiKeyRecord[] = apiKeys.map((key, index) => {
      const entry = metaByKey.get(key) ?? metadata?.[index];
      const matchesStored = entry !== undefined && entry.key === key;
      const usageFingerprint = matchesStored ? entry.usage_fingerprint : undefined;
      const assignedAlias = pendingAliases[key] ?? (matchesStored ? entry.alias : undefined);
      return {
        id: `active-${index}-${key}`,
        index,
        key,
        disabled: false,
        usageFingerprint,
        alias: assignedAlias,
        aliasVersion: matchesStored ? entry.alias_version : 0,
        usage: usageFingerprint ? usage?.[usageFingerprint] : undefined,
      };
    });

    const disabledRecords: ApiKeyRecord[] = disabledKeys.map((key, idx) => {
      const entry = metaByKey.get(key);
      const usageFingerprint = entry?.usage_fingerprint;
      const assignedAlias = pendingAliases[key] ?? entry?.alias;
      return {
        id: `disabled-${idx}-${key}`,
        index: apiKeys.length + idx,
        key,
        disabled: true,
        usageFingerprint,
        alias: assignedAlias,
        aliasVersion: entry?.alias_version ?? 0,
        usage: usageFingerprint ? usage?.[usageFingerprint] : undefined,
      };
    });

    return [...activeRecords, ...disabledRecords];
  }, [apiKeys, disabledKeys, metaByKey, metadata, pendingAliases, usage]);

  const enabledCount = apiKeys.length;
  const disabledCount = disabledKeys.length;

  // Filtered keys
  const filteredData = React.useMemo(() => {
    return dataSource.filter((record) => {
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const aliasMatch = (record.alias ?? '').toLowerCase().includes(q);
        const keyMatch = record.key.toLowerCase().includes(q);
        if (!aliasMatch && !keyMatch) return false;
      }
      if (filterStatus === 'enabled') {
        return !record.disabled;
      }
      if (filterStatus === 'disabled') {
        return Boolean(record.disabled);
      }
      return true;
    });
  }, [dataSource, searchQuery, filterStatus]);

  const handleDelete = (record: ApiKeyRecord) => {
    if (onDelete) {
      onDelete(record);
    } else {
      onChange(apiKeys.filter((_, position) => position !== record.index));
    }
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
      // Retain dialog so user can retry or adjust
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

  const totalKeysCount = apiKeys.length + disabledKeys.length;

  return (
    <div className="settings-group">
      {/* settings-group-head retains classes and selectors expected by acceptance tests */}
      <div className="settings-group-head" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyOutlined />
          <h3 className="settings-group-title">{t('cfg.api_keys_list')}</h3>
          <Tag style={{ margin: 0 }}>{t('cfg.api_keys_count', { n: totalKeysCount })}</Tag>
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
      {totalKeysCount > 0 && (
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
              onChange={(val) => setFilterStatus(val as 'all' | 'enabled' | 'disabled')}
              options={[
                { label: t('keys.filter_all', { n: dataSource.length }), value: 'all' },
                { label: t('keys.filter_enabled', { n: enabledCount }), value: 'enabled' },
                { label: t('keys.filter_disabled', { n: disabledCount }), value: 'disabled' },
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
      {totalKeysCount === 0 ? (
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
                        record.disabled
                          ? styles['status-pip-idle']
                          : isActive
                          ? styles['status-pip-active']
                          : styles['status-pip-idle']
                      }`}
                      title={record.disabled ? t('keys.status_disabled') : isActive ? t('keys.status_active') : t('keys.status_idle')}
                    />
                    {record.alias ? (
                      <div
                        className={styles['name-wrapper']}
                        onClick={() => openRename(record)}
                        title={t('keys.rename_title')}
                      >
                        <Text strong className={styles['name-text']}>
                          {record.alias}
                        </Text>
                        <EditOutlined className={styles['name-edit-icon']} />
                      </div>
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
              title: t('keys.col_status'),
              key: 'status',
              width: 140,
              render: (_: unknown, record: ApiKeyRecord) => (
                <Space size={8}>
                  <Switch
                    size="small"
                    checked={!record.disabled}
                    onChange={(checked) => onToggleDisable(record.key, !checked)}
                    aria-label={record.disabled ? t('keys.action_enable') : t('keys.action_disable')}
                  />
                  <Tag color={record.disabled ? 'default' : 'success'} style={{ margin: 0 }}>
                    {record.disabled ? t('keys.status_disabled') : t('keys.status_enabled')}
                  </Tag>
                </Space>
              ),
            },
            {
              title: t('keys.col_key'),
              key: 'key',
              render: (_: unknown, record: ApiKeyRecord) => (
                <div className="config-key-box">
                  <span className="config-key-text">
                    {revealedKeys[record.key] ? record.key : maskKeyText(record.key)}
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
                      revealedKeys[record.key]
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
                          [record.key]: !prev[record.key],
                        }))
                      }
                      aria-label={
                        revealedKeys[record.key]
                          ? t('common.hide_secret')
                          : t('common.reveal_secret')
                      }
                    >
                      {revealedKeys[record.key] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
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
                  <Tooltip title={t('keys.edit_key_value')}>
                    <button
                      type="button"
                      className="config-key-action"
                      disabled={record.disabled}
                      onClick={() => onEdit(record.index, record.key)}
                      aria-label={t('cfg.api_keys_edit')}
                    >
                      <EditOutlined />
                    </button>
                  </Tooltip>
                  <Popconfirm
                    title={t('cfg.api_keys_delete_confirm')}
                    onConfirm={() => handleDelete(record)}
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
                        record.disabled
                          ? styles['status-pip-idle']
                          : isActive
                          ? styles['status-pip-active']
                          : styles['status-pip-idle']
                      }`}
                      title={record.disabled ? t('keys.status_disabled') : isActive ? t('keys.status_active') : t('keys.status_idle')}
                    />
                    <div
                      className={styles['name-wrapper']}
                      onClick={() => openRename(record)}
                      title={t('keys.rename_title')}
                    >
                      <span className={styles['name-text']}>
                        {record.alias ? record.alias : t('keys.unnamed')}
                      </span>
                      <EditOutlined className={styles['name-edit-icon']} />
                    </div>
                  </div>
                  <Space size={8}>
                    <Switch
                      size="small"
                      checked={!record.disabled}
                      onChange={(checked) => onToggleDisable(record.key, !checked)}
                      aria-label={record.disabled ? t('keys.action_enable') : t('keys.action_disable')}
                    />
                    <Tag color={record.disabled ? 'default' : 'success'} style={{ margin: 0 }}>
                      {record.disabled ? t('keys.status_disabled') : t('keys.status_enabled')}
                    </Tag>
                  </Space>
                </div>

                <div className={styles['key-card-token-row']}>
                  <span className={styles['key-card-token-text']}>
                    {revealedKeys[record.key] ? record.key : maskKeyText(record.key)}
                  </span>
                  <Space size={4}>
                    <Button
                      size="small"
                      type="text"
                      icon={revealedKeys[record.key] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                      onClick={() =>
                        setRevealedKeys((prev) => ({
                          ...prev,
                          [record.key]: !prev[record.key],
                        }))
                      }
                      title={revealedKeys[record.key] ? t('common.hide_secret') : t('common.reveal_secret')}
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
                    icon={<TagOutlined />}
                    onClick={() => openRename(record)}
                  >
                    {t('keys.rename')}
                  </Button>
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
                    disabled={record.disabled}
                    onClick={() => onEdit(record.index, record.key)}
                  >
                    {t('keys.edit_key_value')}
                  </Button>
                  <Popconfirm
                    title={t('cfg.api_keys_delete_confirm')}
                    onConfirm={() => handleDelete(record)}
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

      {totalKeysCount > 0 && (
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
