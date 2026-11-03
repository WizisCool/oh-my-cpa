import { useState } from 'react';
import { Button } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorCode } from '../../api/client';
import { AppDrawer } from '../../components/common/AppDrawer';
import { ToolButton } from '../../components/common/ToolButton';
import { DownloadOutlined, HistoryOutlined, LeftOutlined, RollbackOutlined } from '../../components/icons';
import { Notice, useToast } from '../../components/feedback';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type {
  BackupAutomation,
  BackupAutomationInput,
  DatabaseBackupJob,
} from '../../types/databaseBackup';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import dayjs from '../../utils/time';
import { BackupDestination, providerLabel, type DestinationInput } from './BackupDestination';
import { BackupExport, BackupHistory } from './BackupJobs';
import { BackupPlan } from './BackupPlan';
import { BackupRestore } from './BackupRestore';
import { RUNNING_STATES, automationInput, intervalLabel } from './backupModel';
import styles from './DatabaseBackups.module.css';

type View =
  | { kind: 'plan' }
  | { kind: 'destination'; index: number | null; draft: DestinationInput }
  | { kind: 'restore' }
  | { kind: 'export' }
  | { kind: 'history' };

const AUTOMATION_KEY = ['database-backup-automation'];
const JOBS_KEY = ['database-backups'];

/**
 * The storage card's backup entry and the side panel it opens.
 *
 * Everything an operator does with backups lives on one page of the panel - when backups run,
 * where they are kept, the passphrase that protects them - and the three tasks that need a page of
 * their own (adding a location, restoring, exporting a file) step into it and back out. The local
 * disk is one location among the cloud ones: each backup goes to every location that is on.
 */
export function DatabaseBackups({ isDemo }: { isDemo: boolean }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'plan' });
  const [isSaving, setIsSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const automation = useQuery({
    queryKey: AUTOMATION_KEY,
    queryFn: () => api.getDatabaseBackupAutomation(),
    enabled: !isDemo,
    refetchInterval: isOpen ? 5000 : false,
  });
  const jobsQuery = useQuery({
    queryKey: JOBS_KEY,
    queryFn: () => api.getDatabaseBackups(),
    enabled: isOpen && !isDemo,
    refetchInterval: (current) =>
      current.state.data?.items.some((job) => RUNNING_STATES.has(job.state)) ? 1000 : false,
  });
  const value = automation.data;
  const jobs = jobsQuery.data?.items ?? [];
  const runningJob = jobs.find((job) => RUNNING_STATES.has(job.state));
  const pendingRestore = jobs.find((job) => job.state === 'scheduled');
  const isBusy = isSaving || !!runningJob || !!pendingRestore;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: AUTOMATION_KEY }),
      queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
    ]);
  };
  const save = async (patch: Partial<BackupAutomationInput>, current = value) => {
    if (!current) return false;
    setIsSaving(true);
    setErrorKey(null);
    try {
      const saved = await api.saveDatabaseBackupAutomation({ ...automationInput(current), ...patch });
      queryClient.setQueryData(AUTOMATION_KEY, saved);
      await queryClient.invalidateQueries({ queryKey: AUTOMATION_KEY });
      return true;
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error'));
      return false;
    } finally {
      setIsSaving(false);
    }
  };
  const act = async (job: DatabaseBackupJob, action: 'restore' | 'delete') => {
    setErrorKey(null);
    try {
      if (action === 'restore') await api.scheduleDatabaseRestore(job.id, job.digest);
      else await api.deleteDatabaseBackupJob(job.id);
      await jobsQuery.refetch();
      toast.success(t(action === 'restore' ? 'sys.backup_scheduled' : 'sys.backup_removed'));
      if (action === 'restore') setView({ kind: 'plan' });
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_error_failed'));
    }
  };
  const go = (next: View) => {
    setErrorKey(null);
    setView(next);
  };
  const close = () => {
    setIsOpen(false);
    setErrorKey(null);
  };

  const title =
    view.kind === 'destination'
      ? providerLabel(view.draft.provider)
      : view.kind === 'restore'
        ? t('sys.backup_restore_task')
        : view.kind === 'export'
          ? t('sys.backup_export_task')
          : view.kind === 'history'
            ? t('sys.backup_history')
            : t('sys.backup_title');
  const description =
    view.kind === 'destination'
        ? t('sys.backup_destination_hint')
        : view.kind === 'restore'
          ? t('sys.backup_restore_task_hint')
          : view.kind === 'export'
            ? t('sys.backup_export_task_hint')
            : undefined;

  return (
    <>
      <div className={styles['entry']}>
        <div className={styles['entry-text']}>
          <span>{t('sys.backup_title')}</span>
          {!isDemo && value && <span className={styles['hint']}>{entrySummary(value, t)}</span>}
        </div>
        <Button disabled={isDemo} onClick={() => setIsOpen(true)}>
          {t('sys.backup_manage')}
        </Button>
      </div>
      <AppDrawer
        open={isOpen}
        width="medium"
        title={
          view.kind === 'plan' ? (
            title
          ) : (
            <span className={styles['drawer-title']}>
              <ToolButton
                type="text"
                size="small"
                icon={<LeftOutlined />}
                label={t('common.back')}
                onClick={() => go({ kind: 'plan' })}
              />
              {title}
            </span>
          )
        }
        onClose={close}
        afterOpenChange={(open) => {
          if (!open) setView({ kind: 'plan' });
        }}
        // The tasks that need a page of their own stay one click away without adding to the page.
        footerStart={
          view.kind === 'plan' && (
            <>
              <Button type="text" size="small" icon={<RollbackOutlined />} onClick={() => go({ kind: 'restore' })}>
                {t('sys.backup_restore_task')}
              </Button>
              <Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => go({ kind: 'export' })}>
                {t('sys.backup_export_task')}
              </Button>
              <Button type="text" size="small" icon={<HistoryOutlined />} onClick={() => go({ kind: 'history' })}>
                {t('sys.backup_history')}
              </Button>
            </>
          )
        }
        destroyOnHidden
      >
        <div className={styles['content']}>
          {description && <p className={styles['hint']}>{description}</p>}
          {errorKey && <Notice tone="error" title={t(errorKey)} />}
          {view.kind === 'plan' && (
            <BackupPlan
              value={value}
              loadError={automation.error && !value ? () => void automation.refetch() : undefined}
              runningJob={runningJob}
              pendingRestore={pendingRestore}
              isBusy={isBusy}
              onSave={save}
              onRun={async () => {
                setErrorKey(null);
                try {
                  await api.runDatabaseBackupAutomation();
                  await refresh();
                } catch (error) {
                  setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error'));
                }
              }}
              onCancelRestore={(job) => act(job, 'delete')}
              onAddDestination={(draft) => go({ kind: 'destination', index: null, draft })}
              onEditDestination={(index, draft) => go({ kind: 'destination', index, draft })}
            />
          )}
          {view.kind === 'destination' && value && (
            <BackupDestination
              key={`${view.draft.provider}-${view.index}`}
              value={view.draft}
              hasConnection={view.index !== null && !!value.destinations[view.index]?.has_config}
              isBusy={isBusy}
              onBack={() => go({ kind: 'plan' })}
              onApply={async (destination) => {
                const destinations = automationInput(value).destinations;
                if (view.index === null) destinations.push(destination);
                else destinations[view.index] = destination;
                await api.saveDatabaseBackupAutomation({ ...automationInput(value), destinations });
                await queryClient.invalidateQueries({ queryKey: AUTOMATION_KEY });
                toast.success(t('sys.backup_destination_saved'));
                go({ kind: 'plan' });
              }}
            />
          )}
          {view.kind === 'restore' && (
            <BackupRestore
              destinations={value?.destinations ?? []}
              jobs={jobs}
              isBusy={isBusy}
              onInspected={() => jobsQuery.refetch()}
              onSchedule={(job) => act(job, 'restore')}
            />
          )}
          {view.kind === 'export' && (
            <BackupExport jobs={jobs} isBusy={isBusy} onCreated={() => jobsQuery.refetch()} />
          )}
          {view.kind === 'history' && (
            <BackupHistory
              jobs={jobs}
              isLoading={jobsQuery.isPending}
              loadError={jobsQuery.error ? () => void jobsQuery.refetch() : undefined}
              isBusy={isBusy}
              onAct={act}
            />
          )}
        </div>
      </AppDrawer>
    </>
  );
}

function entrySummary(value: BackupAutomation, t: ReturnType<typeof useT>) {
  if (!value.has_passphrase) return t('sys.backup_entry_unset');
  const last = value.last_success_at_ms
    ? t('sys.backup_entry_last', { time: dayjs(value.last_success_at_ms).format('YYYY-MM-DD HH:mm') })
    : t('sys.backup_auto_never');
  return value.enabled ? `${last} · ${intervalLabel(value.interval_hours, t)}` : last;
}
