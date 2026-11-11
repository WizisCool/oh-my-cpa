import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Button } from '@/components/ui/button';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, HistoryOutlined, KeyOutlined } from '../icons';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';
import { formatTimeAgo } from '../../utils/format';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { ResponsiveList } from '../common/ResponsiveList';
import { ConfirmAction } from '../common/ConfirmAction';
import { CopyButton } from '../common/CopyButton';
import { StatusLabel } from '../common/StatusLabel';
import { TrafficCell } from '../common/TrafficCell';
import { Meter } from '../common/Meter';
import { Count } from '../common/Count';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { Tooltip } from '../common/Tooltip';
import { successRateTone } from '../../types/usageEventMetrics';
import clsx from 'clsx';
import type { ApiKeyRecord } from './keyOverview';
import styles from './ApiKeysList.module.css';

export type { ApiKeyRecord } from './keyOverview';

export interface ApiKeysListProps {
  /** The rows the page's filters leave, in the order of CPA's configuration document. */
  records: readonly ApiKeyRecord[];
  isLoading: boolean;
  /** True when the read failed with nothing cached, so the page's alert is the one statement. */
  isBlocked?: boolean;
  /** False until the window's traffic has been read, so no row claims to be idle before it is known. */
  isUsageKnown: boolean;
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
 * The key list: one row per gateway client key, laid out as the other Gateway lists are - the
 * identity first, then the state and the window's traffic a reader compares down the column, then
 * the row's actions. A key reads like an OAuth credential: its name is the headline, the masked
 * secret sits under it and reveals on click, and a key with no name is headed by the mask itself.
 */
export const ApiKeysList: React.FC<ApiKeysListProps> = ({
  records,
  isLoading,
  isBlocked,
  isUsageKnown,
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
  const { style: tokenStyle } = useTokenDisplayStyle();
  const nowMS = useVisibleNow();
  const isPhone = useIsPhoneViewport();

  const nameOf = (record: ApiKeyRecord) => record.alias ?? maskKeyText(record.key);

  const [revealedIDs, setRevealedIDs] = React.useState<ReadonlySet<string>>(() => new Set());
  // A deleted row's reveal goes with it: before the names load, rows are keyed by position, so a
  // kept id would reveal the key that moves into the deleted one's place.
  const deleteRecord = (record: ApiKeyRecord) => {
    onDelete(record);
    setRevealedIDs((prev) => {
      if (!prev.has(record.id)) return prev;
      const next = new Set(prev);
      next.delete(record.id);
      return next;
    });
  };
  const toggleRevealed = (id: string) => setRevealedIDs((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  /**
   * The mask - or the secret once revealed - with the two glyphs that act on it always beside it:
   * reading a key and handing it to a client are what this page is opened for most.
   */
  const secret = (record: ApiKeyRecord, className: string) => {
    const isRevealed = revealedIDs.has(record.id);
    const toggleLabel = isRevealed ? t('common.hide_secret') : t('common.reveal_secret');
    return (
      <span className={styles['secret-line']}>
        <span className={className}>{isRevealed ? record.key : maskKeyText(record.key)}</span>
        <Tooltip title={toggleLabel}>
          <Button
            variant="ghost"
            size="sm"
            className={styles['secret-action']}
            icon={isRevealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            aria-label={`${toggleLabel}: ${nameOf(record)}`}
            aria-pressed={isRevealed}
            onClick={() => toggleRevealed(record.id)}
          />
        </Tooltip>
        <CopyButton className={styles['secret-action']} text={record.key} label={t('cfg.api_keys_copy')} />
      </span>
    );
  };

  const nameCell = (record: ApiKeyRecord) => (
    <div className={styles['identity']}>
      {record.alias ? (
        <>
          <span className={styles['name']}>{record.alias}</span>
          {secret(record, styles['secret'])}
        </>
      ) : (
        secret(record, styles['secret-headline'])
      )}
    </div>
  );

  const statusCell = (record: ApiKeyRecord) => {
    if (!isUsageKnown) return <span className={styles['muted']}>—</span>;
    return (record.usage?.requests ?? 0) > 0
      ? <StatusLabel tone="success">{t('keys.status_active')}</StatusLabel>
      : <StatusLabel tone="neutral">{t('keys.stat_idle')}</StatusLabel>;
  };

  // A key with no stored request has nothing to join yet: in the window it served nothing.
  const trafficOf = (record: ApiKeyRecord) => {
    if (!isUsageKnown) return undefined;
    const requests = record.usage?.requests ?? 0;
    const failed = record.usage?.failed ?? 0;
    return { total: requests, successRate: requests > 0 ? ((requests - failed) / requests) * 100 : null };
  };

  const trafficCell = (record: ApiKeyRecord) => <TrafficCell traffic={trafficOf(record)} />;

  const tokensCell = (record: ApiKeyRecord) => {
    // A dash is unknown usage; a key the window saw nothing from used zero tokens, as its
    // traffic says "no requests" rather than a dash.
    if (!isUsageKnown) return <span className={styles['muted']}>—</span>;
    return <span className={styles['figure']}>{formatTokens(record.usage?.total_tokens ?? 0, tokenStyle)}</span>;
  };

  const lastUsedCell = (record: ApiKeyRecord) => {
    const lastUsed = record.usage?.last_used_ms ?? 0;
    if (lastUsed <= 0) return <span className={styles['muted']}>—</span>;
    return (
      <Tooltip title={formatTime(lastUsed)}>
        <time className={styles['figure']} dateTime={new Date(lastUsed).toISOString()}>
          {formatTimeAgo(lastUsed, nowMS, t)}
        </time>
      </Tooltip>
    );
  };

  // Three glyphs, in the provider list's order with a look in front: look, edit, remove. Looking at a key is
  // following its traffic, which needs the fingerprint stored traffic carries; without one the
  // action is disabled and says why, because that absence is worth seeing.
  const renderActions = (record: ApiKeyRecord) => (
    <div className="row-actions">
      <Tooltip title={record.usageFingerprint ? t('keys.view_requests') : t('keys.not_linked')}>
        <Button
          size="sm"
          className="row-action-btn"
          icon={<HistoryOutlined />}
          disabled={!record.usageFingerprint}
          onClick={() => onViewRequests(record)}
          aria-label={`${t('keys.view_requests')}: ${nameOf(record)}`}
        />
      </Tooltip>
      <Tooltip title={isReadOnly ? t('demo.blocked') : t('cfg.api_keys_edit')}>
        <Button
          size="sm"
          className="row-action-btn"
          icon={<EditOutlined />}
          disabled={isReadOnly}
          onClick={() => onEdit(record.index)}
          aria-label={`${t('cfg.api_keys_edit')}: ${nameOf(record)}`}
        />
      </Tooltip>
      <ConfirmAction
        title={t('cfg.api_keys_delete_confirm')}
        description={(
          <>
            <span className={styles['confirm-target']}>{nameOf(record)}</span>
            {t('keys.delete_confirm_desc')}
          </>
        )}
        confirmLabel={t('cfg.api_keys_delete')}
        isDanger
        disabled={isReadOnly || isBusy}
        onConfirm={() => deleteRecord(record)}
        tooltip={isReadOnly ? t('demo.blocked') : t('cfg.api_keys_delete')}
      >
        <Button
          size="sm"
          danger
          className="row-action-btn"
          icon={<DeleteOutlined />}
          disabled={isReadOnly || isBusy}
          aria-label={`${t('cfg.api_keys_delete')}: ${nameOf(record)}`}
        />
      </ConfirmAction>
    </div>
  );

  /*
   * A key on a phone, drawn as an OAuth credential row is: the name with the row's actions beside
   * it, the secret and the state under the name, then the window's traffic as one reading across
   * the card - the count and rate over a bar, the tokens and the last use under it.
   */
  const renderPhoneCard = (record: ApiKeyRecord) => {
    const traffic = trafficOf(record);
    const tone = successRateTone(traffic?.successRate);
    const tokens = record.usage?.total_tokens ?? 0;
    const lastUsed = record.usage?.last_used_ms ?? 0;
    return (
      <article className={styles['phone-card']} data-testid="phone-row" aria-label={nameOf(record)}>
        <div className={styles['phone-card-head']}>
          {nameCell(record)}
          {renderActions(record)}
        </div>
        <div className={styles['phone-card-state']}>{statusCell(record)}</div>
        {traffic && (
          <div className={styles['reading']}>
            <span className={styles['reading-name']}>{t('pro.window_24h')}</span>
            {traffic.total === 0 ? (
              <span className={styles['reading-value']}>{t('pro.traffic_none')}</span>
            ) : (
              <>
                <span className={styles['reading-value']}>
                  {t('pro.traffic_requests', { n: traffic.total.toLocaleString() })}
                  <b className={styles[`tone-${tone}`]}>{`${(traffic.successRate ?? 0).toFixed(1)}%`}</b>
                </span>
                <Meter
                  className={styles['reading-bar']}
                  value={traffic.successRate ?? 0}
                  color={`var(--${tone === 'neutral' ? 'meta' : tone})`}
                />
                <span className={styles['reading-foot']}>
                  {tokens > 0 ? t('keys.usage_tokens', { n: formatTokens(tokens, tokenStyle) }) : ''}
                </span>
                <span className={clsx(styles['reading-foot'], styles['reading-foot-end'])}>
                  {lastUsed > 0 && <>{t('keys.col_last_used')} {lastUsedCell(record)}</>}
                </span>
              </>
            )}
          </div>
        )}
      </article>
    );
  };

  // The list's columns are the one description of what a key shows on a wide screen; the phone
  // card reuses the same cells.
  const columns: ColumnsType<ApiKeyRecord> = [
    {
      title: t('keys.col_name'),
      key: 'name',
      minWidth: 260,
      render: (_: unknown, record: ApiKeyRecord) => nameCell(record),
    },
    {
      title: t('pro.col_status'),
      key: 'status',
      width: 112,
      render: (_: unknown, record: ApiKeyRecord) => statusCell(record),
    },
    {
      title: t('pro.col_traffic'),
      key: 'traffic',
      width: 168,
      render: (_: unknown, record: ApiKeyRecord) => trafficCell(record),
    },
    {
      title: t('keys.col_tokens_window'),
      key: 'tokens',
      width: 120,
      align: 'right' as const,
      render: (_: unknown, record: ApiKeyRecord) => tokensCell(record),
    },
    {
      title: t('keys.col_last_used'),
      key: 'lastUsed',
      width: 128,
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
    <div className={clsx(styles['key-list'], isPhone && records.length > 0 && styles['is-grouped'])}>
      {/* On a phone the keys are one group under a header strip, as an OAuth provider's credentials are. */}
      {isPhone && records.length > 0 && (
        <div className={styles['phone-group-head']}>
          <KeyOutlined />
          <span className={styles['phone-group-title']}>{t('keys.stat_all')}</span>
          <Count>{records.length}</Count>
        </div>
      )}
      <ResponsiveList<ApiKeyRecord>
        columns={columns}
        dataSource={records}
        rowKey="id"
        isLoading={isLoading}
        isBlocked={isBlocked}
        emptyText={emptyText}
        isFilterAnimated
        phone={{ render: renderPhoneCard }}
        tableProps={{ scroll: { x: 'max-content' } }}
      />
    </div>
  );
};
