import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import {
  Button,
  Dropdown,
  Empty,
  Popconfirm,
  Table,
  Tooltip,
} from 'antd';
import type { MenuProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
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
} from '../icons';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';
import { copyText } from '../../utils/clipboard';
import { formatTimeAgo } from '../../utils/format';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import type { ClientAPIKeyItem, ClientKeyUsageItem } from '../../types/providers';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { PhoneRow } from '../common/PhoneRow';
import { phoneRowFields } from '../common/phoneRowFields';
import styles from './ApiKeysList.module.css';
import { useToast } from '../feedback';

/** One rendered row: a key from CPA's client-key list plus the identity and
 *  traffic Oh My CPA knows about it. A key has no state of its own to report —
 *  CPA accepts it by presence in that list (see ADR 0010). */
export interface ApiKeyRecord {
  id: string;
  /** Position in the client-key array; an edit writes back to this index. */
  index: number;
  key: string;
  usageFingerprint?: string;
  alias?: string;
  aliasVersion: number;
  usage?: ClientKeyUsageItem;
}

export interface ApiKeysListProps {
  /** The keys CPA holds, in the order of its configuration document. */
  apiKeys: string[];
  /** The stored keys and their aliases. */
  metadata?: ClientAPIKeyItem[];
  /** Keyed by usage fingerprint. */
  usage?: Record<string, ClientKeyUsageItem>;
  formatTime: (ms: number) => string;
  /** The list's search box, applied to the name and the key text. */
  searchQuery: string;
  /** True while a write is in flight: the row actions that write wait for it. */
  isBusy?: boolean;
  /** The demonstration refuses every write, so the controls that write say so. */
  isReadOnly?: boolean;
  onAdd: () => void;
  /** Opens the row's editor: one dialog for its name and its secret. */
  onEdit: (index: number) => void;
  onDelete: (record: ApiKeyRecord) => void;
  onViewRequests: (record: ApiKeyRecord) => void;
}

export const ApiKeysList: React.FC<ApiKeysListProps> = ({
  apiKeys,
  metadata,
  usage,
  formatTime,
  searchQuery,
  isBusy = false,
  isReadOnly = false,
  onAdd,
  onEdit,
  onDelete,
  onViewRequests,
}) => {
  useTimeZone();
  const t = useT();
  const toast = useToast();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const nowMS = useVisibleNow();

  const [revealedKeys, setRevealedKeys] = React.useState<Record<string, boolean>>({});
  /** The row whose delete confirmation is open. It survives the dropdown closing
   *  on item click, which is why the confirmation is driven from state rather
   *  than from the menu item itself. */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);

  const metaByKey = React.useMemo(() => {
    const map = new Map<string, ClientAPIKeyItem>();
    for (const item of metadata ?? []) map.set(item.key, item);
    return map;
  }, [metadata]);

  const dataSource: ApiKeyRecord[] = React.useMemo(
    () =>
      apiKeys.map((key, index) => {
        const entry = metaByKey.get(key);
        const usageFingerprint = entry?.usage_fingerprint;
        return {
          id: usageFingerprint ? `key-${usageFingerprint}` : `key-${index}`,
          index,
          key,
          usageFingerprint,
          alias: entry?.alias || undefined,
          aliasVersion: entry?.alias_version ?? 0,
          usage: usageFingerprint ? usage?.[usageFingerprint] : undefined,
        };
      }),
    [apiKeys, metaByKey, usage],
  );

  const isPhone = useIsPhoneViewport();

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
      if (!(record.id in prev)) return prev;
      const next = { ...prev };
      delete next[record.id];
      return next;
    });
  };

  const handleCopy = async (keyText: string) => {
    if (await copyText(keyText)) {
      toast.success(t('cfg.source_copy_success'));
      return;
    }
    toast.error(t('cfg.copy_failed'));
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
        <span title={record.usageFingerprint ? undefined : t('keys.not_linked')}>
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
      disabled: isReadOnly || isBusy,
      label: t('cfg.api_keys_delete'),
      onClick: () => setPendingDeleteId(record.id),
    },
  ];

  /**
   * The name cell, which is also the rename affordance.
   *
   * One function for both renderings: the table's cell and the phone row's headline are the same
   * control, and a rename that works in one place and not the other is the divergence a second
   * copy would produce eventually.
   */
  const nameCell = (record: ApiKeyRecord) => (
    <button
      type="button"
      className={styles['name-button']}
      onClick={() => onEdit(record.index)}
      disabled={isReadOnly}
      title={t('keys.rename_title')}
      // Named for what it does rather than "Edit", which is the row action's name: two
      // controls in one row must not be indistinguishable to a screen reader.
      aria-label={`${t('keys.rename_title')}: ${record.alias ?? t('keys.unnamed')}`}
    >
      <span className={styles['name-mark']} aria-hidden="true">
        <KeyOutlined />
      </span>
      {record.alias ? (
        <span className={styles['name-text']}>{record.alias}</span>
      ) : (
        <span className={styles['name-unnamed']}>{t('keys.unnamed')}</span>
      )}
      <EditOutlined className={styles['name-edit-icon']} />
    </button>
  );

  /**
   * The mask - or the secret once revealed - with the two actions that touch the secret beside it.
   *
   * The text box is a fixed width and the two states are the same shape, so revealing moves
   * nothing: not the column, not the controls beside it, not the row on a phone.
   */
  const keyCell = (record: ApiKeyRecord) => {
    const isRevealed = Boolean(revealedKeys[record.id]);
    return (
      <div className="config-key-field">
        <div className="config-key-box">
          <span className={`config-key-text${isRevealed ? ' is-revealed' : ' is-masked'}`}>
            {isRevealed ? record.key : maskKeyText(record.key)}
          </span>
        </div>
        <Tooltip title={isRevealed ? t('common.hide_secret') : t('common.reveal_secret')}>
          <button
            type="button"
            className="config-key-action is-quiet"
            onClick={() => setRevealedKeys((prev) => ({ ...prev, [record.id]: !prev[record.id] }))}
            aria-label={isRevealed ? t('common.hide_secret') : t('common.reveal_secret')}
            aria-pressed={isRevealed}
          >
            {isRevealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          </button>
        </Tooltip>
        <Tooltip title={t('cfg.api_keys_copy')}>
          <button
            type="button"
            className="config-key-action is-quiet"
            onClick={() => void handleCopy(record.key)}
            aria-label={t('cfg.api_keys_copy')}
          >
            <CopyOutlined />
          </button>
        </Tooltip>
      </div>
    );
  };

  const usageCell = (record: ApiKeyRecord) => {
    if (!record.usage) {
      return (
        <Tooltip title={t('keys.not_linked')}>
          <span className={styles['muted']}>—</span>
        </Tooltip>
      );
    }
    const { requests, failed, total_tokens: tokens } = record.usage;
    return (
      <div className={styles['usage']}>
        <span className={styles['usage-requests']}>{requests.toLocaleString()}</span>
        <span className={styles['usage-detail']}>
          {t('keys.usage_tokens', { n: formatTokens(tokens, tokenStyle) })}
          {failed > 0 && (
            <span className={styles['usage-failed']}>{t('keys.usage_failed', { n: failed.toLocaleString() })}</span>
          )}
        </span>
      </div>
    );
  };

  const lastUsedCell = (record: ApiKeyRecord) => {
    const lastUsed = record.usage?.last_used_ms ?? 0;
    if (lastUsed <= 0) return <span className={styles['muted']}>—</span>;
    return (
      <Tooltip title={formatTime(lastUsed)}>
        <time className={styles['last-used']} dateTime={new Date(lastUsed).toISOString()}>
          {formatTimeAgo(lastUsed, nowMS, t)}
        </time>
      </Tooltip>
    );
  };

  const renderActions = (record: ApiKeyRecord) => {
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
        {/* One editor for both of a key's editable parts: its name and its value. */}
        <Tooltip title={isReadOnly ? t('demo.blocked') : t('cfg.api_keys_edit')}>
          <button
            type="button"
            className="config-key-action"
            onClick={() => onEdit(record.index)}
            disabled={isReadOnly}
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
            okText={t('cfg.api_keys_delete')}
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

  /**
   * The list's columns: the one description of what a key shows.
   *
   * The table renders them, and `phoneRowFields` derives the phone row's fields from the same
   * array - so a column added here reaches both renderings, and a column's label and value
   * cannot differ between them. Built per render: it closes over the reveal map and callbacks
   * above, which change every render, so a memo would never hit.
   */
  const columns: ColumnsType<ApiKeyRecord> = [
    {
      title: t('keys.col_name'),
      key: 'name',
      render: (_: unknown, record: ApiKeyRecord) => nameCell(record),
    },
    {
      title: t('keys.col_key'),
      key: 'key',
      width: 400,
      render: (_: unknown, record: ApiKeyRecord) => keyCell(record),
    },
    {
      title: t('keys.col_requests_window'),
      key: 'requests',
      width: 150,
      align: 'right' as const,
      render: (_: unknown, record: ApiKeyRecord) => usageCell(record),
    },
    {
      title: t('keys.col_last_used'),
      key: 'lastUsed',
      width: 130,
      align: 'right' as const,
      render: (_: unknown, record: ApiKeyRecord) => lastUsedCell(record),
    },
    {
      title: t('keys.col_actions'),
      key: 'actions',
      width: 104,
      align: 'right' as const,
      render: (_: unknown, record: ApiKeyRecord) => renderActions(record),
    },
  ];

  if (apiKeys.length === 0) {
    return (
      <div className={styles['empty-box']}>
        <span className={styles['empty-mark']} aria-hidden="true">
          <KeyOutlined />
        </span>
        <div className={styles['empty-title']}>{t('keys.empty_title')}</div>
        <div className={styles['empty-desc']}>{t('keys.empty_desc')}</div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={onAdd}
          disabled={isReadOnly}
          title={isReadOnly ? t('demo.blocked') : undefined}
        >
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
      ) : isPhone ? (
        /* One record per block below 640px. The fields are derived from `columns` rather than
           restated, so the row prints what the table would have printed - in the table's own
           order, with the table's own labels. The name and the key are drawn as the headline
           and the summary, which is why they are skipped as fields. */
        <div>
          {filteredData.map((record, index) => (
            <PhoneRow
              key={record.id}
              identity={nameCell(record)}
              summary={keyCell(record)}
              fields={phoneRowFields(columns, record, { skip: ['name', 'key', 'actions'], index })}
              actions={renderActions(record)}
            />
          ))}
        </div>
      ) : (
        /* Sideways scrolling stays inside the card, so the page's content column stays where the
           reader left it. The card is the list's frame, so the table draws none of its own. */
        <div className="table-scroll data-table data-table-flush">
          <Table<ApiKeyRecord>
            className="config-api-keys-table"
            size="small"
            rowKey="id"
            dataSource={filteredData}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={columns}
          />
        </div>
      )}
    </>
  );
};
