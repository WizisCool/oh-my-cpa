import { useState } from 'react';
import { MetaLine } from '../../components/common/MetaLine';
import { Button } from '@/components/ui/button';
import { api, apiErrorCode } from '../../api/client';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { SectionHeading } from '../../components/common/SectionHeading';
import { StatusLabel, type StatusTone } from '../../components/common/StatusLabel';
import { CloudUploadOutlined, DeleteOutlined, DownloadOutlined, UploadOutlined } from '../../components/icons';
import { LoadFailure, Notice, useToast } from '../../components/feedback';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { DatabaseBackupJob } from '../../types/databaseBackup';
import { isDemoMode } from '../../types/demoMode';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import { saveBlob } from '../../utils/download';
import { formatBytes } from '../../utils/format';
import dayjs from '../../utils/time';
import { PassphraseFields, isPassphrasePairValid } from './BackupPassphrase';
import { RUNNING_STATES, STATE_KEYS } from './backupModel';
import styles from './DatabaseBackups.module.css';

const KIND_KEYS = {
  automatic: 'sys.backup_automatic',
  export: 'sys.backup_export',
  import: 'sys.backup_import',
} as const;

/** What made the record, at a glance: a run going out, a file coming down, a backup coming in. */
const KIND_GLYPHS = {
  automatic: <CloudUploadOutlined />,
  export: <DownloadOutlined />,
  import: <UploadOutlined />,
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
  const canSubmit = isPassphrasePairValid(passphrase, confirmation);
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
      <div className={styles['form-card']}>
        <PassphraseFields
          passphrase={passphrase}
          confirmation={confirmation}
          isDisabled={isBusy || isWorking}
          onPassphrase={setPassphrase}
          onConfirmation={setConfirmation}
        />
        <div className={styles['actions']}>
          <Button
            variant="primary"
            icon={<DownloadOutlined />}
            loading={isWorking}
            disabled={!canSubmit || isBusy}
            onClick={() => void submit()}
          >
            {t('sys.backup_create')}
          </Button>
        </div>
      </div>
      {exports.length > 0 && (
        <section className={styles['setup']}>
          <SectionHeading level="group" as="h3" title={t('sys.backup_export_files')} count={exports.length} />
          <ul className={styles['jobs']}>
            {exports.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </ul>
        </section>
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
  const toast = useToast();
  const [isDownloading, setIsDownloading] = useState(false);
  const canDownload = job.kind === 'export' && job.state === 'ready';
  const canRestore = !!onAct && job.kind === 'import' && job.state === 'ready';
  const canRemove = !!onAct && !RUNNING_STATES.has(job.state);
  const isScheduled = job.state === 'scheduled';
  const handleDemoDownload = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const blob = await api.downloadDatabaseBackup(job.id);
      saveBlob(blob, `omc-backup-${job.id}.omcbak`);
    } catch (error) {
      toast.error(t(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_error_failed')));
    } finally {
      setIsDownloading(false);
    }
  };
  return (
    <li className={styles['job']} data-tone={tone(job.state)}>
      <div className={styles['job-head']}>
        <span className={styles['job-glyph']} aria-hidden>
          {KIND_GLYPHS[job.kind]}
        </span>
        <div className={styles['location-text']}>
          <span className={styles['location-name']}>
            <strong>{t(KIND_KEYS[job.kind])}</strong>
            <StatusLabel tone={tone(job.state)}>
              <span role="status">{t(STATE_KEYS[job.state])}</span>
            </StatusLabel>
          </span>
          <MetaLine>
            {dayjs(job.created_at_ms).format('YYYY-MM-DD HH:mm:ss')}
            {job.size_bytes > 0 && formatBytes(job.size_bytes)}
          </MetaLine>
        </div>
        <div className={styles['location-actions']}>
          {canDownload && (
            isDemoMode() ? (
              <Button
                size="sm"
                icon={<DownloadOutlined />}
                loading={isDownloading}
                disabled={isDownloading}
                onClick={() => void handleDemoDownload()}
              >
                {t('sys.backup_download')}
              </Button>
            ) : (
              <Button
                size="sm"
                icon={<DownloadOutlined />}
                href={api.databaseBackupDownloadUrl(job.id)}
                target="_blank"
                rel="noopener"
              >
                {t('sys.backup_download')}
              </Button>
            )
          )}
          {canRemove && !isScheduled && (
            <ConfirmAction
              isDanger
              title={t(job.state === 'completed' ? 'sys.backup_remove_completed_confirm' : 'sys.backup_remove_confirm')}
              tooltip={t('sys.backup_remove')}
              onConfirm={() => onAct(job, 'delete')}
            >
              <Button variant="ghost" icon={<DeleteOutlined />} aria-label={t('sys.backup_remove')} />
            </ConfirmAction>
          )}
        </div>
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
      {(canRestore || (canRemove && isScheduled)) && (
        <div className={styles['job-actions']}>
          {canRestore && (
            <ConfirmAction
              isDanger
              title={t('sys.backup_restore_confirm')}
              description={t('sys.backup_restore_hint')}
              confirmLabel={t('sys.backup_restore')}
              onConfirm={() => onAct(job, 'restore')}
            >
              <Button size="sm" danger disabled={isBusy}>
                {t('sys.backup_restore')}
              </Button>
            </ConfirmAction>
          )}
          {canRemove && isScheduled && (
            <ConfirmAction isDanger title={t('sys.backup_cancel_confirm')} onConfirm={() => onAct(job, 'delete')}>
              <Button size="sm">{t('sys.backup_cancel')}</Button>
            </ConfirmAction>
          )}
        </div>
      )}
    </li>
  );
}
