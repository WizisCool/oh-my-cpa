import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Button, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  HistoryOutlined,
  KeyOutlined,
} from '../icons';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';
import { copyText } from '../../utils/clipboard';
import { formatTimeAgo } from '../../utils/format';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { ResponsiveList } from '../common/ResponsiveList';
import { ConfirmAction } from '../common/ConfirmAction';
import { useToast } from '../feedback';
import type { ApiKeyRecord } from './keyOverview';
import styles from './ApiKeysList.module.css';
import './keys.css';

export type { ApiKeyRecord } from './keyOverview';

export interface ApiKeysListProps {
  /** The rows the page's filters leave, in the order of CPA's configuration document. */
  records: readonly ApiKeyRecord[];
  isLoading: boolean;
  /** True when the read failed with nothing cached, so the page's alert is the one statement. */
  isBlocked?: boolean;
  /** The empty copy: no key configured, or none matching the filters. */
  emptyText: React.ReactNode;
  formatTime: (ms: number) => string;
  /** True while a write is in flight: the row actions that write wait for it. */
  isBusy?: boolean;
  /** The demonstration refuses every write, so the controls that write say so. */
  isReadOnly?: boolean;
  /** Opens the row's editor: one panel for its name and its secret. */
  onEdit: (index: number) => void;
  onDelete: (record: ApiKeyRecord) => void;
  onViewRequests: (record: ApiKeyRecord) => void;
}

/**
 * The key list: one row per gateway client key, drawn with the provider list's parts - an identity
 * tile, the facts a reader compares across rows, and quiet row actions - so the two Gateway lists
 * read alike. Below 640px it renders labelled rows from the same columns (ADR 0012).
 */
export const ApiKeysList: React.FC<ApiKeysListProps> = ({
  records,
  isLoading,
  isBlocked,
  emptyText,
  formatTime,
  isBusy = false,
  isReadOnly = false,
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

  const nameOf = (record: ApiKeyRecord) => record.alias ?? t('keys.unnamed');

  const nameCell = (record: ApiKeyRecord) => (
    <div className={styles['identity']}>
      <span className={styles['mark']} aria-hidden="true">
        <KeyOutlined />
      </span>
      {record.alias ? (
        <span className={styles['name']}>{record.alias}</span>
      ) : (
        <span className={styles['unnamed']}>{t('keys.unnamed')}</span>
      )}
    </div>
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

  // The provider list's three glyphs, in its order: look, edit, remove. Looking at a key is
  // following its traffic, which needs the fingerprint stored traffic carries; without one the
  // action is disabled and says why, because that absence is worth seeing.
  const renderActions = (record: ApiKeyRecord) => (
    <div className="row-actions">
      <Tooltip title={record.usageFingerprint ? t('keys.view_requests') : t('keys.not_linked')}>
        <Button
          size="small"
          className="row-action-btn"
          icon={<HistoryOutlined />}
          disabled={!record.usageFingerprint}
          onClick={() => onViewRequests(record)}
          aria-label={`${t('keys.view_requests')}: ${nameOf(record)}`}
        />
      </Tooltip>
      <Tooltip title={isReadOnly ? t('demo.blocked') : t('cfg.api_keys_edit')}>
        <Button
          size="small"
          className="row-action-btn"
          icon={<EditOutlined />}
          disabled={isReadOnly}
          onClick={() => onEdit(record.index)}
          aria-label={`${t('cfg.api_keys_edit')}: ${nameOf(record)}`}
        />
      </Tooltip>
      <ConfirmAction
        title={t('cfg.api_keys_delete_confirm')}
        description={t('keys.delete_confirm_desc')}
        confirmLabel={t('cfg.api_keys_delete')}
        isDanger
        disabled={isReadOnly || isBusy}
        onConfirm={() => handleDelete(record)}
        tooltip={isReadOnly ? t('demo.blocked') : t('cfg.api_keys_delete')}
      >
        <Button
          size="small"
          danger
          className="row-action-btn"
          icon={<DeleteOutlined />}
          disabled={isReadOnly || isBusy}
          aria-label={`${t('cfg.api_keys_delete')}: ${nameOf(record)}`}
        />
      </ConfirmAction>
    </div>
  );

  // The list's columns are the one description of what a key shows: the table renders them, and
  // the phone row derives its fields from the same array.
  const columns: ColumnsType<ApiKeyRecord> = [
    {
      title: t('keys.col_name'),
      key: 'name',
      minWidth: 200,
      render: (_: unknown, record: ApiKeyRecord) => nameCell(record),
    },
    {
      title: t('keys.col_key'),
      key: 'key',
      width: 380,
      render: (_: unknown, record: ApiKeyRecord) => keyCell(record),
    },
    {
      title: t('keys.col_requests_window'),
      key: 'requests',
      width: 160,
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
      width: 120,
      align: 'right' as const,
      render: (_: unknown, record: ApiKeyRecord) => renderActions(record),
    },
  ];

  return (
    <div className={styles['key-list']}>
      <ResponsiveList<ApiKeyRecord>
        columns={columns}
        dataSource={records}
        rowKey="id"
        isLoading={isLoading}
        isBlocked={isBlocked}
        emptyText={emptyText}
        phone={{ identity: 'name', actions: ['actions'] }}
        tableProps={{ className: 'config-api-keys-table', scroll: { x: 'max-content' } }}
      />
    </div>
  );
};
