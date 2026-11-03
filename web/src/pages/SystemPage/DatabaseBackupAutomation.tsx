import { useEffect, useRef, useState } from 'react';
import { Button, InputNumber, Select, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { CheckOutlined, RightOutlined } from '../../components/icons';
import { api, apiErrorCode } from '../../api/client';
import { Switch } from '../../components/common/Switch';
import { SecretInput } from '../../components/common/SecretInput';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { LoadFailure, Notice, useToast } from '../../components/feedback';
import { useT } from '../../i18n';
import type {
  BackupAutomation,
  BackupAutomationInput,
  BackupDestination as BackupDestinationSummary,
  BackupProvider,
} from '../../types/databaseBackup';
import type { MessageKey } from '../../i18n/catalog';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import { formatBytes } from '../../utils/format';
import dayjs from '../../utils/time';
import {
  BACKUP_PROVIDERS,
  BackupDestination,
  newBackupDestination,
  type DestinationInput,
} from './BackupDestination';
import styles from './DatabaseBackups.module.css';

type View = 'overview' | 'setup' | 'settings' | 'destinations' | 'archives' | 'recovery';
const destinationInput = ({
  id,
  name,
  provider,
  root,
}: BackupDestinationSummary): DestinationInput => ({ id, name, provider, root });
interface Props {
  isBusy: boolean;
  onRefresh: () => Promise<unknown>;
  onInspected: (id: string) => Promise<unknown>;
  onExport: () => void;
  onImport: () => void;
  onHistory: () => void;
}
export function DatabaseBackupAutomation(props: Props) {
  const t = useT();
  const query = useQuery({
    queryKey: ['database-backup-automation'],
    queryFn: () => api.getDatabaseBackupAutomation(),
    refetchInterval: 5000,
  });
  const [view, setView] = useState<View>('overview');
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<DestinationInput | null>(null);
  const toast = useToast();
  const value = query.data;
  const navigate = (next: View) => {
    setErrorKey(null);
    setDraft(null);
    setEditIndex(null);
    setView(next);
  };
  const perform = async (action: () => Promise<void>) => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      await action();
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error'));
    } finally {
      setIsWorking(false);
    }
  };
  if (query.error && !value)
    return <LoadFailure title={t('sys.backup_load_failed')} onRetry={() => void query.refetch()} />;
  if (!value) return <p role="status">{t('sys.backup_auto_loading')}</p>;
  const blocked = isWorking || props.isBusy;
  const save = async (input: BackupAutomationInput) => {
    await api.saveDatabaseBackupAutomation(input);
    await query.refetch();
  };
  const input: BackupAutomationInput = {
    enabled: value.enabled,
    interval_hours: value.interval_hours,
    keep_local: value.keep_local,
    keep_remote: value.keep_remote,
    destinations: value.destinations.map(destinationInput),
  };
  return (
    <section className={styles['content']}>
      {view !== 'overview' && view !== 'setup' && view !== 'settings' && (
        <Button
          type="text"
          className={styles['back']}
          onClick={() => navigate('overview')}
          disabled={isWorking}
        >
          {t('sys.backup_back_overview')}
        </Button>
      )}
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      {view === 'overview' && (
        <>
          {!value.has_passphrase ? (
            <div className={styles['welcome']}>
              <h3>{t('sys.backup_setup_title')}</h3>
              <p className={styles['hint']}>{t('sys.backup_setup_hint')}</p>
              <Button type="primary" onClick={() => navigate('setup')}>
                {t('sys.backup_setup_start')}
              </Button>
            </div>
          ) : (
            <>
              <div className={styles['summary']}>
                <div className={styles['job-head']}>
                  <h3>{t('sys.backup_automatic')}</h3>
                  <span>{t(value.enabled ? 'sys.backup_schedule_on' : 'sys.backup_auto_off')}</span>
                </div>
                <dl className={styles['facts']}>
                  <dt>{t('sys.backup_auto_success')}</dt>
                  <dd>
                    {value.last_success_at_ms
                      ? dayjs(value.last_success_at_ms).format('YYYY-MM-DD HH:mm')
                      : t('sys.backup_auto_never')}
                  </dd>
                  <dt>{t('sys.backup_auto_next')}</dt>
                  <dd>
                    {value.next_run_at_ms
                      ? dayjs(value.next_run_at_ms).format('YYYY-MM-DD HH:mm')
                      : t('sys.backup_auto_off')}
                  </dd>
                  <dt>{t('sys.backup_where')}</dt>
                  <dd>
                    {[
                      t('sys.backup_archive_local'),
                      ...value.destinations.map((destination) => destination.name),
                    ].join(' · ')}
                  </dd>
                </dl>
                {value.last_error && (
                  <Notice
                    tone="warning"
                    title={t('sys.backup_auto_last_failed')}
                    description={t('sys.backup_auto_local_hint')}
                  />
                )}
                <Space wrap>
                  <Button
                    type="primary"
                    loading={isWorking}
                    disabled={blocked}
                    onClick={() =>
                      void perform(async () => {
                        await api.runDatabaseBackupAutomation();
                        await props.onRefresh();
                      })
                    }
                  >
                    {t('sys.backup_auto_run')}
                  </Button>
                  <Button disabled={blocked} onClick={() => navigate('settings')}>
                    {t('sys.backup_settings')}
                  </Button>
                </Space>
              </div>
              <button className={styles['task']} onClick={() => navigate('destinations')}>
                <strong>{t('sys.backup_destinations')}</strong>
                <span>
                  {value.destinations.length
                    ? t('sys.backup_destinations_count', { count: value.destinations.length })
                    : t('sys.backup_destinations_none')}
                </span>
                <RightOutlined className={styles['task-arrow']} aria-hidden />
              </button>
            </>
          )}
          <div className={styles['task-list']}>
            <button className={styles['task']} onClick={() => navigate('archives')}>
              <strong>{t('sys.backup_restore_task')}</strong>
              <span>{t('sys.backup_restore_task_hint')}</span>
              <RightOutlined className={styles['task-arrow']} aria-hidden />
            </button>
            <button className={styles['task']} onClick={props.onExport}>
              <strong>{t('sys.backup_export_task')}</strong>
              <span>{t('sys.backup_export_task_hint')}</span>
              <RightOutlined className={styles['task-arrow']} aria-hidden />
            </button>
            {value.has_passphrase && value.destinations.length > 0 && (
              <button className={styles['task']} onClick={() => navigate('recovery')}>
                <strong>{t('sys.backup_disaster_recovery')}</strong>
                <span>{t('sys.backup_recovery_task_hint')}</span>
                <RightOutlined className={styles['task-arrow']} aria-hidden />
              </button>
            )}
            <button className={styles['task']} onClick={props.onHistory}>
              <strong>{t('sys.backup_history')}</strong>
              <span>{t('sys.backup_history_hint')}</span>
              <RightOutlined className={styles['task-arrow']} aria-hidden />
            </button>
          </div>
        </>
      )}
      {(view === 'setup' || view === 'settings') && (
        <BackupSetup
          value={value}
          isBusy={blocked}
          isFirstSetup={view === 'setup'}
          onSave={save}
          onFinish={() => navigate('overview')}
        />
      )}
      {view === 'destinations' && (
        <>
          <h3>{t('sys.backup_destinations')}</h3>
          {draft ? (
            <BackupDestination
              key={`${draft.provider}-${editIndex}`}
              value={draft}
              hasConnection={editIndex !== null && value.destinations[editIndex]?.has_config}
              isBusy={blocked}
              onBack={() => setDraft(null)}
              onApply={async (destination) => {
                const destinations = value.destinations.map(destinationInput);
                if (editIndex === null) destinations.push(destination);
                else destinations[editIndex] = destination;
                await save({ ...input, destinations });
                setDraft(null);
                toast.success(t('sys.backup_auto_saved'));
              }}
            />
          ) : (
            <>
              {value.destinations.map((destination, index) => (
                <article className={styles['job']} key={destination.id}>
                  <strong>{destination.name}</strong>
                  <span className={styles['hint']}>{destination.root}</span>
                  <Space wrap>
                    <Button
                      disabled={blocked}
                      onClick={() => {
                        setEditIndex(index);
                        setDraft(destinationInput(destination));
                      }}
                    >
                      {t('sys.backup_destination_edit')}
                    </Button>
                    <Button
                      disabled={blocked}
                      onClick={() =>
                        void perform(async () => {
                          await api.probeDatabaseBackupDestination(destination.id);
                          toast.success(t('sys.backup_destination_ok'));
                        })
                      }
                    >
                      {t('sys.backup_destination_test')}
                    </Button>
                    <ConfirmAction
                      isDanger
                      title={t('sys.backup_destination_remove_confirm', { name: destination.name })}
                      onConfirm={() =>
                        save({
                          ...input,
                          destinations: input.destinations.filter(
                            (entry) => entry.id !== destination.id
                          ),
                        })
                      }
                    >
                      <Button type="text" disabled={blocked}>
                        {t('common.delete')}
                      </Button>
                    </ConfirmAction>
                  </Space>
                </article>
              ))}
              {value.destinations.length < 8 && (
                <StorageChoices
                  allowLocal={false}
                  onSelect={(provider) => {
                    setEditIndex(null);
                    setDraft(newBackupDestination(provider as BackupProvider));
                  }}
                />
              )}
            </>
          )}
        </>
      )}
      {view === 'archives' && (
        <BackupArchives
          isBusy={blocked}
          destinations={value.destinations}
          onImport={props.onImport}
          onInspected={props.onInspected}
        />
      )}
      {view === 'recovery' && (
        <>
          <h3>{t('sys.backup_disaster_recovery')}</h3>
          <p>{t('sys.backup_recovery_profile_hint')}</p>
          <Button
            type="primary"
            href={api.databaseBackupRecoveryProfileUrl()}
            target="_blank"
            rel="noopener"
          >
            {t('sys.backup_recovery_profile_download')}
          </Button>
          <details className={styles['advanced']}>
            <summary>{t('sys.backup_advanced')}</summary>
            <p className={styles['hint']}>{t('sys.backup_remote_verify_hint')}</p>
          </details>
        </>
      )}
    </section>
  );
}

function StorageChoices({
  allowLocal,
  selected,
  onSelect,
}: {
  allowLocal: boolean;
  selected?: string;
  onSelect: (provider: BackupProvider | 'local') => void;
}) {
  const t = useT();
  const choice = (value: BackupProvider | 'local', label: string, hint?: string) => (
    <button
      type="button"
      key={value}
      className={styles['choice']}
      aria-pressed={selected === value}
      onClick={() => onSelect(value)}
    >
      <strong className={styles['choice-title']}>
        {label}
        {selected === value && <CheckOutlined aria-hidden />}
      </strong>
      {hint && <span>{hint}</span>}
    </button>
  );
  return (
    <div className={styles['content']}>
      <div className={styles['choices']}>
        {allowLocal && choice('local', t('sys.backup_local'), t('sys.backup_local_hint'))}
        {BACKUP_PROVIDERS.slice(0, 2).map((provider) =>
          choice(provider.value, provider.label, t('sys.backup_cloud_hint'))
        )}
      </div>
      <details className={styles['advanced']}>
        <summary>{t('sys.backup_other_storage')}</summary>
        <div className={styles['choices']}>
          {BACKUP_PROVIDERS.slice(2).map((provider) => choice(provider.value, provider.label))}
        </div>
      </details>
    </div>
  );
}
function BackupSetup({
  value,
  isBusy,
  isFirstSetup,
  onSave,
  onFinish,
}: {
  value: BackupAutomation;
  isBusy: boolean;
  isFirstSetup: boolean;
  onSave: (input: BackupAutomationInput) => Promise<void>;
  onFinish: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState(isFirstSetup ? 0 : 2);
  const [provider, setProvider] = useState<BackupProvider | 'local'>('local');
  const [destination, setDestination] = useState<DestinationInput | null>(null);
  const [settings, setSettings] = useState({
    enabled: isFirstSetup ? true : value.enabled,
    interval_hours: value.interval_hours,
    keep_local: value.keep_local,
    keep_remote: value.keep_remote,
  });
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const canSave =
    (value.has_passphrase && !passphrase && !confirmation) ||
    ([...passphrase].length >= 12 && passphrase === confirmation);
  const blocked = isBusy || isWorking;
  const save = async () => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      await onSave({
        ...settings,
        passphrase,
        destinations: isFirstSetup
          ? destination
            ? [destination]
            : []
          : value.destinations.map(destinationInput),
      });
      setPassphrase('');
      setConfirmation('');
      if (isFirstSetup) setStep(3);
      else onFinish();
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error'));
    } finally {
      setIsWorking(false);
    }
  };
  return (
    <section className={styles['content']}>
      {isFirstSetup && step < 3 && (
        <p className={styles['eyebrow']}>
          {t('sys.backup_step', {
            step: provider === 'local' && step === 2 ? 2 : step + 1,
            total: provider === 'local' ? 2 : 3,
          })}
        </p>
      )}
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      {step === 0 && (
        <>
          <h3>{t('sys.backup_choose_storage')}</h3>
          <p className={styles['hint']}>{t('sys.backup_choose_storage_hint')}</p>
          <StorageChoices
            allowLocal
            selected={provider}
            onSelect={(next) => {
              setProvider(next);
              setDestination(next === 'local' ? null : newBackupDestination(next));
            }}
          />
          <Space wrap>
            <Button onClick={onFinish}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => setStep(provider === 'local' ? 2 : 1)}>
              {t('sys.backup_continue')}
            </Button>
          </Space>
        </>
      )}
      {step === 1 && destination && (
        <BackupDestination
          value={destination}
          isBusy={blocked}
          onBack={() => setStep(0)}
          onApply={async (next) => {
            setDestination(next);
            setStep(2);
          }}
        />
      )}
      {step === 2 && (
        <>
          <h3>{t('sys.backup_plan_title')}</h3>
          <p className={styles['hint']}>{t('sys.backup_plan_hint')}</p>
          <label className={styles['field']}>
            <span>{t('sys.backup_auto_passphrase')}</span>
            <SecretInput
              value={passphrase}
              maxLength={1024}
              disabled={blocked}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          <label className={styles['field']}>
            <span>{t('sys.backup_confirm_passphrase')}</span>
            <SecretInput
              value={confirmation}
              maxLength={1024}
              disabled={blocked}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {value.has_passphrase && (
            <p className={styles['hint']}>{t('sys.backup_keep_passphrase')}</p>
          )}
          <label className={styles['field']}>
            <span>{t('sys.backup_auto_interval')}</span>
            <Select
              aria-label={t('sys.backup_auto_interval')}
              value={settings.interval_hours}
              options={[
                6,
                12,
                24,
                72,
                168,
                ...(![6, 12, 24, 72, 168].includes(settings.interval_hours)
                  ? [settings.interval_hours]
                  : []),
              ].map((hours) => ({ value: hours, label: t('sys.backup_every_hours', { hours }) }))}
              onChange={(interval_hours) => setSettings({ ...settings, interval_hours })}
            />
          </label>
          <details className={styles['advanced']}>
            <summary>{t('sys.backup_advanced')}</summary>
            <div className={styles['content']}>
              <label className={styles['job-head']}>
                <span>{t('sys.backup_auto_enabled')}</span>
                <Switch
                  checked={settings.enabled}
                  onChange={(enabled) => setSettings({ ...settings, enabled })}
                  disabled={blocked}
                />
              </label>
              <label className={styles['field']}>
                <span>{t('sys.backup_auto_interval')}</span>
                <InputNumber
                  min={1}
                  max={720}
                  value={settings.interval_hours}
                  disabled={blocked}
                  onChange={(hours) => setSettings({ ...settings, interval_hours: hours ?? 24 })}
                />
              </label>
              <div className={styles['settings-grid']}>
                <label className={styles['field']}>
                  <span>{t('sys.backup_auto_keep_local')}</span>
                  <InputNumber
                    min={1}
                    max={100}
                    value={settings.keep_local}
                    onChange={(keep) => setSettings({ ...settings, keep_local: keep ?? 7 })}
                  />
                </label>
                <label className={styles['field']}>
                  <span>{t('sys.backup_auto_keep_remote')}</span>
                  <InputNumber
                    min={1}
                    max={100}
                    value={settings.keep_remote}
                    onChange={(keep) => setSettings({ ...settings, keep_remote: keep ?? 30 })}
                  />
                </label>
              </div>
              <p className={styles['hint']}>{t('sys.backup_auto_secret_hint')}</p>
              <p className={styles['hint']}>{t('sys.backup_remote_verify_hint')}</p>
            </div>
          </details>
          <Space wrap>
            {isFirstSetup ? (
              <Button disabled={blocked} onClick={() => setStep(provider === 'local' ? 0 : 1)}>
                {t('sys.backup_back')}
              </Button>
            ) : (
              <Button onClick={onFinish} disabled={blocked}>
                {t('common.cancel')}
              </Button>
            )}
            <Button
              type="primary"
              loading={isWorking}
              disabled={blocked || !canSave}
              onClick={() => void save()}
            >
              {t('sys.backup_auto_save')}
            </Button>
          </Space>
        </>
      )}
      {step === 3 && (
        <div className={styles['welcome']}>
          <h3>{t('sys.backup_setup_done')}</h3>
          <p className={styles['hint']}>{t('sys.backup_setup_done_hint')}</p>
          {destination && (
            <Button
              type="primary"
              href={api.databaseBackupRecoveryProfileUrl()}
              target="_blank"
              rel="noopener"
            >
              {t('sys.backup_recovery_profile_download')}
            </Button>
          )}
          <Button type={destination ? 'default' : 'primary'} onClick={onFinish}>
            {t('sys.backup_back_overview')}
          </Button>
        </div>
      )}
    </section>
  );
}
function BackupArchives({
  isBusy,
  destinations,
  onImport,
  onInspected,
}: {
  isBusy: boolean;
  destinations: BackupDestinationSummary[];
  onImport: () => void;
  onInspected: (id: string) => Promise<unknown>;
}) {
  const t = useT();
  const [source, setSource] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const query = useQuery({
    queryKey: ['database-backup-archives', source],
    queryFn: () => api.getDatabaseBackupArchives(source),
  });
  const wasBusy = useRef(isBusy);
  useEffect(() => {
    if (wasBusy.current && !isBusy) void query.refetch();
    wasBusy.current = isBusy;
  }, [isBusy, query.refetch]);
  const inspect = async () => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      const inspected = await api.inspectDatabaseBackupArchive(source, selectedKey, passphrase);
      setPassphrase('');
      setSelectedKey('');
      await onInspected(inspected.id);
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error'));
    } finally {
      setIsWorking(false);
    }
  };
  return (
    <section className={styles['content']}>
      <h3>{t('sys.backup_restore_task')}</h3>
      <p className={styles['hint']}>{t('sys.backup_restore_task_hint')}</p>
      <Button onClick={onImport}>{t('sys.backup_upload_restore')}</Button>
      <label className={styles['field']}>
        <span>{t('sys.backup_archive_source')}</span>
        <Select
          aria-label={t('sys.backup_archive_source')}
          value={source}
          disabled={isWorking}
          options={[
            { value: '', label: t('sys.backup_archive_local') },
            ...destinations.map((destination) => ({
              value: destination.id,
              label: destination.name,
            })),
          ]}
          onChange={(id) => {
            setSource(id);
            setSelectedKey('');
            setPassphrase('');
            setErrorKey(null);
          }}
        />
      </label>
      <Button disabled={isWorking || query.isFetching} onClick={() => void query.refetch()}>
        {t('sys.backup_archive_refresh')}
      </Button>
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      {query.error && (
        <LoadFailure title={t('sys.backup_load_failed')} onRetry={() => void query.refetch()} />
      )}
      {query.isPending && <p role="status">{t('sys.backup_auto_loading')}</p>}
      {!query.isPending && !query.error && !query.data?.items.length && (
        <p className={styles['hint']}>{t('sys.backup_archive_empty')}</p>
      )}
      {query.data?.items.map((item) => (
        <article key={item.key} className={styles['job']}>
          <strong>{dayjs(item.created_at_ms).format('YYYY-MM-DD HH:mm:ss')}</strong>
          <span className={styles['hint']}>{formatBytes(item.size_bytes)}</span>
          <Space wrap>
            {!source && (
              <Button
                href={api.databaseBackupArchiveDownloadUrl(item.key)}
                target="_blank"
                rel="noopener"
              >
                {t('sys.backup_download')}
              </Button>
            )}
            <Button
              disabled={isBusy || isWorking}
              onClick={() => {
                setSelectedKey(item.key);
                setPassphrase('');
              }}
            >
              {t('sys.backup_archive_inspect')}
            </Button>
          </Space>
          {selectedKey === item.key && (
            <>
              <label className={styles['field']}>
                <span>{t('sys.backup_passphrase')}</span>
                <SecretInput
                  value={passphrase}
                  maxLength={1024}
                  disabled={isWorking}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              <Button
                type="primary"
                disabled={isBusy || isWorking || [...passphrase].length < 12}
                onClick={() => void inspect()}
              >
                {t('sys.backup_archive_inspect')}
              </Button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
