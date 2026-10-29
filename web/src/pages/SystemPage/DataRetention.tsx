import React from 'react';
import { describeError } from '../../api/client';
import { useT } from '../../i18n';
import dayjs from '../../utils/time';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { formatRetentionDays, useDataRetention } from '../../hooks/useDataRetention';
import { Meter } from '../../components/common/Meter';
import { LoadFailure } from '../../components/feedback';
import styles from '../SystemPage.module.css';

export { DATA_RETENTION_QUERY_KEY } from '../../hooks/useDataRetention';

const DAY_MS = 86_400_000;

/**
 * DataRetention reports the request-record window as the share of it the stored records already
 * fill: a young database shows a short fill, and one that has reached its horizon a full track that
 * retention keeps trimming. The horizon itself is changed in the console settings.
 */
export const DataRetention: React.FC = () => {
  const t = useT();
  useTimeZone();
  const { data, error, refetch } = useDataRetention();
  // Whole days the stored records span, capped at the horizon retention holds them to.
  const filledDays = data?.oldest_request_record_ms
    ? Math.min(data.request_record_days, Math.ceil((Date.now() - data.oldest_request_record_ms) / DAY_MS))
    : null;

  return (
    <section className={styles['retention-section']} data-testid="sys-retention" aria-label={t('sys.retention_card')}>
      <div className={styles['retention-head']}>
        <span className={styles['retention-heading']}>{t('sys.retention_card')}</span>
        {data && (
          <span className={styles['retention-span']}>
            {data.request_record_days > 0 && filledDays !== null
              ? t('sys.retention_filled', { n: filledDays, days: data.request_record_days })
              : formatRetentionDays(data.request_record_days, t)}
          </span>
        )}
      </div>
      {error && !data && <LoadFailure title={t('sys.retention_load_failed')} detail={describeError(error)} onRetry={() => void refetch()} />}
      {data && (
        <>
          {/* A zero horizon keeps every record, so there is no window to fill. */}
          {data.request_record_days > 0 && (
            <Meter value={filledDays ?? 0} max={data.request_record_days} />
          )}

          <dl className={styles['retention-foot']}>
            <dt>{t('sys.retention_oldest')}</dt>
            <dd>{data.oldest_request_record_ms ? dayjs(data.oldest_request_record_ms).format('YYYY-MM-DD') : '—'}</dd>
          </dl>
        </>
      )}
    </section>
  );
};
