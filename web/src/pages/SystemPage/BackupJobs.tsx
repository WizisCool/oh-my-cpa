import { useState } from 'react';
import { Button } from 'antd';
import { api, apiErrorCode } from '../../api/client';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { SecretInput } from '../../components/common/SecretInput';
import { StatusLabel, type StatusTone } from '../../components/common/StatusLabel';
import { DownloadOutlined } from '../../components/icons';
import { LoadFailure, Notice } from '../../components/feedback';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { DatabaseBackupJob } from '../../types/databaseBackup';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import { formatBytes } from '../../utils/format';
import dayjs from '../../utils/time';
import { RUNNING_STATES, STATE_KEYS, isPassphraseLongEnough } from './backupModel';
import styles from './DatabaseBackups.module.css';

const KIND_KEYS = {
  automatic: 'sys.backup_automatic',
  export: 'sys.backup_export',
  import: 'sys.backup_import',
} as const;

const tone = (state: DatabaseBackupJob['state']): StatusTone =>
  state === 'failed' ? 'danger' : state === 'scheduled' ? 'warn' : RUNNING_STATES.has(state) ? 'accent' : 'success';

/**
 * A one-off file for the operator's own device, protected by a passphrase chosen for it alone - it
 * needs no schedule, location or saved passphrase, so it also works before any of those exist.
 */
export function BackupExport({
  jobs,
  isBusy,
  onCreated,
}: {
  jobs: DatabaseBackupJob[];
  isBusy: boolean;
  onCreated: () => Promise<unknown>;
}) {
  const t = useT();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const exports = jobs.filter((job) => job.kind === 'export');
  const canSubmit = isPassphraseLongEnough(passphrase) && passphrase === confirmation;
  const submit = async () => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      await api.createDatabaseBackup(passphrase);
      setPassphrase('');
      setConfirmation('');
      await onCreated();
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_error_failed'));
    } finally {
      setIsWorking(false);
    }
  };
  return (
    <>
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      <div className={styles['passphrase']}>
        <div className={styles['field-pair']}>
          <label className={styles['field']}>
            <span>{t('sys.backup_passphrase')}</span>
            <SecretInput
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              disabled={isBusy || isWorking}
              autoComplete="new-password"
              maxLength={1024}
            />
          </label>
          <label className={styles['field']}>
            <span>{t('sys.backup_confirm_passphrase')}</span>
            <SecretInput
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={isBusy || isWorking}
              autoComplete="new-password"
              status={confirmation && passphrase !== confirmation ? 'error' : undefined}
              maxLength={1024}
            />
          </label>
        </div>
        <p className={styles['hint']}>{t('sys.backup_key_hint')}</p>
        <div className={styles['actions']}>
          <Button
            type="primary"
            loading={isWorking}
            disabled={!canSubmit || isBusy}
            onClick={() => void submit()}
          >
            {t('sys.backup_create')}
          </Button>
        </div>
      </div>
      {exports.length > 0 && (
        <ul className={styles['jobs']}>
          {exports.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </ul>
      )}
    </>
  );
}

export function BackupHistory({
  jobs,
  isLoading,
  loadError,
  isBusy,
  onAct,
}: {
  jobs: DatabaseBackupJob[];
  isLoading: boolean;
  loadError?: () => void;
  isBusy: boolean;
  onAct: (job: DatabaseBackupJob, action: 'restore' | 'delete') => Promise<void>;
}) {
  const t = useT();
  if (loadError) return <LoadFailure title={t('sys.backup_load_failed')} onRetry={loadError} />;
  if (isLoading) return <p role="status" className={styles['hint']}>{t('sys.backup_auto_loading')}</p>;
  if (!jobs.length) return <p className={styles['empty']}>{t('sys.backup_empty')}</p>;
  return (
    <ul className={styles['jobs']}>
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} isBusy={isBusy} onAct={onAct} />
      ))}
    </ul>
  );
}

function JobCard({
  job,
  isBusy = false,
  onAct,
}: {
  job: DatabaseBackupJob;
  isBusy?: boolean;
  onAct?: (job: DatabaseBackupJob, action: 'restore' | 'delete') => Promise<void>;
}) {
  const t = useT();
  const canDownload = job.kind === 'export' && job.state === 'ready';
  const canRemove = !!onAct && !RUNNING_STATES.has(job.state);
  return (
    <li className={styles['job']}>
      <div className={styles['job-head']}>
        <div className={styles['location-text']}>
          <strong>{t(KIND_KEYS[job.kind])}</strong>
          <span>
            {dayjs(job.created_at_ms).format('YYYY-MM-DD HH:mm:ss')}
            {job.size_bytes > 0 && ` · ${formatBytes(job.size_bytes)}`}
          </span>
        </div>
        <StatusLabel tone={tone(job.state)}>
          <span role="status">{t(STATE_KEYS[job.state])}</span>
        </StatusLabel>
      </div>
      {job.kind === 'import' && job.backup_created_at_ms > 0 && (
        <dl className={styles['facts']}>
          <dt>{t('sys.backup_source_time')}</dt>
          <dd>{dayjs(job.backup_created_at_ms).format('YYYY-MM-DD HH:mm:ss')}</dd>
          <dt>{t('sys.backup_source_version')}</dt>
          <dd>{job.source_version}</dd>
          {job.state === 'completed' && (
            <>
              <dt>{t('sys.backup_rollback_id')}</dt>
              <dd>
                <code>{job.id}</code>
              </dd>
            </>
          )}
        </dl>
      )}
      {job.has_audit_error && <Notice tone="warning" title={t('sys.backup_outcome_audit')} />}
      {(canDownload || canRemove || (onAct && job.kind === 'import' && job.state === 'ready')) && (
        <div className={styles['actions']}>
          {canDownload && (
            <Button
              icon={<DownloadOutlined />}
              href={api.databaseBackupDownloadUrl(job.id)}
              target="_blank"
              rel="noopener"
            >
              {t('sys.backup_download')}
            </Button>
          )}
          {onAct && job.kind === 'import' && job.state === 'ready' && (
            <ConfirmAction
              isDanger
              title={t('sys.backup_restore_confirm')}
              description={t('sys.backup_restore_hint')}
              confirmLabel={t('sys.backup_restore')}
              onConfirm={() => onAct(job, 'restore')}
            >
              <Button danger disabled={isBusy}>
                {t('sys.backup_restore')}
              </Button>
            </ConfirmAction>
          )}
          {canRemove && (
            <ConfirmAction
              isDanger
              title={t(
                job.state === 'scheduled'
                  ? 'sys.backup_cancel_confirm'
                  : job.state === 'completed'
                    ? 'sys.backup_remove_completed_confirm'
                    : 'sys.backup_remove_confirm'
              )}
              onConfirm={() => onAct(job, 'delete')}
            >
              <Button type="text">
                {t(job.state === 'scheduled' ? 'sys.backup_cancel' : 'sys.backup_remove')}
              </Button>
            </ConfirmAction>
          )}
        </div>
      )}
    </li>
  );
}
