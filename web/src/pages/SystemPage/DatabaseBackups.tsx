import { useState } from 'react';
import { Button, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api, apiErrorCode } from '../../api/client';
import { AppDrawer } from '../../components/common/AppDrawer';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { FileDropzone } from '../../components/common/FileDropzone';
import { SecretInput } from '../../components/common/SecretInput';
import { LoadFailure, Notice, useToast } from '../../components/feedback';
import { useT } from '../../i18n';
import type { DatabaseBackupJob } from '../../types/databaseBackup';
import type { MessageKey } from '../../i18n/catalog';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import { formatBytes } from '../../utils/format';
import dayjs from '../../utils/time';
import styles from './DatabaseBackups.module.css';
import { DatabaseBackupAutomation } from './DatabaseBackupAutomation';

const STATE_KEYS = {
  queued: 'sys.backup_state_queued',
  snapshotting: 'sys.backup_state_snapshotting',
  packaging: 'sys.backup_state_packaging',
  validating: 'sys.backup_state_validating',
  uploading: 'sys.backup_state_uploading',
  ready: 'sys.backup_state_ready',
  scheduled: 'sys.backup_state_scheduled',
  completed: 'sys.backup_state_completed',
  failed: 'sys.backup_state_failed',
} as const;

const RUNNING_STATES = new Set(['queued', 'snapshotting', 'packaging', 'validating', 'uploading']);

export function DatabaseBackups({ isDemo }: { isDemo: boolean }) {
  const t = useT();
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<'overview' | 'export' | 'import' | 'history' | 'restore'>(
    'overview'
  );
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restoreJobId, setRestoreJobId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const query = useQuery({
    queryKey: ['database-backups'],
    queryFn: () => api.getDatabaseBackups(),
    enabled: isOpen && !isDemo,
    refetchInterval: (current) =>
      isOpen && current.state.data?.items.some((job) => RUNNING_STATES.has(job.state))
        ? 1000
        : false,
  });
  const jobs = query.data?.items ?? [];
  const hasPendingRestore = jobs.some((job) => job.state === 'scheduled');
  const isBusy =
    isSubmitting || hasPendingRestore || jobs.some((job) => RUNNING_STATES.has(job.state));
  const canSubmit =
    [...passphrase].length >= 12 &&
    passphrase.length <= 1024 &&
    (mode === 'export' ? passphrase === confirmation : !!file);
  const reportError = (error: unknown) => {
    const code = apiErrorCode(error);
    setErrorKey(databaseBackupErrorKey(code, 'sys.backup_error_failed'));
  };
  const submit = async () => {
    setIsSubmitting(true);
    setErrorKey(null);
    try {
      if (mode === 'export') await api.createDatabaseBackup(passphrase);
      else if (file) {
        const inspected = await api.inspectDatabaseBackup(file, passphrase);
        setRestoreJobId(inspected.id);
        setMode('restore');
      }
      setPassphrase('');
      setConfirmation('');
      setFile(null);
      await query.refetch();
    } catch (error) {
      reportError(error);
    } finally {
      setIsSubmitting(false);
    }
  };
  const act = async (job: DatabaseBackupJob, action: 'restore' | 'delete') => {
    setActiveJob(job.id);
    setErrorKey(null);
    try {
      if (action === 'restore') await api.scheduleDatabaseRestore(job.id, job.digest);
      else await api.deleteDatabaseBackupJob(job.id);
      await query.refetch();
      toast.success(t(action === 'restore' ? 'sys.backup_scheduled' : 'sys.backup_removed'));
    } catch (error) {
      reportError(error);
    } finally {
      setActiveJob(null);
    }
  };
  const close = () => {
    if (isSubmitting) return;
    setIsOpen(false);
    setMode('overview');
    setPassphrase('');
    setConfirmation('');
    setFile(null);
    setErrorKey(null);
  };

  return (
    <>
      <div className={styles['entry']}>
        <span>{t('sys.backup_title')}</span>
        <Button disabled={isDemo} onClick={() => setIsOpen(true)}>
          {t('sys.backup_manage')}
        </Button>
      </div>
      <AppDrawer
        title={t('sys.backup_title')}
        open={isOpen}
        onClose={close}
        width="medium"
        destroyOnHidden
      >
        <div className={styles['content']}>
          {hasPendingRestore && (
            <Notice
              tone="warning"
              title={t('sys.backup_restart_title')}
              description={t('sys.backup_restart_hint')}
            />
          )}
          {errorKey && <Notice tone="error" title={t(errorKey)} />}
          {mode !== 'overview' && (
            <Button
              type="text"
              className={styles['back']}
              onClick={() => {
                setMode('overview');
                setPassphrase('');
                setConfirmation('');
                setFile(null);
                setErrorKey(null);
              }}
            >
              {t('sys.backup_back_overview')}
            </Button>
          )}
          {mode === 'overview' &&
            jobs
              .filter((job) => RUNNING_STATES.has(job.state))
              .map((job) => (
                <p key={job.id} role="status">
                  {t(STATE_KEYS[job.state])}
                </p>
              ))}
          {mode === 'overview' ? (
            <DatabaseBackupAutomation
              isBusy={isBusy}
              onRefresh={() => query.refetch()}
              onInspected={async (id) => {
                await query.refetch();
                setRestoreJobId(id);
                setMode('restore');
              }}
              onExport={() => setMode('export')}
              onImport={() => setMode('import')}
              onHistory={() => setMode('history')}
            />
          ) : (
            mode !== 'history' &&
            mode !== 'restore' && (
              <>
                <h3>
                  {t(mode === 'export' ? 'sys.backup_export_task' : 'sys.backup_restore_task')}
                </h3>
                <p className={styles['hint']}>{t('sys.backup_scope')}</p>
                {mode === 'import' && (
                  <FileDropzone
                    title={t('sys.backup_choose')}
                    hint={t('sys.backup_file_hint')}
                    chooseLabel={t('sys.backup_choose')}
                    inputLabel={t('sys.backup_choose')}
                    accept=".omcbackup"
                    disabled={isBusy}
                    onFiles={(files) => setFile(files[0] ?? null)}
                  >
                    {file && (
                      <span>
                        {file.name} · {formatBytes(file.size)}
                      </span>
                    )}
                  </FileDropzone>
                )}
                <label className={styles['field']}>
                  <span>{t('sys.backup_passphrase')}</span>
                  <SecretInput
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    disabled={isBusy}
                    maxLength={1024}
                  />
                </label>
                {mode === 'export' && (
                  <label className={styles['field']}>
                    <span>{t('sys.backup_confirm_passphrase')}</span>
                    <SecretInput
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      disabled={isBusy}
                      maxLength={1024}
                    />
                  </label>
                )}
                <p className={styles['hint']}>{t('sys.backup_key_hint')}</p>
                <Button
                  type="primary"
                  loading={isSubmitting}
                  disabled={!canSubmit || isBusy}
                  onClick={() => void submit()}
                >
                  {t(mode === 'export' ? 'sys.backup_create' : 'sys.backup_inspect')}
                </Button>
              </>
            )
          )}
          {mode !== 'overview' && (
            <section aria-label={t('sys.backup_history')} className={styles['history']}>
              <h3>{t(mode === 'restore' ? 'sys.backup_restore_task' : 'sys.backup_history')}</h3>
              {query.error && (
                <LoadFailure
                  title={t('sys.backup_load_failed')}
                  onRetry={() => void query.refetch()}
                />
              )}
              {!query.isPending && !query.error && !jobs.length && (
                <p className={styles['hint']}>{t('sys.backup_empty')}</p>
              )}
              {jobs
                .filter((job) =>
                  mode === 'restore'
                    ? job.id === restoreJobId
                    : mode === 'history' ||
                      (mode === 'export' ? job.kind === 'export' : job.kind === 'import')
                )
                .map((job) => (
                  <article className={styles['job']} key={job.id}>
                    <div className={styles['job-head']}>
                      <strong>
                        {t(
                          job.kind === 'automatic'
                            ? 'sys.backup_automatic'
                            : job.kind === 'export'
                              ? 'sys.backup_export'
                              : 'sys.backup_import'
                        )}
                      </strong>
                      <span role="status">{t(STATE_KEYS[job.state])}</span>
                    </div>
                    <div className={styles['hint']}>
                      {dayjs(job.created_at_ms).format('YYYY-MM-DD HH:mm:ss')}
                      {job.size_bytes > 0 && ` · ${formatBytes(job.size_bytes)}`}
                    </div>
                    {job.backup_created_at_ms > 0 && job.kind === 'import' && (
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
                    {job.has_audit_error && (
                      <Notice tone="warning" title={t('sys.backup_outcome_audit')} />
                    )}
                    {job.state === 'failed' && (
                      <Notice tone="error" title={t('sys.backup_error_failed')} />
                    )}
                    <Space wrap>
                      {job.kind === 'export' && job.state === 'ready' && (
                        <Button
                          href={api.databaseBackupDownloadUrl(job.id)}
                          target="_blank"
                          rel="noopener"
                        >
                          {t('sys.backup_download')}
                        </Button>
                      )}
                      {job.kind === 'import' && job.state === 'ready' && (
                        <ConfirmAction
                          isDanger
                          title={t('sys.backup_restore_confirm')}
                          description={t('sys.backup_restore_hint')}
                          confirmLabel={t('sys.backup_restore')}
                          onConfirm={() => act(job, 'restore')}
                          isConfirming={activeJob === job.id}
                        >
                          <Button danger disabled={isBusy || !!activeJob}>
                            {t('sys.backup_restore')}
                          </Button>
                        </ConfirmAction>
                      )}
                      {!RUNNING_STATES.has(job.state) && (
                        <ConfirmAction
                          isDanger
                          title={t(
                            job.state === 'scheduled'
                              ? 'sys.backup_cancel_confirm'
                              : job.state === 'completed'
                                ? 'sys.backup_remove_completed_confirm'
                                : 'sys.backup_remove_confirm'
                          )}
                          onConfirm={() => act(job, 'delete')}
                          isConfirming={activeJob === job.id}
                        >
                          <Button type="text" disabled={!!activeJob || isSubmitting}>
                            {t(
                              job.state === 'scheduled' ? 'sys.backup_cancel' : 'sys.backup_remove'
                            )}
                          </Button>
                        </ConfirmAction>
                      )}
                    </Space>
                  </article>
                ))}
            </section>
          )}
        </div>
      </AppDrawer>
    </>
  );
}
