import React from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { CheckCircleOutlined, CloseCircleOutlined, CloseOutlined, WarningOutlined } from '../../components/icons';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { MaintenanceIncompleteReason, SystemMaintenanceStatus } from '../../types/system';
import { formatBytes } from '../../utils/format';
import styles from '../SystemPage.module.css';

export const INCOMPLETE_REASON_KEYS: Record<MaintenanceIncompleteReason, MessageKey> = {
  reader_blocked: 'sys.maintenance_reason_reader_blocked',
  log_not_truncated: 'sys.maintenance_reason_log_not_truncated',
};

/**
 * A maintenance job as a result row of the card it was run from, not as a callout: the verdict on
 * one line, the measurements under it as label/value readings, and the reason a partial result is
 * partial in the warning ink. A job's result is a reading like the footprint above it, so it is set
 * the way readings are, and the card does not stack banners inside a box.
 */
export const MaintenanceOutcome: React.FC<{
  job: SystemMaintenanceStatus;
  actionLabel: string;
  onDismiss: () => void;
}> = ({ job, actionLabel, onDismiss }) => {
  const t = useT();
  const tone = job.error ? 'danger' : job.incomplete ? 'warn' : 'success';
  const icon = job.error ? <CloseCircleOutlined /> : job.incomplete ? <WarningOutlined /> : <CheckCircleOutlined />;
  const title = job.error
    ? t('sys.maintenance_failed_title', { action: actionLabel })
    : job.incomplete
      ? t('sys.maintenance_incomplete_title', { action: actionLabel })
      : t('sys.maintenance_success', { action: actionLabel });
  const reason = job.error || (job.incomplete_reason ? t(INCOMPLETE_REASON_KEYS[job.incomplete_reason]) : '');

  return (
    <section className={styles['maintenance-outcome']} data-tone={tone} data-testid="sys-maintenance-outcome">
      <div className={styles['maintenance-outcome-head']}>
        <span className={styles['maintenance-outcome-icon']} aria-hidden="true">{icon}</span>
        <span className={styles['maintenance-outcome-title']}>{title}</span>
        <Button
          variant="ghost"
          // The console's square row-action size, not `small`: a 28px control gains only 36px from
          // the coarse-pointer 4px hit inset, and the floor this console measures is ~40px.
          className={styles['maintenance-outcome-close']}
          icon={<CloseOutlined />}
          aria-label={t('common.close')}
          data-tip={t('common.close')}
          onClick={onDismiss}
        />
      </div>
      {reason && <p className={styles['maintenance-outcome-reason']}>{reason}</p>}
      <dl className={styles['maintenance-outcome-facts']}>
        <div>
          <dt>{t('sys.maintenance_footprint')}</dt>
          <dd>{formatBytes(job.size_before_bytes)} → {formatBytes(job.size_after_bytes)}</dd>
        </div>
        <div>
          <dt>{t('sys.maintenance_reclaimed_label')}</dt>
          <dd>{formatBytes(job.reclaimed_bytes)}</dd>
        </div>
        {job.checkpoint && (
          <div>
            <dt>{t('sys.maintenance_frames')}</dt>
            <dd>{t('sys.maintenance_frames_value', { checkpointed: job.checkpoint.checkpointed_frames, total: job.checkpoint.log_frames })}</dd>
          </div>
        )}
      </dl>
    </section>
  );
};

/**
 * The job holding the write gate, on the line its result will take. It is never dismissible. The
 * caller mounts it inside a persistent `role="status"` region, so the spinner is decoration here.
 */
export const MaintenanceRunning: React.FC<{ actionLabel: string }> = ({ actionLabel }) => {
  const t = useT();
  return (
    <section className={styles['maintenance-outcome']} data-tone="running" data-testid="sys-maintenance-running">
      <div className={styles['maintenance-outcome-head']}>
        <span className={styles['maintenance-outcome-icon']} aria-hidden="true"><Spinner size="small" role="presentation" aria-live="off" /></span>
        <span className={styles['maintenance-outcome-title']}>{t('sys.maintenance_in_progress', { action: actionLabel })}</span>
      </div>
    </section>
  );
};
