import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorCode } from '../../api/client';
import { AppDrawer } from '../../components/common/AppDrawer';
import { AppModal } from '../../components/common/AppModal';
import { ToolButton } from '../../components/common/ToolButton';
import { DownloadOutlined, HistoryOutlined, LeftOutlined } from '../../components/icons';
import { useToast } from '../../components/feedback';
import { invalidateQueriesSilently } from '../../utils/progressSources';
import { useT } from '../../i18n';
import type { BackupAutomation, BackupAutomationInput, DatabaseBackupJob } from '../../types/databaseBackup';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import dayjs from '../../utils/time';
import { BackupDestination, providerLabel, type DestinationInput } from './BackupDestination';
import { BackupExport, BackupHistory } from './BackupJobs';
import { BackupPlan } from './BackupPlan';
import { BackupRestore } from './BackupRestore';
import { RUNNING_STATES, automationInput } from './backupModel';
import styles from './DatabaseBackups.module.css';

/** The panel itself, plus the two whole tasks that cannot share a panel with a form. */
type View = 'plan' | 'restore' | 'export' | 'history';

const AUTOMATION_KEY = ['database-backup-automation'];
const JOBS_KEY = ['database-backups'];

/**
 * The storage card's backup entry and the two layers it opens.
 *
 * The drawer is one form - daily time, passphrase, locations - and never navigates deeper. A cloud
 * account's connection is a dialog over it, and the tasks that are not settings (restore, export,
 * history) are pages inside the drawer, each with the way back in its title.
 */
export function DatabaseBackups({ isDemo }: { isDemo: boolean }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>('plan');
  const [editing, setEditing] = useState<{ index: number | null; draft: DestinationInput } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Which way the last move went, so a sub-page arrives from the side its back arrow points away
  // from. Unset until the first move: the drawer's own entrance is the panel's arrival.
  const [direction, setDirection] = useState<'forward' | 'back' | undefined>();
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
  /**
   * A setting written the moment it changes. The control moves first and is put back if the server
   * refuses, and the refusal comes as a toast: a notice at the top of the panel would sit out of
   * sight under a scroll.
   */
  const save = async (patch: Partial<BackupAutomationInput>, current = value) => {
    if (!current) return false;
    const previous = current;
    setIsSaving(true);
    queryClient.setQueryData(AUTOMATION_KEY, { ...current, ...patch });
    try {
      const saved = await api.saveDatabaseBackupAutomation({ ...automationInput(current), ...patch });
      queryClient.setQueryData(AUTOMATION_KEY, saved);
      await invalidateQueriesSilently(queryClient, { queryKey: AUTOMATION_KEY });
      return true;
    } catch (error) {
      queryClient.setQueryData(AUTOMATION_KEY, previous);
      toast.error(t(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error')));
      return false;
    } finally {
      setIsSaving(false);
    }
  };
  const act = async (job: DatabaseBackupJob, action: 'restore' | 'delete') => {
    try {
      if (action === 'restore') await api.scheduleDatabaseRestore(job.id, job.digest);
      else await api.deleteDatabaseBackupJob(job.id);
      await jobsQuery.refetch();
      toast.success(t(action === 'restore' ? 'sys.backup_scheduled' : 'sys.backup_removed'));
      if (action === 'restore') go('plan');
    } catch (error) {
      toast.error(t(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_error_failed')));
    }
  };
  const go = (next: View) => {
    setDirection(next === 'plan' ? 'back' : 'forward');
    setView(next);
  };
  const close = () => {
    setIsOpen(false);
    setView('plan');
    setDirection(undefined);
    setEditing(null);
  };

  const title =
    view === 'restore'
      ? t('sys.backup_restore_task')
      : view === 'export'
        ? t('sys.backup_export_task')
        : view === 'history'
          ? t('sys.backup_history')
          : t('sys.backup_title');
  const description =
    view === 'restore'
      ? t('sys.backup_restore_task_hint')
      : view === 'export'
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
        widthKey="database_backups"
        open={isOpen}
        width="medium"
        title={
          view === 'plan' ? (
            title
          ) : (
            <span className={styles['drawer-title']}>
              <ToolButton
                variant="ghost"
                size="sm"
                icon={<LeftOutlined />}
                label={t('common.back')}
                onClick={() => go('plan')}
              />
              {title}
            </span>
          )
        }
        onClose={close}
        // The two tasks that are not settings are the panel's own tools, beside its close control,
        // rather than a footer of labelled links under a scrolling form.
        extra={
          view === 'plan' && (
            <span className={styles['drawer-tools']}>
              <ToolButton variant="ghost" icon={<DownloadOutlined />} label={t('sys.backup_export_task')} onClick={() => go('export')} />
              <ToolButton variant="ghost" icon={<HistoryOutlined />} label={t('sys.backup_history')} onClick={() => go('history')} />
            </span>
          )
        }
        destroyOnHidden
      >
        <div key={view} className={styles['content']} data-direction={direction}>
          {description && <p className={styles['hint']}>{description}</p>}
          {view === 'plan' && (
            <BackupPlan
              value={value}
              loadError={automation.error && !value ? () => void automation.refetch() : undefined}
              runningJob={runningJob}
              pendingRestore={pendingRestore}
              isBusy={isBusy}
              onSave={save}
              onRun={async () => {
                try {
                  await api.runDatabaseBackupAutomation();
                  await refresh();
                  toast.info(t('sys.backup_started'));
                } catch (error) {
                  toast.error(t(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error')));
                }
              }}
              onCancelRestore={(job) => act(job, 'delete')}
              onEditDestination={(index, draft) => setEditing({ index, draft })}
              onRestore={() => go('restore')}
            />
          )}
          {view === 'restore' && (
            <BackupRestore
              destinations={value?.destinations ?? []}
              jobs={jobs}
              isBusy={isBusy}
              onInspected={() => jobsQuery.refetch()}
              onSchedule={(job) => act(job, 'restore')}
            />
          )}
          {view === 'export' && <BackupExport jobs={jobs} isBusy={isBusy} onCreated={() => jobsQuery.refetch()} />}
          {view === 'history' && (
            <BackupHistory
              jobs={jobs}
              isLoading={jobsQuery.isPending}
              loadError={jobsQuery.error ? () => void jobsQuery.refetch() : undefined}
              isBusy={isBusy}
              onAct={act}
            />
          )}
        </div>
        <AppModal
          open={!!editing}
          size="medium"
          title={editing ? providerLabel(editing.draft.provider) : ''}
          description={
            editing?.draft.provider === 'drive' || editing?.draft.provider === 'onedrive'
              ? t('sys.backup_destination_kind_account')
              : t('sys.backup_destination_kind_server')
          }
          onCancel={() => setEditing(null)}
          footer={null}
          destroyOnHidden
        >
          {editing && value && (
            <BackupDestination
              key={`${editing.draft.provider}-${editing.index}`}
              value={editing.draft}
              hasConnection={editing.index !== null && !!value.destinations[editing.index]?.has_config}
              isBusy={isBusy}
              onCancel={() => setEditing(null)}
              onApply={async (destination) => {
                const destinations = automationInput(value).destinations;
                if (editing.index === null) destinations.push(destination);
                else destinations[editing.index] = destination;
                await api.saveDatabaseBackupAutomation({ ...automationInput(value), destinations });
                await queryClient.invalidateQueries({ queryKey: AUTOMATION_KEY });
                toast.success(t('sys.backup_destination_saved'));
                setEditing(null);
              }}
            />
          )}
        </AppModal>
      </AppDrawer>
    </>
  );
}

function entrySummary(value: BackupAutomation, t: ReturnType<typeof useT>) {
  if (!value.has_passphrase) return t('sys.backup_entry_unset');
  if (!value.enabled) {
    return value.last_success_at_ms
      ? t('sys.backup_entry_last', { time: dayjs(value.last_success_at_ms).format('YYYY-MM-DD HH:mm') })
      : t('sys.backup_auto_never');
  }
  const clock = `${String(Math.floor(value.daily_at_minute / 60)).padStart(2, '0')}:${String(
    value.daily_at_minute % 60,
  ).padStart(2, '0')}`;
  return t('sys.backup_every_day_at', { time: clock });
}

