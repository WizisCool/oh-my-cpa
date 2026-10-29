import React from 'react';
import { useT } from '../../i18n';
import type { SystemDatabaseInfo } from '../../types/system';
import { formatBytes } from '../../utils/format';
import styles from '../SystemPage.module.css';

/**
 * StorageFootprint states how large the database is and what that size is made of: one total, and
 * one bar that splits it between the main file and the write-ahead log. The shared-memory index is
 * a fixed few kilobytes that no operator acts on, so it counts toward the total without a reading
 * of its own.
 */
export const StorageFootprint: React.FC<{ database: SystemDatabaseInfo }> = ({ database }) => {
  const t = useT();
  const { files } = database;
  const parts = [
    { key: 'main', label: t('sys.storage_main'), exists: files.main_exists, bytes: files.main_bytes },
    { key: 'wal', label: t('sys.storage_wal'), exists: files.wal_exists, bytes: files.wal_bytes },
  ] as const;

  return (
    <div className={styles['storage-footprint']}>
      <div className={styles['storage-headline']}>
        <div className={styles['storage-total']}>
          <span className={styles['storage-total-label']}>{t('sys.storage_total')}</span>
          <span className={styles['storage-total-num']}>{formatBytes(files.total_bytes)}</span>
        </div>
        <span className={styles['storage-schema']}>
          {t('sys.schema_version')} v{database.schema_version}
        </span>
      </div>

      {/* The legend below states every size in text, so the bar is drawn for the eye alone. */}
      <div className={styles['storage-bar']} aria-hidden="true">
        {parts.map((part) => part.bytes > 0 && (
          <span
            key={part.key}
            className={`${styles['storage-bar-segment']} ${styles[`part-${part.key}`]}`}
            style={{ flexGrow: part.bytes }}
          />
        ))}
      </div>

      <dl className={styles['storage-legend']}>
        {parts.map((part) => (
          <div key={part.key} className={styles['storage-legend-item']} data-testid="sys-storage-file-row">
            <dt>
              <span className={`${styles['storage-swatch']} ${styles[`part-${part.key}`]}`} aria-hidden="true" />
              {part.label}
            </dt>
            <dd>{part.exists ? formatBytes(part.bytes) : t('sys.file_not_exist')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};
