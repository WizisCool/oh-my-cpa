import type { MessageKey } from '../../i18n/catalog';
import React from 'react';
import { App, Button, Input, Segmented, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useI18n, useT, type TFunc } from '../../i18n';
import { languageLocale } from '../../i18n/language';
import { isDemoMode } from '../../types/demoMode';
import {
  canSaveWarmupTask,
  defaultWarmupTaskInput,
  resolveTaskModel,
  sortModelsForAuto,
  type WarmupCatalog,
  type WarmupCatalogAccount,
  type WarmupRun,
  type WarmupStateView,
  type WarmupTask,
  type WarmupTaskInput,
  type WarmupTrigger,
} from '../../types/warmup';
import { AppDrawer } from '../common/AppDrawer';
import { NumberInput } from '../common/NumberInput';
import { SearchSelect } from '../common/SearchSelect';
import { SectionHeading } from '../common/SectionHeading';
import { StatusLabel, type StatusTone } from '../common/StatusLabel';
import { Switch } from '../common/Switch';
import { LoadFailure, useToast } from '../feedback';
import styles from './CredentialWarmup.module.css';

const { Text } = Typography;

const OUTCOME_KEYS: Record<WarmupRun['outcome'], MessageKey> = {
  ok: 'warmup.outcome_ok',
  failed: 'warmup.outcome_failed',
  unknown: 'warmup.outcome_unknown',
  running: 'warmup.outcome_running',
};

const SOURCE_KEYS: Record<WarmupRun['source'], MessageKey> = {
  schedule: 'warmup.source_schedule',
  catchup: 'warmup.source_catchup',
  manual: 'warmup.source_manual',
};

function outcomeTone(outcome: WarmupRun['outcome']): StatusTone {
  switch (outcome) {
    case 'ok':
      return 'success';
    case 'failed':
    case 'unknown':
      return 'warn';
    case 'running':
      return 'accent';
  }
}

function formatISOInstant(iso: string | null | undefined, timeZone: string, locale: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timeZone || 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ms);
  }
}

function findAccount(
  catalog: WarmupCatalog | undefined,
  provider: string,
  authIndex: string,
  accountName?: string,
): WarmupCatalogAccount | undefined {
  if (!catalog) return undefined;
  for (const group of catalog.providers) {
    if (provider && group.provider !== provider) continue;
    if (authIndex) {
      const byIndex = group.accounts.find((acc) => acc.auth_index === authIndex);
      if (byIndex) return byIndex;
    }
    if (accountName) {
      const byName = group.accounts.find((acc) => acc.name === accountName);
      if (byName) return byName;
    }
  }
  return undefined;
}

function findAccountByAuthIndex(catalog: WarmupCatalog | undefined, authIndex: string): WarmupCatalogAccount | undefined {
  if (!catalog) return undefined;
  for (const group of catalog.providers) {
    const found = group.accounts.find((acc) => acc.auth_index === authIndex);
    if (found) return found;
  }
  return undefined;
}

function describeTrigger(
  trigger: WarmupTrigger,
  account: WarmupCatalogAccount | undefined,
  fallbackZone: string,
  t: TFunc,
): string {
  switch (trigger.kind) {
    case 'window': {
      const win = account?.windows.find((w) => w.id === trigger.window);
      const label = win?.label ?? (trigger.window === 'seven_day' || trigger.window === 'weekly' ? '7d' : '5h');
      return t('warmup.summary_window', { window: label });
    }
    case 'daily':
      return t('warmup.summary_daily', {
        time: trigger.time ?? '08:55',
        zone: trigger.time_zone || fallbackZone || 'UTC',
      });
    case 'every':
      return t('warmup.summary_every', { hours: trigger.hours ?? 5 });
  }
}

function taskToInput(task: WarmupTask, fallbackZone: string): WarmupTaskInput {
  return {
    name: task.name,
    enabled: task.enabled,
    provider: task.provider,
    auth_index: task.auth_index,
    account: task.account,
    model: task.model,
    trigger: {
      kind: task.trigger.kind,
      window: task.trigger.window || 'five_hour',
      time: task.trigger.time || '08:55',
      time_zone: task.trigger.time_zone || fallbackZone || 'UTC',
      hours: task.trigger.hours || 5,
      anchor: task.trigger.anchor || task.created_at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  };
}

function cleanTriggerPayload(input: WarmupTaskInput, fallbackZone: string): WarmupTaskInput {
  const { trigger } = input;
  let cleanedTrigger: WarmupTrigger;
  if (trigger.kind === 'window') {
    cleanedTrigger = { kind: 'window', window: trigger.window || 'five_hour' };
  } else if (trigger.kind === 'daily') {
    cleanedTrigger = {
      kind: 'daily',
      time: trigger.time || '08:55',
      time_zone: trigger.time_zone?.trim() || fallbackZone || 'UTC',
    };
  } else {
    cleanedTrigger = {
      kind: 'every',
      hours: trigger.hours ?? 5,
      anchor: trigger.anchor || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }
  return {
    ...input,
    name: input.name.trim(),
    model: input.model.trim(),
    trigger: cleanedTrigger,
  };
}

function TaskEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  catalog,
  fixedAccount,
  isSaving,
}: {
  draft: WarmupTaskInput;
  onChange: (next: WarmupTaskInput) => void;
  onSave: () => void;
  onCancel: () => void;
  catalog?: WarmupCatalog;
  fixedAccount?: WarmupCatalogAccount;
  isSaving?: boolean;
}) {
  const t = useT();
  const timezone = catalog?.timezone || 'UTC';
  const providers = catalog?.providers ?? [];
  const currentProviderGroup = providers.find((p) => p.provider === draft.provider) ?? providers[0];
  const accounts = currentProviderGroup?.accounts ?? [];
  const selectedAccount = fixedAccount ?? findAccount(catalog, draft.provider, draft.auth_index, draft.account) ?? accounts[0];
  const autoModel = selectedAccount?.auto_model || resolveTaskModel({ model: '' }, selectedAccount);
  const sortedModels = sortModelsForAuto(selectedAccount?.models ?? []);
  const modelOptions = [
    {
      value: '',
      label: autoModel ? t('warmup.model_auto', { model: autoModel }) : t('warmup.model_auto_fallback'),
    },
    ...sortedModels.map((m) => ({ value: m, label: m })),
    ...(draft.model && !sortedModels.includes(draft.model) ? [{ value: draft.model, label: draft.model }] : []),
  ];
  const windowOptions = (selectedAccount?.windows.length
    ? selectedAccount.windows
    : [
        { id: 'five_hour', label: '5h', used_percent: null },
        { id: draft.provider === 'codex' ? 'weekly' : 'seven_day', label: '7d', used_percent: null },
      ]
  ).map((w) => ({ value: w.id, label: w.label || w.id }));

  const disabled = isSaving || isDemoMode();

  return (
    <div className={styles['task-editor']} data-testid="warmup-task-editor">
      <label className={styles['field']}>
        <Text>{t('warmup.task_name')}</Text>
        <Input
          aria-label={t('warmup.task_name')}
          value={draft.name}
          placeholder={t('warmup.task_name_placeholder')}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>

      {!fixedAccount && (
        <div className={styles['field-row']}>
          <label className={styles['field']}>
            <Text>{t('warmup.provider')}</Text>
            <Segmented
              aria-label={t('warmup.provider')}
              value={draft.provider}
              disabled={disabled}
              options={(providers.length ? providers.map((p) => p.provider) : ['codex', 'claude']).map((p) => ({
                value: p,
                label: p === 'codex' ? 'Codex' : p === 'claude' ? 'Claude' : p,
              }))}
              onChange={(val) => {
                const nextProvider = String(val);
                const nextGroup = providers.find((p) => p.provider === nextProvider);
                const firstAcc = nextGroup?.accounts[0];
                onChange({
                  ...draft,
                  provider: nextProvider,
                  auth_index: firstAcc?.auth_index ?? '',
                  account: firstAcc?.name ?? '',
                  model: '',
                  trigger: {
                    ...draft.trigger,
                    window: firstAcc?.windows[0]?.id ?? 'five_hour',
                  },
                });
              }}
            />
          </label>
          <label className={styles['field']}>
            <Text>{t('warmup.credential')}</Text>
            <SearchSelect
              label={t('warmup.credential')}
              value={draft.auth_index || undefined}
              disabled={disabled}
              options={accounts.map((acc) => ({
                value: acc.auth_index,
                label: acc.email ? `${acc.name} (${acc.email})` : acc.name,
              }))}
              onChange={(authIndex: string) => {
                const acc = accounts.find((a) => a.auth_index === authIndex);
                onChange({
                  ...draft,
                  auth_index: authIndex,
                  account: acc?.name ?? authIndex,
                  model: '',
                  trigger: {
                    ...draft.trigger,
                    window: acc?.windows[0]?.id ?? draft.trigger.window ?? 'five_hour',
                  },
                });
              }}
            />
          </label>
        </div>
      )}

      <label className={styles['field']}>
        <Text>{t('warmup.model')}</Text>
        <SearchSelect
          label={t('warmup.model')}
          value={draft.model}
          disabled={disabled}
          showSearch={{ optionFilterProp: 'label' }}
          options={modelOptions}
          onChange={(model: string) => onChange({ ...draft, model: model ?? '' })}
        />
      </label>

      <div className={styles['field']}>
        <Text>{t('warmup.trigger')}</Text>
        <Segmented
          aria-label={t('warmup.trigger')}
          value={draft.trigger.kind}
          disabled={disabled}
          options={[
            { value: 'window', label: t('warmup.trigger_window') },
            { value: 'daily', label: t('warmup.trigger_daily') },
            { value: 'every', label: t('warmup.trigger_every') },
          ]}
          onChange={(kind) =>
            onChange({
              ...draft,
              trigger: {
                ...draft.trigger,
                kind: kind as WarmupTrigger['kind'],
                window: draft.trigger.window || windowOptions[0]?.value || 'five_hour',
                time: draft.trigger.time || '08:55',
                time_zone: draft.trigger.time_zone || timezone,
                hours: draft.trigger.hours || 5,
                anchor: draft.trigger.anchor || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
              },
            })
          }
        />
      </div>

      {draft.trigger.kind === 'window' && (
        <div className={styles['field']}>
          <Text>{t('warmup.window_select')}</Text>
          <Segmented
            size="small"
            aria-label={t('warmup.window_select')}
            value={draft.trigger.window || windowOptions[0]?.value || 'five_hour'}
            disabled={disabled}
            options={windowOptions}
            onChange={(win) =>
              onChange({
                ...draft,
                trigger: { ...draft.trigger, window: String(win) },
              })
            }
          />
        </div>
      )}

      {draft.trigger.kind === 'daily' && (
        <div className={styles['field-row']}>
          <label className={styles['field']}>
            <Text>{t('warmup.daily_time')}</Text>
            <Input
              type="time"
              aria-label={t('warmup.daily_time')}
              value={draft.trigger.time ?? '08:55'}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...draft,
                  trigger: { ...draft.trigger, time: e.target.value },
                })
              }
            />
          </label>
          <label className={styles['field']}>
            <Text>{t('warmup.time_zone')}</Text>
            <Input
              aria-label={t('warmup.time_zone')}
              value={draft.trigger.time_zone ?? timezone}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...draft,
                  trigger: { ...draft.trigger, time_zone: e.target.value },
                })
              }
            />
          </label>
        </div>
      )}

      {draft.trigger.kind === 'every' && (
        <label className={styles['field']}>
          <Text>{t('warmup.every_hours')}</Text>
          <NumberInput
            aria-label={t('warmup.every_hours')}
            min={1}
            max={168}
            precision={0}
            value={draft.trigger.hours ?? 5}
            disabled={disabled}
            onChange={(val) =>
              onChange({
                ...draft,
                trigger: {
                  ...draft.trigger,
                  hours: typeof val === 'number' ? val : 5,
                },
              })
            }
          />
        </label>
      )}

      <div className={styles['actions']}>
        <Button size="small" onClick={onCancel} disabled={isSaving}>
          {t('common.cancel')}
        </Button>
        <Button
          size="small"
          type="primary"
          onClick={onSave}
          loading={isSaving}
          disabled={!canSaveWarmupTask(draft) || isDemoMode()}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

function WarmupWorkspace({
  state,
  fixedAuthIndex,
  onDirtyChange,
}: {
  state: WarmupStateView;
  fixedAuthIndex?: string;
  onDirtyChange?: (isDirty: boolean) => void;
}) {
  const t = useT();
  const locale = languageLocale(useI18n().lang);
  const { modal } = App.useApp();
  const toast = useToast();
  const queryClient = useQueryClient();

  const catalog = state.catalog;
  const timezone = catalog?.timezone || 'UTC';
  const fixedAccount = fixedAuthIndex ? findAccountByAuthIndex(catalog, fixedAuthIndex) : undefined;

  const tasks = React.useMemo(
    () =>
      fixedAuthIndex
        ? state.tasks.filter(
            (task) => task.auth_index === fixedAuthIndex || (fixedAccount && task.account === fixedAccount.name),
          )
        : state.tasks,
    [fixedAccount, fixedAuthIndex, state.tasks],
  );

  const runs = React.useMemo(
    () =>
      fixedAuthIndex
        ? state.runs.filter(
            (run) => run.auth_index === fixedAuthIndex || (fixedAccount && run.account === fixedAccount.name),
          )
        : state.runs,
    [fixedAccount, fixedAuthIndex, state.runs],
  );

  const [editing, setEditing] = React.useState<{ id: string | null; draft: WarmupTaskInput } | null>(null);
  const [runningTaskId, setRunningTaskId] = React.useState<string | null>(null);

  const isDirty = editing !== null;
  React.useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  const applyState = React.useCallback(
    (nextState: WarmupStateView) => {
      queryClient.setQueryData<WarmupStateView>(['quota-warmup-settings'], nextState);
    },
    [queryClient],
  );

  const saveMutation = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: WarmupTaskInput }) => {
      const payload = cleanTriggerPayload(input, timezone);
      return id ? api.updateWarmupTask(id, payload) : api.createWarmupTask(payload);
    },
    onSuccess: (nextState) => {
      applyState(nextState);
      setEditing(null);
      toast.success(t('warmup.saved'));
    },
    onError: () => toast.error(t('warmup.load_failed')),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ task, enabled }: { task: WarmupTask; enabled: boolean }) =>
      api.updateWarmupTask(task.id, cleanTriggerPayload({ ...taskToInput(task, timezone), enabled }, timezone)),
    onSuccess: (nextState) => {
      applyState(nextState);
    },
    onError: () => toast.error(t('warmup.load_failed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteWarmupTask(id),
    onSuccess: (nextState) => {
      applyState(nextState);
      toast.success(t('warmup.deleted'));
    },
    onError: () => toast.error(t('warmup.load_failed')),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => {
      setRunningTaskId(id);
      return api.runWarmupTask(id);
    },
    onSuccess: (resp) => {
      setRunningTaskId(null);
      applyState(resp.state);
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      const title = t(OUTCOME_KEYS[resp.run.outcome]);
      const detail = resp.run.message || undefined;
      if (resp.run.outcome === 'ok') toast.success(title);
      else if (resp.run.outcome === 'failed') toast.error(title, { detail });
      else toast.warning(title, { detail });
    },
    onError: () => {
      setRunningTaskId(null);
      toast.error(t('warmup.load_failed'));
    },
  });

  const startCreate = () => {
    const defaultAcc =
      fixedAccount
      ?? catalog?.providers.find((p) => p.accounts.length > 0)?.accounts[0];
    const initial = defaultWarmupTaskInput(defaultAcc, timezone);
    if (fixedAuthIndex && !initial.auth_index) {
      initial.auth_index = fixedAuthIndex;
      initial.account = fixedAccount?.name ?? fixedAuthIndex;
      initial.provider = fixedAccount?.provider ?? 'claude';
    }
    setEditing({ id: null, draft: initial });
  };

  const enabledCount = tasks.filter((task) => task.enabled).length;
  const earliestNext = React.useMemo(() => {
    const candidates = tasks
      .map((task) => state.next[task.id])
      .filter((iso): iso is string => Boolean(iso))
      .sort();
    return candidates[0] ?? null;
  }, [state.next, tasks]);

  return (
    <div className={styles['warmup-section']}>
      <div className={styles['summary-bar']} data-testid="warmup-status">
        <div className={styles['summary-stat']}>
          <StatusLabel tone={enabledCount > 0 ? 'success' : 'neutral'}>
            {t('warmup.summary_enabled', { enabled: enabledCount, total: tasks.length })}
          </StatusLabel>
          {earliestNext && (
            <Text type="secondary" className={styles['summary-next']}>
              {t('warmup.row_next')}: {formatISOInstant(earliestNext, timezone, locale)}
            </Text>
          )}
        </div>
        <Button
          size="small"
          type="primary"
          onClick={startCreate}
          disabled={Boolean(editing) || isDemoMode()}
          data-testid="warmup-add-task"
        >
          {t('warmup.add_task')}
        </Button>
      </div>

      {editing && editing.id === null && (
        <TaskEditor
          draft={editing.draft}
          onChange={(draft) => setEditing({ id: null, draft })}
          onSave={() => saveMutation.mutate({ id: null, input: editing.draft })}
          onCancel={() => setEditing(null)}
          catalog={catalog}
          fixedAccount={fixedAccount}
          isSaving={saveMutation.isPending}
        />
      )}

      {tasks.length === 0 && (!editing || editing.id !== null) ? (
        <div className={styles['empty-box']}>
          <Text type="secondary">{t('warmup.empty_tasks')}</Text>
        </div>
      ) : (
        <div className={styles['task-list']}>
          {tasks.map((task) => {
            if (editing?.id === task.id) {
              return (
                <TaskEditor
                  key={task.id}
                  draft={editing.draft}
                  onChange={(draft) => setEditing({ id: task.id, draft })}
                  onSave={() => saveMutation.mutate({ id: task.id, input: editing.draft })}
                  onCancel={() => setEditing(null)}
                  catalog={catalog}
                  fixedAccount={fixedAccount}
                  isSaving={saveMutation.isPending}
                />
              );
            }
            const acc = findAccount(catalog, task.provider, task.auth_index, task.account);
            const resolvedModel = resolveTaskModel(task, acc);
            const modelText = task.model
              ? task.model
              : resolvedModel
                ? t('warmup.model_auto', { model: resolvedModel })
                : t('warmup.model_auto_fallback');
            const nextISO = state.next[task.id];
            const nextLabel = nextISO
              ? formatISOInstant(nextISO, timezone, locale)
              : task.enabled && task.trigger.kind === 'window'
                ? t('warmup.next_waiting')
                : '';

            return (
              <div key={task.id} className={styles['task-card']} data-testid={`warmup-task-${task.id}`}>
                <div className={styles['task-card-head']}>
                  <div className={styles['task-title-group']}>
                    <Switch
                      aria-label={task.name}
                      checked={task.enabled}
                      disabled={toggleMutation.isPending || isDemoMode()}
                      onChange={(enabled) => toggleMutation.mutate({ task, enabled })}
                    />
                    <div className={styles['task-title-copy']}>
                      <span className={styles['task-name']}>{task.name}</span>
                      <span className={styles['task-sub']}>
                        {!fixedAuthIndex && `${task.account || task.auth_index} · `}
                        {describeTrigger(task.trigger, acc, timezone, t)} · {modelText}
                      </span>
                    </div>
                  </div>
                  <Space size={6} wrap>
                    <Button
                      size="small"
                      onClick={() => runMutation.mutate(task.id)}
                      loading={runningTaskId === task.id}
                      disabled={isDemoMode() || Boolean(runningTaskId)}
                    >
                      {t('warmup.run')}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => setEditing({ id: task.id, draft: taskToInput(task, timezone) })}
                      disabled={Boolean(editing) || isDemoMode()}
                    >
                      {t('warmup.edit_task')}
                    </Button>
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: t('warmup.confirm_delete'),
                          okText: t('warmup.delete_task'),
                          cancelText: t('common.cancel'),
                          onOk: () => deleteMutation.mutateAsync(task.id),
                        })
                      }
                      disabled={deleteMutation.isPending || isDemoMode()}
                    >
                      {t('warmup.delete_task')}
                    </Button>
                  </Space>
                </div>
                {task.enabled && nextLabel && (
                  <div className={styles['task-next-line']}>
                    <Text type="secondary">
                      {t('warmup.row_next')}: {nextLabel}
                    </Text>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className={styles['runs-block']}>
        <SectionHeading level="label" as="h4" title={t('warmup.history')} />
        {runs.length === 0 ? (
          <Text type="secondary" className={styles['rule-hint']}>
            {t('warmup.empty_runs')}
          </Text>
        ) : (
          <div className={styles['run-list']} data-testid="warmup-last-result">
            {runs.slice(0, 10).map((run) => (
              <div key={run.id} className={styles['run-row']}>
                <div className={styles['run-main']}>
                  <StatusLabel tone={outcomeTone(run.outcome)}>
                    {t(OUTCOME_KEYS[run.outcome] ?? 'warmup.outcome_unknown')}
                  </StatusLabel>
                  <span className={styles['run-meta']}>
                    {formatISOInstant(run.at, timezone, locale)} · {t(SOURCE_KEYS[run.source] ?? 'warmup.source_manual')} · {run.model}
                    {typeof run.ms === 'number' ? ` · ${run.ms}ms` : ''}
                  </span>
                </div>
                {run.message && <span className={styles['run-message']}>{run.message}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function WarmupSettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [isDirty, setIsDirty] = React.useState(false);
  const { modal } = App.useApp();
  const settingsQuery = useQuery({
    queryKey: ['quota-warmup-settings'],
    queryFn: api.getWarmupSettings,
    enabled: open,
    retry: false,
    refetchInterval: open ? 30_000 : false,
  });

  const attemptClose = React.useCallback(() => {
    if (!isDirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: t('af.unsaved_confirm_title'),
      content: t('af.unsaved_confirm_desc'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => {
        setIsDirty(false);
        onClose();
      },
    });
  }, [isDirty, modal, onClose, t]);

  return (
    <AppDrawer
      widthKey="warmup_settings"
      open={open}
      onClose={attemptClose}
      title={t('warmup.settings')}
      destroyOnHidden
    >
      {settingsQuery.isError ? (
        <LoadFailure
          title={t('warmup.load_failed')}
          error={t('warmup.load_failed')}
          onRetry={() => void settingsQuery.refetch()}
        />
      ) : settingsQuery.data ? (
        <div className={styles['warmup-section']}>
          <Text type="secondary">{t('warmup.description')}</Text>
          <WarmupWorkspace state={settingsQuery.data} onDirtyChange={setIsDirty} />
        </div>
      ) : (
        <Text>{t('common.loading')}</Text>
      )}
    </AppDrawer>
  );
}

export function CredentialWarmup({
  authIndex,
  onDirtyChange,
}: {
  authIndex: string;
  onDirtyChange?: (isDirty: boolean) => void;
}) {
  const t = useT();
  const settingsQuery = useQuery({
    queryKey: ['quota-warmup-settings'],
    queryFn: api.getWarmupSettings,
    retry: false,
    refetchInterval: 30_000,
  });

  return (
    <section className={styles['warmup-section']} data-testid="credential-warmup">
      <SectionHeading
        className={styles['warmup-heading']}
        title={t('warmup.title')}
        description={t('warmup.description')}
      />
      {settingsQuery.isError ? (
        <LoadFailure
          title={t('warmup.load_failed')}
          error={t('warmup.load_failed')}
          onRetry={() => void settingsQuery.refetch()}
        />
      ) : settingsQuery.data ? (
        <WarmupWorkspace
          state={settingsQuery.data}
          fixedAuthIndex={authIndex}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <Text>{t('common.loading')}</Text>
      )}
    </section>
  );
}
