import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Checkbox, Select, TimePicker } from 'antd';
import dayjs from '../../utils/time';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  PlusOutlined,
  RollbackOutlined,
  SyncOutlined,
  WarningOutlined,
} from '../../components/icons';
import { api, apiErrorCode } from '../../api/client';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { Fold } from '../../components/common/Fold';
import { SectionHeading } from '../../components/common/SectionHeading';
import { SettingRow } from '../../components/common/SettingRow';
import { Switch } from '../../components/common/Switch';
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
import { PassphraseFields, isPassphrasePairValid } from './BackupPassphrase';
import { BackupProviderMark } from './BackupProviderMark';
import { DEFAULT_KEEP_LOCAL, KEEP_COUNTS, MAX_DESTINATIONS, STATE_KEYS, destinationInput } from './backupModel';
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

/** The stages a run passes through, in order; a run with no cloud location has nothing to upload. */
const RUN_STAGES: DatabaseBackupJob['state'][] = ['snapshotting', 'packaging', 'validating', 'uploading'];

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

/**
 * The verdict the panel opens on: when it last worked, when it runs next, and the two things to do
 * about it. A run in progress shows which stage it is at, so a long upload does not read as a hang.
 */
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
  const tone = isRunning ? 'run' : value.last_error ? 'warn' : value.last_success_at_ms ? 'ok' : 'idle';
  const label = isRunning
    ? t(STATE_KEYS[runningJob.state])
    : value.last_error
      ? t('sys.backup_auto_last_failed')
      : value.last_success_at_ms
        ? t('sys.backup_last_success')
        : null;
  return (
    <section className={styles['status']} data-tone={tone} aria-live="polite">
      <div className={styles['status-head']}>
        {/* Keyed by tone so a change of verdict lands with its own small arrival. */}
        <span key={tone} className={styles['status-icon']} aria-hidden>
          {tone === 'ok' ? (
            <CheckCircleOutlined />
          ) : tone === 'warn' ? (
            <WarningOutlined />
          ) : tone === 'run' ? (
            <SyncOutlined spin />
          ) : (
            <CloudUploadOutlined />
          )}
        </span>
        <div className={styles['status-text']}>
          {label && <span className={styles['status-label']}>{label}</span>}
          <strong className={styles['status-value']}>
            {isRunning
              ? t('sys.backup_running')
              : value.last_success_at_ms
                ? formatTimeAgo(value.last_success_at_ms, now || Date.now(), t)
                : t('sys.backup_none_yet')}
          </strong>
          <span className={styles['status-next']}>
            {!value.has_passphrase
              ? t('sys.backup_needs_passphrase')
              : value.enabled && value.next_run_at_ms
                ? t('sys.backup_next_run', { time: dayjs(value.next_run_at_ms).format('YYYY-MM-DD HH:mm') })
                : t('sys.backup_schedule_off_hint')}
          </span>
        </div>
      </div>
      {isRunning && <RunStages state={runningJob.state} hasUpload={value.destinations.length > 0} />}
      {value.last_error && !isRunning && (
        <p className={styles['status-alert']}>
          {t(value.keep_local > 0 ? 'sys.backup_auto_local_hint' : 'sys.backup_auto_fallback_hint')}
        </p>
      )}
      <div className={styles['status-actions']}>
        {value.has_passphrase && (
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            // A run in progress shows as this button working, not as a dead one: a loading button
            // already refuses clicks, so it keeps its colour and spinner instead of greying out.
            loading={isStarting || isRunning}
            disabled={(isBusy && !isRunning) || !hasLocation}
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
        )}
        <Button type="text" icon={<RollbackOutlined />} onClick={onRestore}>
          {t('sys.backup_restore_from_backup')}
        </Button>
      </div>
    </section>
  );
}

/** One segment per stage: the done ones filled, the current one breathing. */
function RunStages({ state, hasUpload }: { state: DatabaseBackupJob['state']; hasUpload: boolean }) {
  const stages = hasUpload ? RUN_STAGES : RUN_STAGES.slice(0, -1);
  const current = stages.indexOf(state);
  return (
    <ol className={styles['stages']} aria-hidden>
      {stages.map((stage, index) => (
        <li
          key={stage}
          className={styles['stage']}
          data-state={index < current ? 'done' : index === current ? 'active' : undefined}
        />
      ))}
    </ol>
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
    <section className={styles['setup-card']} aria-labelledby="backup-setup-title">
      <div className={styles['setup-head']}>
        <span className={styles['setup-icon']} aria-hidden>
          <LockOutlined />
        </span>
        <SectionHeading
          level="group"
          as="h3"
          id="backup-setup-title"
          title={t('sys.backup_setup_title')}
          description={t('sys.backup_setup_hint')}
        />
      </div>
      <PassphraseFields
        passphrase={passphrase}
        confirmation={confirmation}
        isDisabled={isBusy || isSaving}
        onPassphrase={setPassphrase}
        onConfirmation={setConfirmation}
      />
      <div className={styles['actions']}>
        <Button
          type="primary"
          loading={isSaving}
          disabled={!isPassphrasePairValid(passphrase, confirmation) || isBusy}
          onClick={() => void submit()}
        >
          {t('sys.backup_setup_start')}
        </Button>
      </div>
    </section>
  );
}

function PassphraseChange({ isBusy, onSave, onDone }: { isBusy: boolean; onSave: Props['onSave']; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const finish = () => {
    setPassphrase('');
    setConfirmation('');
    onDone();
  };
  return (
    <div className={styles['passphrase-change']}>
      <p className={styles['hint']}>{t('sys.backup_passphrase_change_hint')}</p>
      <PassphraseFields
        label="sys.backup_new_passphrase"
        passphrase={passphrase}
        confirmation={confirmation}
        isDisabled={isSaving}
        onPassphrase={setPassphrase}
        onConfirmation={setConfirmation}
      />
      <div className={styles['actions']}>
        <Button size="small" onClick={finish} disabled={isSaving}>
          {t('common.cancel')}
        </Button>
        <Button
          size="small"
          type="primary"
          loading={isSaving}
          disabled={!isPassphrasePairValid(passphrase, confirmation) || isBusy}
          onClick={async () => {
            setIsSaving(true);
            const isSaved = await onSave({ passphrase });
            setIsSaving(false);
            if (!isSaved) return;
            toast.success(t('sys.backup_passphrase_changed'));
            finish();
          }}
        >
          {t('sys.backup_passphrase_save')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The schedule as a settings group, the shape every other settings page uses: whether it runs, at
 * what time, how many copies each place keeps, and the passphrase that seals them.
 */
function Schedule({ value, isBusy, onSave }: { value: BackupAutomation; isBusy: boolean; onSave: Props['onSave'] }) {
  const t = useT();
  const [isChangingPassphrase, setIsChangingPassphrase] = useState(false);
  const [time, setTime] = useState(() => minuteToTime(value.daily_at_minute));
  useEffect(() => setTime(minuteToTime(value.daily_at_minute)), [value.daily_at_minute]);
  // A count saved outside the presets (the server accepts 1-100) is still offered, so the control
  // names it rather than showing a bare number.
  const keepOptions = [...new Set([...KEEP_COUNTS, value.keep_local, value.keep_remote])]
    .filter((count) => count > 0)
    .sort((left, right) => left - right)
    .map((count) => ({ value: count, label: t('sys.backup_keep_count', { count }) }));
  return (
    <section className={styles['setup']}>
      <SectionHeading level="group" as="h3" title={t('sys.backup_schedule')} />
      <div className={`settings-group ${styles['group']}`}>
        <SettingRow
          label={t('sys.backup_auto_enabled')}
          description={t('sys.backup_auto_desc')}
          control={
            <Switch
              checked={value.enabled}
              disabled={isBusy}
              aria-label={t('sys.backup_auto_enabled')}
              onChange={(checked) => void onSave({ enabled: checked })}
            />
          }
        />
        <SettingRow
          label={t('sys.backup_daily_at')}
          control={
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
          }
        />
        {value.keep_local > 0 && (
          <SettingRow
            label={t('sys.backup_keep_local')}
            control={
              <Select<number>
                className={styles['keep-select']}
                aria-label={t('sys.backup_keep_local')}
                value={value.keep_local}
                disabled={isBusy}
                options={keepOptions}
                popupMatchSelectWidth={false}
                onChange={(count) => void onSave({ keep_local: count })}
              />
            }
          />
        )}
        {value.destinations.length > 0 && (
          <SettingRow
            label={t('sys.backup_keep_remote')}
            control={
              <Select<number>
                className={styles['keep-select']}
                aria-label={t('sys.backup_keep_remote')}
                value={value.keep_remote}
                disabled={isBusy}
                options={keepOptions}
                popupMatchSelectWidth={false}
                onChange={(count) => void onSave({ keep_remote: count })}
              />
            }
          />
        )}
        <SettingRow
          label={t('sys.backup_passphrase')}
          description={t('sys.backup_passphrase_set')}
          control={
            <Button
              size="small"
              icon={<LockOutlined />}
              aria-expanded={isChangingPassphrase}
              onClick={() => setIsChangingPassphrase((isOpen) => !isOpen)}
            >
              {t('sys.backup_passphrase_change')}
            </Button>
          }
        />
        <Fold isOpen={isChangingPassphrase} className={styles['row-fold']}>
          <PassphraseChange isBusy={isBusy} onSave={onSave} onDone={() => setIsChangingPassphrase(false)} />
        </Fold>
      </div>
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
  // Rows present when the panel opened are simply there; one added since arrives.
  const initialIds = useRef(new Set(value.destinations.map((entry) => entry.id)));
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
      <SectionHeading level="group" as="h3" title={t('sys.backup_where')} description={t(hasCloud ? 'sys.backup_where_hint' : 'sys.backup_cloud_why')} />
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
            <span className={styles['location-path']}>{t('sys.backup_local_on')}</span>
          </div>
        </li>
        {value.destinations.map((destination, index) => (
          <li
            className={styles['location']}
            key={destination.id}
            data-new={!initialIds.current.has(destination.id) || undefined}
          >
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
      {value.destinations.length < MAX_DESTINATIONS && (
        <>
          <button
            type="button"
            className={styles['add-location']}
            aria-expanded={isChoosing}
            aria-controls="backup-provider-choices"
            disabled={isBusy}
            onClick={() => setIsChoosing((isOpen) => !isOpen)}
          >
            <PlusOutlined aria-hidden className={styles['add-glyph']} />
            {t('sys.backup_add_cloud')}
          </button>
          <Fold isOpen={isChoosing} id="backup-provider-choices">
            <ProviderChoices
              isOpen={isChoosing}
              onSelect={(provider) => {
                setIsChoosing(false);
                props.onEditDestination(null, newBackupDestination(provider));
              }}
            />
          </Fold>
        </>
      )}
    </section>
  );
}

/** The services as tiles that arrive one after another as the picker unfolds. */
function ProviderChoices({ isOpen, onSelect }: { isOpen: boolean; onSelect: (provider: BackupProvider) => void }) {
  const t = useT();
  return (
    <div className={styles['choices']} data-open={isOpen || undefined} role="group" aria-label={t('sys.backup_add_cloud')}>
      {BACKUP_PROVIDERS.map((entry, index) => (
        <button
          type="button"
          key={entry.value}
          className={styles['choice']}
          style={{ '--stagger': index } as CSSProperties}
          onClick={() => onSelect(entry.value)}
        >
          <BackupProviderMark provider={entry.value} size={36} />
          <span className={styles['choice-label']}>{entry.label}</span>
        </button>
      ))}
    </div>
  );
}
