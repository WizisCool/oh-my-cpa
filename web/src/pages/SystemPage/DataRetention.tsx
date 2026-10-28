import React from 'react';
import { describeError } from '../../api/client';
import { useT } from '../../i18n';
import dayjs from '../../utils/time';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { formatBytes, formatTimeAgo } from '../../utils/format';
import { formatRetentionDays, useDataRetention } from '../../hooks/useDataRetention';
import { FactList } from '../../components/common/FactList';
import { LoadFailure, Notice } from '../../components/feedback';
import styles from '../SystemPage.module.css';

export { DATA_RETENTION_QUERY_KEY } from '../../hooks/useDataRetention';

/**
 * DataRetention reports what retention has done to this database: the horizons in force, what has
 * been removed, when the next pass runs and whether removing rows gave the space back. It sits in
 * the storage card, under the footprint it explains; the horizons themselves are changed in the
 * console settings.
 */
export const DataRetention: React.FC = () => {
  const t = useT();
  useTimeZone();
  const { data, error, refetch } = useDataRetention();
  const now = Date.now();
  const deletedRows = data?.policies.reduce((total, policy) => total + policy.deleted_rows, 0) ?? 0;

  return (
    <section className={styles['retention-section']} data-testid="sys-retention" aria-label={t('sys.retention_card')}>
      <div className={styles['retention-heading']}>{t('sys.retention_card')}</div>
      {error && !data && <LoadFailure title={t('sys.retention_load_failed')} detail={describeError(error)} onRetry={() => void refetch()} />}
      {data && (
        <>
          <FactList
            className={styles['component-facts']}
            emphasis="quiet"
            testId="sys-retention-facts"
            facts={[
              { key: 'records', label: t('omc.retention_records'), value: formatRetentionDays(data.request_record_days, t) },
              { key: 'source', label: t('sys.retention_source'), value: t(data.source === 'console' ? 'sys.retention_source_console' : 'sys.retention_source_environment') },
              { key: 'oldest', label: t('sys.retention_oldest'), value: data.oldest_request_record_ms ? dayjs(data.oldest_request_record_ms).format('YYYY-MM-DD') : '—' },
              { key: 'deleted', label: t('sys.retention_deleted'), value: deletedRows.toLocaleString() },
              { key: 'last', label: t('sys.retention_last_pass'), value: data.last_pass_at_ms ? formatTimeAgo(data.last_pass_at_ms, now, t) : '—' },
              ...(data.scheduled && data.next_pass_at_ms
                ? [{ key: 'next', label: t('sys.retention_next_pass'), value: dayjs(data.next_pass_at_ms).format('HH:mm') }]
                : []),
              {
                key: 'space',
                label: t('sys.retention_space'),
                value: data.storage.auto_vacuum === 'none' ? t('sys.retention_space_rebuild') : t('sys.retention_space_auto'),
              },
            ]}
          />

          {/* A file that predates incremental mode keeps what retention frees until it is rebuilt
              once; saying how much is held is what makes the rebuild in the next card worth running. */}
          {data.storage.auto_vacuum === 'none' && data.storage.free_page_bytes > 0 && (
            <Notice
              tone="info"
              className={styles['maintenance-outcome-alert']}
              description={t('sys.retention_space_held', { size: formatBytes(data.storage.free_page_bytes) })}
            />
          )}
        </>
      )}
    </section>
  );
};
