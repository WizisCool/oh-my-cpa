import { useEffect, useState } from 'react';
import { Button, Checkbox, TimePicker } from 'antd';
import dayjs from '../../utils/time';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SyncOutlined,
  WarningOutlined,
} from '../../components/icons';
import { api, apiErrorCode } from '../../api/client';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { SectionHeading } from '../../components/common/SectionHeading';
import { SecretInput } from '../../components/common/SecretInput';
import { ToolButton } from '../../components/common/ToolButton';
import { LoadFailure, Notice, useToast } from '../../components/feedback';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { useT } from '../../i18n';
import type {
  BackupAutomation,
  BackupAutomationInput,
  BackupProvider,
  DatabaseBackupJob,
} from '../../types/databaseBackup';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import { formatTimeAgo } from '../../utils/format';
import { BACKUP_PROVIDERS, newBackupDestination, type DestinationInput } from './BackupDestination';
import { BackupProviderMark } from './BackupProviderMark';
import {
  DEFAULT_KEEP_LOCAL,
  KEEP_COUNTS,
  MAX_DESTINATIONS,
  STATE_KEYS,
  destinationInput,
  isPassphraseLongEnough,
} from './backupModel';
import styles from './DatabaseBackups.module.css';

interface Props {
  value: BackupAutomation | undefined;
  loadError?: () => void;
  runningJob?: DatabaseBackupJob;
  pendingRestore?: DatabaseBackupJob;
  isBusy: boolean;
  onSave: (patch: Partial<BackupAutomationInput>) => Promise<boolean>;
  onRun: () => Promise<void>;
  onCancelRestore: (job: DatabaseBackupJob) => Promise<void>;
  onEditDestination: (index: number | null, draft: DestinationInput) => void;
  onRestore: () => void;
}

const minuteToTime = (minute: number) =>
  dayjs().hour(Math.floor(minute / 60)).minute(minute % 60).second(0).millisecond(0);

/**
 * The backup panel is one form: the daily time, the passphrase, and where copies go.
 *
 * The passphrase gates everything - a backup that cannot be decrypted is worthless - so until it
 * exists it is the only thing the panel shows, and the controls below it stay hidden. Locations are
 * checkboxes because a backup goes to every one that is on, and the server's own disk is the first
 * of them rather than a special case.
 */
export function BackupPlan(props: Props) {
  const t = useT();
  const { value, isBusy } = props;
  if (!value) {
    return props.loadError ? (
      <LoadFailure title={t('sys.backup_load_failed')} onRetry={props.loadError} />
    ) : (
      <p role="status" className={styles['hint']}>{t('sys.backup_auto_loading')}</p>
    );
  }
  return (
    <div className={styles['content']}>
      {props.pendingRestore && (
        <Notice
          tone="warning"
          title={t('sys.backup_restart_title')}
          description={t('sys.backup_restart_hint')}
          action={
            <ConfirmAction
              isDanger
              title={t('sys.backup_cancel_confirm')}
              onConfirm={() => props.onCancelRestore(props.pendingRestore!)}
            >
              <Button size="small">{t('sys.backup_cancel')}</Button>
            </ConfirmAction>
          }
        />
      )}
      <Status
        value={value}
        runningJob={props.runningJob}
        isBusy={isBusy}
        onRun={props.onRun}
        onRestore={props.onRestore}
      />
      {value.has_passphrase ? (
        <>
          <Schedule value={value} isBusy={isBusy} onSave={props.onSave} />
          <Locations {...props} value={value} />
        </>
      ) : (
        <PassphraseSetup isBusy={isBusy} onSave={props.onSave} />
      )}
    </div>
  );
}

/** When it last ran and when it runs next, with the two things to do about it. */
function Status({
  value,
  runningJob,
  isBusy,
  onRun,
  onRestore,
}: {
  value: BackupAutomation;
  runningJob?: DatabaseBackupJob;
  isBusy: boolean;
  onRun: () => Promise<void>;
  onRestore: () => void;
}) {
  const t = useT();
  const now = useVisibleNow();
  const [isStarting, setIsStarting] = useState(false);
  const isRunning = !!runningJob && runningJob.kind === 'automatic';
  const hasLocation = value.keep_local > 0 || value.destinations.length > 0;
  const tone = isRunning || value.last_error ? 'warn' : value.last_success_at_ms ? 'ok' : 'idle';
  return (
    <section className={styles['status']} data-tone={tone} aria-live="polite">
      <div className={styles['status-head']}>
        <span className={styles['status-icon']} aria-hidden>
          {tone === 'ok' ? <CheckCircleOutlined /> : tone === 'warn' ? <WarningOutlined /> : <CloudUploadOutlined />}
        </span>
        <div className={styles['status-text']}>
          <span className={styles['status-label']}>
            {isRunning
              ? t(STATE_KEYS[runningJob.state])
              : value.last_error
                ? t('sys.backup_auto_last_failed')
                : value.last_success_at_ms
                  ? t('sys.backup_last_success')
                  : t('sys.backup_auto_never')}
          </span>
          <strong className={styles['status-value']}>
            {isRunning
              ? t('sys.backup_running')
              : value.last_success_at_ms
                ? formatTimeAgo(value.last_success_at_ms, now || Date.now(), t)
                : t('sys.backup_none_yet')}
          </strong>
          <span className={styles['status-next']}>
            {value.enabled && value.next_run_at_ms
              ? t('sys.backup_next_run', { time: dayjs(value.next_run_at_ms).format('YYYY-MM-DD HH:mm') })
              : t('sys.backup_schedule_off_hint')}
          </span>
        </div>
      </div>
      {value.last_error && !isRunning && (
        <Notice
          tone="warning"
          title={t('sys.backup_auto_last_failed')}
          description={t(value.keep_local > 0 ? 'sys.backup_auto_local_hint' : 'sys.backup_auto_fallback_hint')}
        />
      )}
      <div className={styles['status-actions']}>
        <Button
          type="primary"
          icon={<CloudUploadOutlined />}
          loading={isStarting || isRunning}
          disabled={isBusy || !hasLocation || !value.has_passphrase}
          onClick={async () => {
            setIsStarting(true);
            try {
              await onRun();
            } finally {
              setIsStarting(false);
            }
          }}
        >
          {t('sys.backup_auto_run')}
        </Button>
        <Button type="text" onClick={onRestore}>
          {t('sys.backup_restore_from_backup')}
        </Button>
      </div>
    </section>
  );
}

/**
 * The guided passphrase: what it is for, that losing it loses the backups, and a field that has to
 * be repeated before it is accepted. The daily schedule starts with it.
 */
function PassphraseSetup({ isBusy, onSave }: { isBusy: boolean; onSave: Props['onSave'] }) {
  const t = useT();
  const toast = useToast();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const isMismatch = confirmation.length > 0 && passphrase !== confirmation;
  const canSave = isPassphraseLongEnough(passphrase) && passphrase === confirmation;
  const submit = async () => {
    setIsSaving(true);
    // The passphrase is what stands between the operator and having any backup at all, so the
    // daily schedule turns on with it rather than waiting for a second save.
    const isSaved = await onSave({ passphrase, enabled: true });
    setIsSaving(false);
    if (!isSaved) return;
    setPassphrase('');
    setConfirmation('');
    toast.success(t('sys.backup_setup_done'));
  };
  return (
    <section className={styles['setup']} aria-labelledby="backup-setup-title">
      <SectionHeading
        level="group"
        as="h3"
        id="backup-setup-title"
        title={t('sys.backup_setup_title')}
        description={t('sys.backup_setup_hint')}
      />
      <div className={styles['field']}>
        <label htmlFor="backup-passphrase">{t('sys.backup_passphrase')}</label>
        <SecretInput
          id="backup-passphrase"
          value={passphrase}
          maxLength={1024}
          autoComplete="new-password"
          disabled={isBusy || isSaving}
          onChange={(event) => setPassphrase(event.target.value)}
        />
        <span className={styles['field-hint']}>{t('sys.backup_length_hint')}</span>
      </div>
      <div className={styles['field']}>
        <label htmlFor="backup-passphrase-confirm">{t('sys.backup_confirm_passphrase')}</label>
        <SecretInput
          id="backup-passphrase-confirm"
          value={confirmation}
          maxLength={1024}
          autoComplete="new-password"
          disabled={isBusy || isSaving}
          status={isMismatch ? 'error' : undefined}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      <p className={styles['hint']}>{t('sys.backup_key_hint')}</p>
      <div className={styles['actions']}>
        <Button type="primary" loading={isSaving} disabled={!canSave || isBusy} onClick={() => void submit()}>
          {t('sys.backup_setup_start')}
        </Button>
      </div>
    </section>
  );
}

function PassphraseChange({
  isBusy,
  onSave,
  onDone,
}: {
  isBusy: boolean;
  onSave: Props['onSave'];
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const canSave = isPassphraseLongEnough(passphrase) && passphrase === confirmation;
  return (
    <div className={styles['passphrase-change']}>
      <label className={styles['field']}>
        <span>{t('sys.backup_new_passphrase')}</span>
        <SecretInput
          value={passphrase}
          maxLength={1024}
          autoComplete="new-password"
          disabled={isSaving}
          onChange={(event) => setPassphrase(event.target.value)}
        />
      </label>
      <label className={styles['field']}>
        <span>{t('sys.backup_confirm_passphrase')}</span>
        <SecretInput
          value={confirmation}
          maxLength={1024}
          autoComplete="new-password"
          disabled={isSaving}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      <p className={styles['hint']}>{t('sys.backup_passphrase_change_hint')}</p>
      <div className={styles['actions']}>
        <Button size="small" onClick={onDone} disabled={isSaving}>
          {t('common.cancel')}
        </Button>
        <Button
          size="small"
          type="primary"
          loading={isSaving}
          disabled={!canSave || isBusy}
          onClick={async () => {
            setIsSaving(true);
            const isSaved = await onSave({ passphrase });
            setIsSaving(false);
            if (!isSaved) return;
            setPassphrase('');
            setConfirmation('');
            toast.success(t('sys.backup_passphrase_changed'));
            onDone();
          }}
        >
          {t('sys.backup_passphrase_save')}
        </Button>
      </div>
    </div>
  );
}

/** The daily time, whether the schedule runs, how many copies each place keeps. */
function Schedule({ value, isBusy, onSave }: { value: BackupAutomation; isBusy: boolean; onSave: Props['onSave'] }) {
  const t = useT();
  const [isChangingPassphrase, setIsChangingPassphrase] = useState(false);
  const [time, setTime] = useState(() => minuteToTime(value.daily_at_minute));
  useEffect(() => setTime(minuteToTime(value.daily_at_minute)), [value.daily_at_minute]);
  return (
    <section className={styles['setup']}>
      <div className={styles['schedule-head']}>
        <SectionHeading level="group" as="h3" title={t('sys.backup_schedule')} />
        <label className={styles['schedule-switch']}>
          <span>{t(value.enabled ? 'sys.backup_schedule_on' : 'sys.backup_schedule_off')}</span>
          <Checkbox
            checked={value.enabled}
            disabled={isBusy}
            aria-label={t('sys.backup_auto_enabled')}
            onChange={(event) => void onSave({ enabled: event.target.checked })}
          />
        </label>
      </div>
      <label className={styles['field']}>
        <span>{t('sys.backup_daily_at')}</span>
        <TimePicker
          className={styles['time-picker']}
          aria-label={t('sys.backup_daily_at')}
          value={time}
          format="HH:mm"
          allowClear={false}
          needConfirm={false}
          disabled={isBusy || !value.enabled}
          minuteStep={1}
          onChange={(next) => {
            if (!next) return;
            setTime(next);
            void onSave({ daily_at_minute: next.hour() * 60 + next.minute() });
          }}
        />
      </label>
      <div className={styles['retention']}>
        {value.keep_local > 0 && (
          <label className={styles['field']}>
            <span>{t('sys.backup_keep_local')}</span>
            <select
              className={styles['select-native']}
              aria-label={t('sys.backup_keep_local')}
              value={value.keep_local}
              disabled={isBusy}
              onChange={(event) => void onSave({ keep_local: Number(event.target.value) })}
            >
              {KEEP_COUNTS.map((count) => (
                <option key={count} value={count}>{t('sys.backup_keep_count', { count })}</option>
              ))}
            </select>
          </label>
        )}
        {value.destinations.length > 0 && (
          <label className={styles['field']}>
            <span>{t('sys.backup_keep_remote')}</span>
            <select
              className={styles['select-native']}
              aria-label={t('sys.backup_keep_remote')}
              value={value.keep_remote}
              disabled={isBusy}
              onChange={(event) => void onSave({ keep_remote: Number(event.target.value) })}
            >
              {KEEP_COUNTS.map((count) => (
                <option key={count} value={count}>{t('sys.backup_keep_count', { count })}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {isChangingPassphrase ? (
        <PassphraseChange isBusy={isBusy} onSave={onSave} onDone={() => setIsChangingPassphrase(false)} />
      ) : (
        <button type="button" className={styles['link-action']} onClick={() => setIsChangingPassphrase(true)}>
          {t('sys.backup_passphrase_change')}
        </button>
      )}
    </section>
  );
}

/** Where copies go: boxes, because every backup lands in everything that is on. */
function Locations(props: Props & { value: BackupAutomation }) {
  const t = useT();
  const toast = useToast();
  const { value, isBusy } = props;
  const [isChoosing, setIsChoosing] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const isLocalOn = value.keep_local > 0;
  const hasCloud = value.destinations.length > 0;
  const remove = (id: string) => {
    const destinations = value.destinations.filter((entry) => entry.id !== id);
    return props.onSave({
      destinations,
      ...(destinations.length === 0 && !isLocalOn ? { keep_local: DEFAULT_KEEP_LOCAL } : {}),
    });
  };
  return (
    <section className={styles['setup']}>
      <SectionHeading level="group" as="h3" title={t('sys.backup_where')} />
      <ul className={styles['locations']}>
        <li className={styles['location']}>
          <Checkbox
            aria-label={t('sys.backup_local')}
            checked={isLocalOn}
            // With no cloud location the disk is the only place a backup can go, and a backup that
            // went nowhere is not a backup: the box is on and cannot be cleared yet.
            disabled={isBusy || (isLocalOn && !hasCloud)}
            onChange={(event) => void props.onSave({ keep_local: event.target.checked ? DEFAULT_KEEP_LOCAL : 0 })}
          />
          <BackupProviderMark provider="local" />
          <div className={styles['location-text']}>
            <span className={styles['location-name']}>
              <strong>{t('sys.backup_local')}</strong>
              {isLocalOn && !hasCloud && <span className={styles['location-note']}>{t('sys.backup_local_needs_cloud')}</span>}
            </span>
            <span>{t('sys.backup_local_on')}</span>
          </div>
        </li>
        {value.destinations.map((destination, index) => (
          <li className={styles['location']} key={destination.id}>
            <Checkbox checked aria-label={destination.name} disabled={isBusy} onChange={() => void remove(destination.id)} />
            <BackupProviderMark provider={destination.provider} />
            <div className={styles['location-text']}>
              <span className={styles['location-name']}>
                <strong>{destination.name}</strong>
              </span>
              <span className={styles['location-path']}>{destination.root || '/'}</span>
            </div>
            <div className={styles['location-actions']}>
              <ToolButton
                type="text"
                icon={<SyncOutlined spin={probing === destination.id} />}
                label={t('sys.backup_destination_test')}
                disabled={isBusy || !!probing}
                onClick={async () => {
                  setProbing(destination.id);
                  try {
                    await api.probeDatabaseBackupDestination(destination.id);
                    toast.success(t('sys.backup_destination_ok', { name: destination.name }));
                  } catch (error) {
                    toast.error(t(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_destination_failed')));
                  } finally {
                    setProbing(null);
                  }
                }}
              />
              <ToolButton
                type="text"
                icon={<EditOutlined />}
                label={t('sys.backup_destination_edit')}
                disabled={isBusy}
                onClick={() => props.onEditDestination(index, destinationInput(destination))}
              />
              <ConfirmAction
                isDanger
                title={t('sys.backup_destination_remove_confirm', { name: destination.name })}
                confirmLabel={t('common.delete')}
                tooltip={t('common.delete')}
                onConfirm={() => remove(destination.id)}
              >
                <Button type="text" icon={<DeleteOutlined />} aria-label={t('common.delete')} disabled={isBusy} />
              </ConfirmAction>
            </div>
          </li>
        ))}
      </ul>
      {value.destinations.length < MAX_DESTINATIONS &&
        (isChoosing ? (
          <ProviderChoices
            onCancel={() => setIsChoosing(false)}
            onSelect={(provider) => {
              setIsChoosing(false);
              props.onEditDestination(null, newBackupDestination(provider));
            }}
          />
        ) : (
          <button type="button" className={styles['add-location']} disabled={isBusy} onClick={() => setIsChoosing(true)}>
            <PlusOutlined aria-hidden />
            {t('sys.backup_add_cloud')}
          </button>
        ))}
      <p className={styles['hint']}>{t(hasCloud ? 'sys.backup_where_hint' : 'sys.backup_cloud_why')}</p>
    </section>
  );
}

function ProviderChoices({
  onSelect,
  onCancel,
}: {
  onSelect: (provider: BackupProvider) => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className={styles['choices-panel']}>
      <div className={styles['choices']} role="group" aria-label={t('sys.backup_add_cloud')}>
        {BACKUP_PROVIDERS.map((entry) => (
          <button type="button" key={entry.value} className={styles['choice']} onClick={() => onSelect(entry.value)}>
            <BackupProviderMark provider={entry.value} size={36} />
            <span className={styles['choice-label']}>{entry.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className={styles['add-location']} onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  );
}
