import React from 'react';
import {
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Popconfirm,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  MoreOutlined,
  PlusOutlined,
  SearchOutlined,
  TagOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';
import { copyText } from '../../utils/clipboard';
import type { ClientAPIKeyItem, ClientKeyUsageItem } from '../../types/providers';
import styles from './ApiKeysList.module.css';

const { Text } = Typography;

/** One rendered row: a key from the `api-keys` draft plus the identity and
 *  traffic Oh My CPA knows about it. A key has no state of its own to report —
 *  CPA accepts it by presence in that list (see ADR 0010). */
export interface ApiKeyRecord {
  id: string;
  /** Position in the `api-keys` array; the value edit writes back to this index. */
  index: number;
  key: string;
  usageFingerprint?: string;
  alias?: string;
  aliasVersion: number;
  usage?: ClientKeyUsageItem;
}

export interface ApiKeysListProps {
  /** The key list in the current draft. */
  apiKeys: string[];
  /** Local in-flight / draft aliases. */
  pendingAliases?: Record<string, string>;
  /** The stored keys and their aliases. */
  metadata?: ClientAPIKeyItem[];
  /** Keyed by usage fingerprint. */
  usage?: Record<string, ClientKeyUsageItem>;
  formatTime: (ms: number) => string;
  /** The page's search box, applied to the name and the key text. */
  searchQuery: string;
  onAdd: () => void;
  /** Opens the row's editor: one dialog for its name and its secret. */
  onEdit: (index: number) => void;
  onDelete: (record: ApiKeyRecord) => void;
  onViewRequests: (record: ApiKeyRecord) => void;
}

export const ApiKeysList: React.FC<ApiKeysListProps> = ({
  apiKeys,
  pendingAliases = {},
  metadata,
  usage,
  formatTime,
  searchQuery,
  onAdd,
  onEdit,
  onDelete,
  onViewRequests,
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();

  const [revealedKeys, setRevealedKeys] = React.useState<Record<string, boolean>>({});
  /** The row whose delete confirmation is open. It survives the dropdown closing
   *  on item click, which is why the confirmation is driven from state rather
   *  than from the menu item itself. */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);

  const metaByKey = React.useMemo(() => {
    const map = new Map<string, ClientAPIKeyItem>();
    for (const item of metadata ?? []) {
      map.set(item.key, item);
    }
    return map;
  }, [metadata]);

  const dataSource: ApiKeyRecord[] = React.useMemo(
    () =>
      apiKeys.map((key, index) => {
        const entry = metaByKey.get(key) ?? metadata?.[index];
        const isStored = entry !== undefined && entry.key === key;
        const usageFingerprint = isStored ? entry.usage_fingerprint : undefined;
        return {
          id: `${index}-${key}`,
          index,
          key,
          usageFingerprint,
          alias: pendingAliases[key] ?? (isStored ? entry.alias : undefined),
          aliasVersion: isStored ? entry.alias_version : 0,
          usage: usageFingerprint ? usage?.[usageFingerprint] : undefined,
        };
      }),
    [apiKeys, metaByKey, metadata, pendingAliases, usage],
  );

  const filteredData = React.useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return dataSource;
    return dataSource.filter(
      (record) =>
        (record.alias ?? '').toLowerCase().includes(query) ||
        record.key.toLowerCase().includes(query),
    );
  }, [dataSource, searchQuery]);

  const handleDelete = (record: ApiKeyRecord) => {
    onDelete(record);
    // Only this row's revealed state is dropped: clearing every row would hide a
    // secret the operator deliberately revealed on a row they did not touch.
    setRevealedKeys((prev) => {
      if (!(record.key in prev)) return prev;
      const next = { ...prev };
      delete next[record.key];
      return next;
    });
  };

  const handleCopy = async (keyText: string) => {
    if (await copyText(keyText)) {
      message.success(t('cfg.source_copy_success'));
      return;
    }
    message.error(t('cfg.copy_failed'));
  };

  /** The overflow menu holds what is not about the secret: following a key's
   *  traffic, and the one irreversible action. */
  const menuItems = (record: ApiKeyRecord): MenuProps['items'] => [
    {
      key: 'requests',
      icon: <SearchOutlined />,
      // Disabled rather than hidden, with the reason on the item: a key with no
      // stored traffic has no identity to filter by, and that absence is worth
      // seeing.
      disabled: !record.usageFingerprint,
      label: (
        <span
          className={styles['menu-label']}
          title={record.usageFingerprint ? undefined : t('keys.not_linked')}
        >
          {t('keys.view_requests')}
        </span>
      ),
      onClick: () => onViewRequests(record),
    },
    { type: 'divider' },
    {
      key: 'delete',
      danger: true,
      icon: <DeleteOutlined />,
      label: t('cfg.api_keys_delete'),
      onClick: () => setPendingDeleteId(record.id),
    },
  ];

  const renderActions = (record: ApiKeyRecord) => {
    const isRevealed = Boolean(revealedKeys[record.key]);
    const moreButton = (
      <button
        type="button"
        className="config-key-action"
        aria-label={`${t('keys.actions_more')}: ${record.alias ?? t('keys.unnamed')}`}
        aria-haspopup="menu"
      >
        <MoreOutlined />
      </button>
    );
    return (
      <div className="keys-row-actions">
        <Tooltip title={isRevealed ? t('common.hide_secret') : t('common.reveal_secret')}>
          <button
            type="button"
            className="config-key-action"
            onClick={() => setRevealedKeys((prev) => ({ ...prev, [record.key]: !prev[record.key] }))}
            aria-label={isRevealed ? t('common.hide_secret') : t('common.reveal_secret')}
          >
            {isRevealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
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
        {/* One editor for both of a key's editable parts: its name and its value. */}
        <Tooltip title={t('cfg.api_keys_edit')}>
          <button
            type="button"
            className="config-key-action"
            onClick={() => onEdit(record.index)}
            aria-label={`${t('cfg.api_keys_edit')}: ${record.alias ?? t('keys.unnamed')}`}
          >
            <EditOutlined />
          </button>
        </Tooltip>
        {pendingDeleteId === record.id ? (
          <Popconfirm
            open
            title={t('cfg.api_keys_delete_confirm')}
            description={t('keys.delete_confirm_desc')}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={() => {
              setPendingDeleteId(null);
              handleDelete(record);
            }}
            onCancel={() => setPendingDeleteId(null)}
            // The visibility is owned here, so the overlay's own dismissals - a click
            // outside it, Escape - have to be accepted rather than ignored, or the row
            // keeps a confirmation the operator cannot close.
            onOpenChange={(next) => {
              if (!next) setPendingDeleteId(null);
            }}
          >
            {moreButton}
          </Popconfirm>
        ) : (
          <Dropdown menu={{ items: menuItems(record) }} trigger={['click']} placement="bottomRight">
            {moreButton}
          </Dropdown>
        )}
      </div>
    );
  };

  if (apiKeys.length === 0) {
    return (
      <div className={styles['empty-box']}>
        <KeyOutlined className={styles['empty-icon']} />
        <div className={styles['empty-title']}>{t('keys.empty_title')}</div>
        <div className={styles['empty-desc']}>{t('keys.empty_desc')}</div>
        <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>
          {t('keys.empty_cta')}
        </Button>
      </div>
    );
  }

  return (
    <>
      {filteredData.length === 0 ? (
        <div className={styles['empty-box']}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('keys.search_empty')} />
        </div>
      ) : (
        /* The scroll wrapper and the table's own x-scroll are the list pages'
           convention: the same table serves every width, scrolling sideways
           rather than becoming a second layout. */
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <Table<ApiKeyRecord>
            className="config-api-keys-table"
            size="small"
            rowKey="id"
            dataSource={filteredData}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              {
                title: t('keys.col_name'),
                key: 'name',
                render: (_: unknown, record: ApiKeyRecord) => (
                  <div className={styles['name-cell']}>
                    {record.alias ? (
                      /* A real button, like the unnamed state beside it: the name cell is a
                         rename affordance, so it has to be reachable without a pointer.
                         antd's icon carries its own aria-label, which is why the name is
                         stated outright here instead of being assembled from the contents. */
                      <button
                        type="button"
                        className={styles['name-wrapper']}
                        onClick={() => onEdit(record.index)}
                        title={t('keys.rename_title')}
                        aria-label={`${t('cfg.api_keys_edit')}: ${record.alias}`}
                      >
                        <Text strong className={styles['name-text']}>
                          {record.alias}
                        </Text>
                        <EditOutlined className={styles['name-edit-icon']} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onEdit(record.index)}
                        className={styles['unnamed-btn']}
                        title={t('keys.rename_title')}
                      >
                        <TagOutlined /> {t('keys.unnamed')}
                      </button>
                    )}
                  </div>
                ),
              },
              {
                title: t('keys.col_key'),
                key: 'key',
                width: 420,
                render: (_: unknown, record: ApiKeyRecord) => {
                  const isRevealed = Boolean(revealedKeys[record.key]);
                  return (
                    <div className="config-key-box">
                      {/* Mask and secret are the same shape, and the box that holds
                          them has a fixed width, so revealing moves nothing. */}
                      <span
                        className={`config-key-text${isRevealed ? ' is-revealed' : ' is-masked'}`}
                      >
                        {isRevealed ? record.key : maskKeyText(record.key)}
                      </span>
                    </div>
                  );
                },
              },
              {
                title: t('keys.col_requests'),
                key: 'requests',
                width: 110,
                align: 'right' as const,
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
                width: 170,
                align: 'right' as const,
                render: (_: unknown, record: ApiKeyRecord) =>
                  record.usage && record.usage.last_used_ms > 0 ? (
                    <time dateTime={new Date(record.usage.last_used_ms).toISOString()}>
                      <Text type="secondary" className="mono-num">
                        {formatTime(record.usage.last_used_ms)}
                      </Text>
                    </time>
                  ) : (
                    <Text type="secondary">—</Text>
                  ),
              },
              {
                title: t('keys.col_actions'),
                key: 'actions',
                width: 190,
                align: 'right' as const,
                render: (_: unknown, record: ApiKeyRecord) => renderActions(record),
              },
            ]}
          />
        </div>
      )}

      <p className={styles['scope-note']}>
        {t('keys.usage_scope', { range: t('keys.usage_range') })}
      </p>
    </>
  );
};