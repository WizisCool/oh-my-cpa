import { useState } from 'react';
import { Button, Select } from 'antd';
import clsx from 'clsx';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  SyncOutlined,
  WarningOutlined,
} from '../../components/icons';
import { api, apiErrorCode } from '../../api/client';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { SectionHeading } from '../../components/common/SectionHeading';
import { SecretInput } from '../../components/common/SecretInput';
import { SettingRow } from '../../components/common/SettingRow';
import { StatusLabel } from '../../components/common/StatusLabel';
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
import dayjs from '../../utils/time';
import { BACKUP_PROVIDERS, type DestinationInput } from './BackupDestination';
import { BackupProviderMark } from './BackupProviderMark';
import {
  DEFAULT_KEEP_LOCAL,
  INTERVAL_HOURS,
  KEEP_COUNTS,
  MAX_DESTINATIONS,
  STATE_KEYS,
  destinationInput,
  intervalLabel,
  isPassphraseLongEnough,
  withCurrent,
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
  onAddDestination: (provider: BackupProvider) => void;
  onEditDestination: (index: number, draft: DestinationInput) => void;
  onRestore: () => void;
}

const formatTime = (ms: number) => dayjs(ms).format('YYYY-MM-DD HH:mm');

/**
 * The backup page is a status card, the places the copies live, and the schedule - in the order
 * an operator checks them. Storing a copy somewhere new happens in place, with the accounts and
 * services as named, marked cards rather than a dropdown of protocols. Before the passphrase
 * exists the page is only the passphrase: nothing else can run without it.
 */
export function BackupPlan(props: Props) {
  const t = useT();
  const { value, isBusy } = props;
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  if (!value) {
    return props.loadError ? (
      <LoadFailure title={t('sys.backup_load_failed')} onRetry={props.loadError} />
    ) : (
      <p role="status" className={styles['hint']}>{t('sys.backup_auto_loading')}</p>
    );
  }
  return (
    <>
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
      {!value.has_passphrase ? (
        <PassphraseForm value={value} isBusy={isBusy} onSave={props.onSave} />
      ) : (
        <>
          <BackupStatus
            value={value}
            runningJob={props.runningJob}
            isBusy={isBusy}
            onRun={props.onRun}
            onRestore={props.onRestore}
          />
          <LocationsSection {...props} value={value} />
          <section className={styles['section']}>
            <SectionHeading level="group" as="h3" title={t('sys.backup_schedule')} />
            <div className={styles['card']}>
              <SettingRow
                label={t('sys.backup_auto_enabled')}
                description={t('sys.backup_auto_enabled_hint')}
                control={
                  <Switch
                    checked={value.enabled}
                    aria-label={t('sys.backup_auto_enabled')}
                    disabled={isBusy}
                    onChange={(enabled) => void props.onSave({ enabled })}
                  />
                }
              />
              <SettingRow
                label={t('sys.backup_auto_interval')}
                control={
                  <Select
                    className={styles['select']}
                    aria-label={t('sys.backup_auto_interval')}
                    value={value.interval_hours}
                    disabled={isBusy || !value.enabled}
                    options={withCurrent(INTERVAL_HOURS, value.interval_hours).map((hours) => ({
                      value: hours,
                      label: intervalLabel(hours, t),
                    }))}
                    onChange={(interval_hours) => void props.onSave({ interval_hours })}
                  />
                }
              />
            </div>
            <button
              type="button"
              className={styles['more-toggle']}
              aria-expanded={isMoreOpen}
              onClick={() => setIsMoreOpen(!isMoreOpen)}
            >
              {isMoreOpen ? t('sys.backup_less_settings') : t('sys.backup_more_settings')}
            </button>
            {isMoreOpen && <MoreSettings value={value} isBusy={isBusy} onSave={props.onSave} />}
          </section>
        </>
      )}
    </>
  );
}

/** "Is my data backed up": one verdict, how long ago, when the next one runs, and the two things to do about it. */
function BackupStatus({
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
  const hasLocation = value.keep_local > 0 || value.destinations.length > 0;
  const isRunning = !!runningJob && runningJob.kind === 'automatic';
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
            {!isRunning && value.last_success_at_ms > 0 && (
              <span className={styles['status-exact']}>{formatTime(value.last_success_at_ms)}</span>
            )}
          </strong>
          <span className={styles['status-next']}>
            {value.enabled && value.next_run_at_ms
              ? t('sys.backup_next_run', {
                  time: formatTime(value.next_run_at_ms),
                  interval: intervalLabel(value.interval_hours, t),
                })
              : t('sys.backup_schedule_off_hint')}
          </span>
        </div>
      </div>
      {value.last_error && !isRunning && (
        <Notice
          className={styles['status-notice']}
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
          disabled={isBusy || !hasLocation}
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

/** The first visit: one passphrase, and saving it turns the daily schedule on. */
function PassphraseForm({
  value,
  isBusy,
  onSave,
  onDone,
}: {
  value: BackupAutomation;
  isBusy: boolean;
  onSave: Props['onSave'];
  onDone?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const isFirst = !value.has_passphrase;
  const isMismatch = confirmation.length > 0 && passphrase !== confirmation;
  const canSave = isPassphraseLongEnough(passphrase) && passphrase === confirmation;
  const submit = async () => {
    setIsSaving(true);
    // Protecting backups is the only step between the operator and having them, so the first
    // passphrase also starts the daily schedule.
    const isSaved = await onSave(isFirst ? { passphrase, enabled: true } : { passphrase });
    setIsSaving(false);
    if (!isSaved) return;
    setPassphrase('');
    setConfirmation('');
    toast.success(t(isFirst ? 'sys.backup_setup_done' : 'sys.backup_passphrase_changed'));
    onDone?.();
  };
  return (
    <div className={clsx(styles['passphrase'], isFirst && styles['is-first'])}>
      {isFirst && (
        <SectionHeading level="group" as="h3" title={t('sys.backup_setup_title')} description={t('sys.backup_setup_hint')} />
      )}
      <div className={styles['field-pair']}>
        <label className={styles['field']}>
          <span>{t(isFirst ? 'sys.backup_passphrase' : 'sys.backup_new_passphrase')}</span>
          <SecretInput
            value={passphrase}
            maxLength={1024}
            disabled={isBusy || isSaving}
            autoComplete="new-password"
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <label className={styles['field']}>
          <span>{t('sys.backup_confirm_passphrase')}</span>
          <SecretInput
            value={confirmation}
            maxLength={1024}
            disabled={isBusy || isSaving}
            autoComplete="new-password"
            status={isMismatch ? 'error' : undefined}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
      </div>
      <p className={styles['hint']}>{t(isFirst ? 'sys.backup_key_hint' : 'sys.backup_passphrase_change_hint')}</p>
      <div className={styles['actions']}>
        {onDone && (
          <Button disabled={isSaving} onClick={onDone}>
            {t('common.cancel')}
          </Button>
        )}
        <Button type="primary" loading={isSaving} disabled={!canSave || isBusy} onClick={() => void submit()}>
          {t(isFirst ? 'sys.backup_setup_start' : 'sys.backup_passphrase_save')}
        </Button>
      </div>
    </div>
  );
}

/** What is set once and seldom touched: how many copies each place keeps, the passphrase, the recovery profile. */
function MoreSettings({
  value,
  isBusy,
  onSave,
}: {
  value: BackupAutomation;
  isBusy: boolean;
  onSave: Props['onSave'];
}) {
  const t = useT();
  const [isChangingPassphrase, setIsChangingPassphrase] = useState(false);
  const keepOptions = (current: number) =>
    withCurrent(KEEP_COUNTS, current).map((count) => ({
      value: count,
      label: t('sys.backup_keep_count', { count }),
    }));
  return (
    <div className={styles['card']}>
      {value.keep_local > 0 && (
        <SettingRow
          label={t('sys.backup_auto_keep_local')}
          control={
            <Select
              className={styles['select']}
              aria-label={t('sys.backup_auto_keep_local')}
              value={value.keep_local}
              disabled={isBusy}
              options={keepOptions(value.keep_local)}
              onChange={(keep_local) => void onSave({ keep_local })}
            />
          }
        />
      )}
      {value.destinations.length > 0 && (
        <SettingRow
          label={t('sys.backup_auto_keep_remote')}
          control={
            <Select
              className={styles['select']}
              aria-label={t('sys.backup_auto_keep_remote')}
              value={value.keep_remote}
              disabled={isBusy}
              options={keepOptions(value.keep_remote)}
              onChange={(keep_remote) => void onSave({ keep_remote })}
            />
          }
        />
      )}
      {isChangingPassphrase ? (
        <div className={styles['more-body']}>
          <PassphraseForm value={value} isBusy={isBusy} onSave={onSave} onDone={() => setIsChangingPassphrase(false)} />
        </div>
      ) : (
        <SettingRow
          label={t('sys.backup_passphrase')}
          control={
            <Button disabled={isBusy} onClick={() => setIsChangingPassphrase(true)}>
              {t('sys.backup_passphrase_change')}
            </Button>
          }
        />
      )}
      {value.destinations.length > 0 && (
        <SettingRow
          label={t('sys.backup_recovery_profile')}
          description={t('sys.backup_recovery_profile_hint')}
          control={
            <Button
              icon={<DownloadOutlined />}
              href={api.databaseBackupRecoveryProfileUrl()}
              target="_blank"
              rel="noopener"
            >
              {t('sys.backup_download')}
            </Button>
          }
        />
      )}
    </div>
  );
}

/**
 * Where backups go. The server's disk and each cloud account are cards of one list: every backup
 * lands in all of them, and the disk can be switched off once a cloud account holds the copies.
 * Adding one asks for the service first, in place, then opens its connection page.
 */
function LocationsSection(props: Props & { value: BackupAutomation }) {
  const t = useT();
  const toast = useToast();
  const { value, isBusy } = props;
  const [isChoosing, setIsChoosing] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const isLocalOn = value.keep_local > 0;
  const hasCloud = value.destinations.length > 0;
  const remove = (id: string) => {
    const destinations = value.destinations.filter((entry) => entry.id !== id).map(destinationInput);
    // The disk cannot stay off with nowhere else to keep a backup.
    return props.onSave({
      destinations,
      ...(destinations.length === 0 && !isLocalOn ? { keep_local: DEFAULT_KEEP_LOCAL } : {}),
    });
  };
  return (
    <section className={styles['section']}>
      <SectionHeading level="group" as="h3" title={t('sys.backup_where')} />
      <ul className={styles['locations']}>
        <li className={styles['location']}>
          <BackupProviderMark provider="local" />
          <div className={styles['location-text']}>
            <span className={styles['location-name']}>
              <strong>{t('sys.backup_local')}</strong>
            </span>
            <span>{isLocalOn ? t('sys.backup_local_on') : t('sys.backup_local_off')}</span>
          </div>
          <Switch
            checked={isLocalOn}
            aria-label={t('sys.backup_local')}
            disabled={isBusy || (isLocalOn && !hasCloud)}
            onChange={(checked) => void props.onSave({ keep_local: checked ? DEFAULT_KEEP_LOCAL : 0 })}
          />
        </li>
        {value.destinations.map((destination, index) => (
          <li className={styles['location']} key={destination.id}>
            <BackupProviderMark provider={destination.provider} />
            <div className={styles['location-text']}>
              <span className={styles['location-name']}>
                <strong>{destination.name}</strong>
                <StatusLabel tone="accent">{t('sys.backup_cloud_connected')}</StatusLabel>
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
      {!hasCloud && <p className={styles['hint']}>{t('sys.backup_cloud_why')}</p>}
      {value.destinations.length < MAX_DESTINATIONS &&
        (isChoosing ? (
          <ProviderChoices
            onCancel={() => setIsChoosing(false)}
            onSelect={(provider) => {
              setIsChoosing(false);
              props.onAddDestination(provider);
            }}
          />
        ) : (
          <button
            type="button"
            className={styles['add-location']}
            disabled={isBusy}
            onClick={() => setIsChoosing(true)}
          >
            <PlusOutlined aria-hidden />
            {t('sys.backup_add_cloud')}
          </button>
        ))}
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
  const featured = (provider: BackupProvider) => provider === 'onedrive' || provider === 'drive';
  return (
    <div className={styles['choices-panel']}>
      <div className={styles['choices']} role="group" aria-label={t('sys.backup_add_cloud')}>
        {BACKUP_PROVIDERS.filter((entry) => featured(entry.value)).map((entry) => (
          <ProviderChoice key={entry.value} {...entry} onSelect={onSelect} />
        ))}
      </div>
      <details className={styles['advanced']}>
        <summary>{t('sys.backup_other_storage')}</summary>
        <div className={styles['choices']} role="group" aria-label={t('sys.backup_other_storage')}>
          {BACKUP_PROVIDERS.filter((entry) => !featured(entry.value)).map((entry) => (
            <ProviderChoice key={entry.value} {...entry} onSelect={onSelect} />
          ))}
        </div>
      </details>
      <button type="button" className={styles['add-location']} onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  );
}

function ProviderChoice({
  value,
  label,
  onSelect,
}: {
  value: BackupProvider;
  label: string;
  onSelect: (provider: BackupProvider) => void;
}) {
  return (
    <button type="button" className={styles['choice']} onClick={() => onSelect(value)}>
      <BackupProviderMark provider={value} size={40} />
      <span className={styles['choice-label']}>{label}</span>
    </button>
  );
}
