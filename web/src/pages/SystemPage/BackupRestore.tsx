import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { useQuery } from '@tanstack/react-query';
import { api, apiErrorCode } from '../../api/client';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { FileDropzone } from '../../components/common/FileDropzone';
import { SecretInput } from '../../components/common/SecretInput';
import { ToolButton } from '../../components/common/ToolButton';
import { CheckOutlined, DownloadOutlined, ReloadOutlined, SafetyCertificateOutlined } from '../../components/icons';
import { LoadFailure, Notice } from '../../components/feedback';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { BackupDestination, DatabaseBackupJob } from '../../types/databaseBackup';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import { formatBytes } from '../../utils/format';
import dayjs from '../../utils/time';
import { isPassphraseLongEnough } from './backupModel';
import styles from './DatabaseBackups.module.css';

/** The local disk is the empty destination id, as the archive API names it. */
const LOCAL = '';
const UPLOAD = 'upload';

interface Props {
  destinations: BackupDestination[];
  jobs: DatabaseBackupJob[];
  isBusy: boolean;
  onInspected: () => Promise<unknown>;
  onSchedule: (job: DatabaseBackupJob) => Promise<void>;
}

/**
 * Restoring is three steps on one page: pick a backup from any location (or upload a file),
 * unlock and validate it with its passphrase, then confirm the restore that the next restart
 * applies. Nothing is replaced until that confirmation, and the confirmation is bound to the
 * validated file's digest.
 */
export function BackupRestore({ destinations, jobs, isBusy, onInspected, onSchedule }: Props) {
  const t = useT();
  const [source, setSource] = useState(LOCAL);
  const [selectedKey, setSelectedKey] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const archives = useQuery({
    queryKey: ['database-backup-archives', source],
    queryFn: () => api.getDatabaseBackupArchives(source),
    enabled: source !== UPLOAD,
  });
  const preview = jobs.find((job) => job.id === previewId);
  const reset = () => {
    setSelectedKey('');
    setFile(null);
    setPassphrase('');
    setErrorKey(null);
  };
  const inspect = async () => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      const inspected =
        source === UPLOAD && file
          ? await api.inspectDatabaseBackup(file, passphrase)
          : await api.inspectDatabaseBackupArchive(source, selectedKey, passphrase);
      await onInspected();
      reset();
      setPreviewId(inspected.id);
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error'));
    } finally {
      setIsWorking(false);
    }
  };

  const step = preview ? 2 : (source === UPLOAD ? file : selectedKey) ? 1 : 0;
  const steps = <RestoreSteps current={step} />;

  if (preview) {
    return (
      <section className={styles['restore']}>
        {steps}
        <div className={styles['preview']}>
          <div className={styles['preview-head']}>
            <span className={styles['preview-icon']} aria-hidden>
              <SafetyCertificateOutlined />
            </span>
            <h3 className={styles['preview-title']}>{t('sys.backup_preview_title')}</h3>
          </div>
          <dl className={styles['facts']}>
            <dt>{t('sys.backup_source_time')}</dt>
            <dd>{dayjs(preview.backup_created_at_ms).format('YYYY-MM-DD HH:mm:ss')}</dd>
            <dt>{t('sys.backup_source_version')}</dt>
            <dd>{preview.source_version}</dd>
            <dt>{t('sys.backup_size')}</dt>
            <dd>{formatBytes(preview.size_bytes)}</dd>
          </dl>
          <Notice tone="warning" title={t('sys.backup_restore_hint')} />
          <div className={styles['actions']}>
            <Button onClick={() => setPreviewId('')}>{t('sys.backup_choose_another')}</Button>
            <ConfirmAction
              isDanger
              title={t('sys.backup_restore_confirm')}
              confirmLabel={t('sys.backup_restore')}
              onConfirm={() => onSchedule(preview)}
            >
              <Button variant="primary" danger disabled={isBusy || preview.state !== 'ready'}>
                {t('sys.backup_restore')}
              </Button>
            </ConfirmAction>
          </div>
        </div>
      </section>
    );
  }

  const passphraseField = (
    <div className={styles['unlock']}>
      <label className={styles['field']}>
        <span>{t('sys.backup_passphrase')}</span>
        <SecretInput
          autoFocus
          value={passphrase}
          maxLength={1024}
          disabled={isWorking}
          onChange={(event) => setPassphrase(event.target.value)}
          onPressEnter={() => {
            if (isPassphraseLongEnough(passphrase)) void inspect();
          }}
        />
      </label>
      <Button
        variant="primary"
        loading={isWorking}
        disabled={isBusy || !isPassphraseLongEnough(passphrase)}
        onClick={() => void inspect()}
      >
        {t('sys.backup_archive_inspect')}
      </Button>
    </div>
  );

  return (
    <section className={styles['restore']}>
      {steps}
      <Segmented
        block
        className={styles['sources']}
        aria-label={t('sys.backup_archive_source')}
        value={source}
        disabled={isWorking}
        options={[
          { value: LOCAL, label: t('sys.backup_local') },
          ...destinations.map((destination) => ({ value: destination.id, label: destination.name })),
          { value: UPLOAD, label: t('sys.backup_upload_restore') },
        ]}
        onChange={(next) => {
          setSource(String(next));
          reset();
        }}
      />
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      {source === UPLOAD ? (
        <>
          <FileDropzone
            title={t('sys.backup_choose')}
            hint={t('sys.backup_file_hint')}
            chooseLabel={t('sys.backup_choose')}
            inputLabel={t('sys.backup_choose')}
            accept=".omcbackup"
            disabled={isBusy || isWorking}
            onFiles={(files) => setFile(files[0] ?? null)}
          >
            {file && (
              <span>
                {file.name} · {formatBytes(file.size)}
              </span>
            )}
          </FileDropzone>
          {file && passphraseField}
        </>
      ) : (
        <>
          <div className={styles['list-head']}>
            <span className={styles['hint']}>
              {archives.data ? t('sys.backup_archive_count', { count: archives.data.items.length }) : ' '}
            </span>
            <ToolButton
              variant="ghost"
              size="sm"
              icon={<ReloadOutlined spin={archives.isFetching} />}
              label={t('sys.backup_archive_refresh')}
              disabled={archives.isFetching}
              onClick={() => void archives.refetch()}
            />
          </div>
          {archives.error && (
            <LoadFailure title={t('sys.backup_load_failed')} onRetry={() => void archives.refetch()} />
          )}
          {archives.isPending && <p role="status" className={styles['hint']}>{t('sys.backup_auto_loading')}</p>}
          {archives.data && !archives.data.items.length && (
            <p className={styles['empty']}>{t('sys.backup_archive_empty')}</p>
          )}
          {!!archives.data?.items.length && (
            <ul className={styles['archives']}>
              {archives.data.items.map((item) => (
                <li key={item.key} className={styles['archive']} data-selected={selectedKey === item.key || undefined}>
                  <div className={styles['archive-row']}>
                    <div className={styles['location-text']}>
                      <strong>{dayjs(item.created_at_ms).format('YYYY-MM-DD HH:mm')}</strong>
                      <span>{formatBytes(item.size_bytes)}</span>
                    </div>
                    {source === LOCAL && (
                      <ToolButton
                        variant="ghost"
                        icon={<DownloadOutlined />}
                        label={t('sys.backup_download')}
                        href={api.databaseBackupArchiveDownloadUrl(item.key)}
                        target="_blank"
                        rel="noopener"
                      />
                    )}
                    <Button
                      size="sm"
                      variant={selectedKey === item.key ? 'primary' : 'secondary'}
                      aria-expanded={selectedKey === item.key}
                      disabled={isBusy || isWorking}
                      onClick={() => {
                        setSelectedKey(selectedKey === item.key ? '' : item.key);
                        setPassphrase('');
                        setErrorKey(null);
                      }}
                    >
                      {t('sys.backup_restore_this')}
                    </Button>
                  </div>
                  {selectedKey === item.key && passphraseField}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const STEP_KEYS = ['sys.backup_step_choose', 'sys.backup_step_unlock', 'sys.backup_step_confirm'] as const;

/** Where the reader is in the three steps, so the page says what comes after the one in front of them. */
function RestoreSteps({ current }: { current: number }) {
  const t = useT();
  return (
    <ol className={styles['restore-steps']}>
      {STEP_KEYS.map((key, index) => {
        const state = index < current ? 'done' : index === current ? 'active' : undefined;
        return (
          <li key={key} className={styles['restore-step']} data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
            <span className={styles['restore-step-index']} aria-hidden>
              {state === 'done' ? <CheckOutlined /> : index + 1}
            </span>
            <span className={styles['restore-step-label']}>{t(key)}</span>
          </li>
        );
      })}
    </ol>
  );
}
