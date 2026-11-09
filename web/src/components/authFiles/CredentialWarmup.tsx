import type { MessageKey } from '../../i18n/catalog';
import React from 'react';
import { Button, Input, Segmented } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '../../api/client';
import { useI18n, useT, type TFunc } from '../../i18n';
import { languageLocale } from '../../i18n/language';
import { isDemoMode } from '../../types/demoMode';
import { formatEventDuration } from '../../types/usageEventMetrics';
import { credentialBrandIdentity } from '../../types/credentialIdentity';
import { usePluginMultiPortalKeys, usePluginOAuthLogos, usePluginOAuthTitles } from '../../hooks/usePluginOAuthLogos';
import {
  canSaveWarmupTask,
  defaultWarmupTaskInput,
  groupWarmupAccounts,
  hasCustomTaskName,
  resolveTaskModel,
  type WarmupCatalog,
  type WarmupCatalogAccount,
  type WarmupRun,
  type WarmupStateView,
  type WarmupTask,
  type WarmupTaskInput,
  type WarmupTrigger,
} from '../../types/warmup';
import { AppDrawer } from '../common/AppDrawer';
import { AppModal } from '../common/AppModal';
import { ConfirmAction } from '../common/ConfirmAction';
import { EmptyState } from '../common/EmptyState';
import { NumberInput } from '../common/NumberInput';
import { ListPlaceholder } from '../common/Placeholder';
import { SearchSelect } from '../common/SearchSelect';
import { SectionHeading } from '../common/SectionHeading';
import { StatusLabel, type StatusTone } from '../common/StatusLabel';
import { Switch } from '../common/Switch';
import { TimeZoneSelect } from '../common/TimeZoneSelect';
import { ToolButton } from '../common/ToolButton';
import { ClearOutlined, DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined } from '../icons';
import { CredentialMark } from '../LobeIcon';
import { LoadFailure, useToast } from '../feedback';
import styles from './CredentialWarmup.module.css';

const WARMUP_QUERY_KEY = ['quota-warmup-settings'] as const;
const RUNS_PREVIEW = 6;

const OUTCOME_KEYS: Record<WarmupRun['outcome'], MessageKey> = {
  ok: 'warmup.outcome_ok',
  failed: 'warmup.outcome_failed',
  unknown: 'warmup.outcome_unknown',
  running: 'warmup.outcome_running',
};

const OUTCOME_TONES: Record<WarmupRun['outcome'], StatusTone> = {
  ok: 'success',
  failed: 'danger',
  unknown: 'warn',
  running: 'accent',
};

const SOURCE_KEYS: Record<WarmupRun['source'], MessageKey> = {
  schedule: 'warmup.source_schedule',
  catchup: 'warmup.source_catchup',
  manual: 'warmup.source_manual',
};

const WINDOW_KEYS: Record<string, MessageKey> = {
  five_hour: 'warmup.window_five_hour',
  weekly: 'warmup.window_weekly',
  seven_day: 'warmup.window_weekly',
};

const nowISO = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function formatInstant(iso: string | null | undefined, timeZone: string, locale: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timeZone || 'UTC' }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(ms);
  }
}

function catalogAccounts(catalog: WarmupCatalog | undefined): WarmupCatalogAccount[] {
  return catalog?.providers.flatMap((group) => group.accounts) ?? [];
}

function findAccount(catalog: WarmupCatalog | undefined, task: Pick<WarmupTask, 'auth_index' | 'account'>): WarmupCatalogAccount | undefined {
  const accounts = catalogAccounts(catalog);
  return (task.auth_index ? accounts.find((acc) => acc.auth_index === task.auth_index) : undefined)
    ?? (task.account ? accounts.find((acc) => acc.name === task.account) : undefined);
}

function accountLabel(account: WarmupCatalogAccount | undefined, task: Pick<WarmupTask, 'account' | 'auth_index'>): string {
  return account?.email || account?.name || task.account || task.auth_index;
}

function windowLabel(id: string | undefined, account: WarmupCatalogAccount | undefined, t: TFunc): string {
  const key = id ? WINDOW_KEYS[id] : undefined;
  if (key) return t(key);
  return account?.windows.find((w) => w.id === id)?.label || id || '';
}

function describeTrigger(trigger: WarmupTrigger, account: WarmupCatalogAccount | undefined, fallbackZone: string, t: TFunc): string {
  switch (trigger.kind) {
    case 'window':
      return t('warmup.summary_window', { window: windowLabel(trigger.window, account, t) });
    case 'daily':
      return t('warmup.summary_daily', { time: trigger.time ?? '08:55', zone: trigger.time_zone || fallbackZone || 'UTC' });
    case 'every':
      return t('warmup.summary_every', { hours: trigger.hours ?? 5 });
  }
}

function describeModel(task: Pick<WarmupTaskInput, 'model'>, account: WarmupCatalogAccount | undefined, t: TFunc): string {
  if (task.model.trim()) return task.model.trim();
  const auto = resolveTaskModel(task, account);
  return auto ? t('warmup.model_auto', { model: auto }) : t('warmup.model_auto_fallback');
}

function taskToInput(task: WarmupTask, fallbackZone: string): WarmupTaskInput {
  return {
    // A frozen server-made name is not the operator's: editing starts unnamed so it follows the new choices.
    name: hasCustomTaskName(task) ? task.name : '',
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
      anchor: task.trigger.anchor || task.created_at || nowISO(),
    },
  };
}

/** The editor keeps every trigger kind's values while the reader switches; only the chosen kind is sent. */
function toPayload(input: WarmupTaskInput, fallbackZone: string): WarmupTaskInput {
  const { trigger } = input;
  const cleaned: WarmupTrigger = trigger.kind === 'window'
    ? { kind: 'window', window: trigger.window || 'five_hour' }
    : trigger.kind === 'daily'
      ? { kind: 'daily', time: trigger.time || '08:55', time_zone: trigger.time_zone?.trim() || fallbackZone || 'UTC' }
      : { kind: 'every', hours: trigger.hours ?? 5, anchor: trigger.anchor || nowISO() };
  return { ...input, name: input.name.trim(), model: input.model.trim(), trigger: cleaned };
}

function TaskEditorModal({
  editing,
  catalog,
  isSaving,
  onChange,
  onSave,
  onCancel,
}: {
  editing: { id: string | null; draft: WarmupTaskInput } | null;
  catalog?: WarmupCatalog;
  isSaving: boolean;
  onChange: (next: WarmupTaskInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const timezone = catalog?.timezone || 'UTC';
  const accounts = catalogAccounts(catalog);
  const pluginLogos = usePluginOAuthLogos();
  const pluginTitles = usePluginOAuthTitles();
  const multiPortalKeys = usePluginMultiPortalKeys();
  const draft = editing?.draft;
  const account = draft ? findAccount(catalog, draft) : undefined;
  const isDisabled = isSaving || isDemoMode();

  if (!draft) return <AppModal open={false} title="" onCancel={onCancel} />;

  const set = (patch: Partial<WarmupTaskInput>) => onChange({ ...draft, ...patch });
  const setTrigger = (patch: Partial<WarmupTrigger>) => onChange({ ...draft, trigger: { ...draft.trigger, ...patch } });

  const models = account?.models ?? [];
  const autoModel = resolveTaskModel({ model: '' }, account);
  const modelOptions = [
    { value: '', label: autoModel ? t('warmup.model_auto', { model: autoModel }) : t('warmup.model_auto_fallback') },
    ...models.map((m) => ({ value: m, label: m })),
    ...(draft.model && !models.includes(draft.model) ? [{ value: draft.model, label: draft.model }] : []),
  ];
  const windows = account?.windows.length
    ? account.windows.map((w) => w.id)
    : ['five_hour', draft.provider === 'codex' ? 'weekly' : 'seven_day'];
  // The picker groups credentials by provider, with the connector that issued each one drawn on
  // its row: a plugin that declares several portals shows which one a credential belongs to.
  const credentialOptions = groupWarmupAccounts(catalog, pluginTitles).map((group) => ({
    label: group.label,
    options: group.accounts.map((acc) => ({
      value: acc.auth_index,
      disabled: acc.disabled,
      search: `${acc.email ?? ''} ${acc.name} ${acc.provider} ${acc.oauth_provider ?? ''}`,
      label: (
        <span className={styles['credential-option']}>
          <CredentialMark
            credential={credentialBrandIdentity(acc.provider, acc, multiPortalKeys)}
            pluginLogos={pluginLogos}
            size={16}
          />
          <span className={styles['credential-option-name']}>{acc.email || acc.name}</span>
        </span>
      ),
    })),
  }));

  return (
    <AppModal
      open
      size="medium"
      title={t(editing?.id ? 'warmup.edit_task_title' : 'warmup.add_task_title')}
      onCancel={onCancel}
      isDismissible={!isSaving}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={isSaving}>{t('common.cancel')}</Button>,
        <Button key="save" type="primary" onClick={onSave} loading={isSaving} disabled={!canSaveWarmupTask(draft) || isDemoMode()}>
          {t('common.save')}
        </Button>,
      ]}
    >
      <div className={styles['form']} data-testid="warmup-task-editor">
        <label className={styles['field']}>
          <span className={styles['field-label']}>{t('warmup.credential')}</span>
          <SearchSelect
            label={t('warmup.credential')}
            value={draft.auth_index || undefined}
            disabled={isDisabled}
            showSearch={{ optionFilterProp: 'search' }}
            classNames={{ popup: { root: styles['credential-picker'] } }}
            options={credentialOptions}
            onChange={(authIndex: string) => {
              const next = accounts.find((acc) => acc.auth_index === authIndex);
              onChange({
                ...draft,
                provider: next?.provider ?? draft.provider,
                auth_index: authIndex,
                account: next?.name ?? authIndex,
                model: '',
                trigger: { ...draft.trigger, window: next?.windows[0]?.id ?? draft.trigger.window ?? 'five_hour' },
              });
            }}
          />
        </label>

        <div className={styles['field']}>
          <span className={styles['field-label']}>{t('warmup.trigger')}</span>
          <Segmented
            block
            aria-label={t('warmup.trigger')}
            value={draft.trigger.kind}
            disabled={isDisabled}
            options={[
              { value: 'window', label: t('warmup.trigger_window') },
              { value: 'daily', label: t('warmup.trigger_daily') },
              { value: 'every', label: t('warmup.trigger_every') },
            ]}
            onChange={(kind) => setTrigger({
              kind: kind as WarmupTrigger['kind'],
              window: windows.includes(draft.trigger.window ?? '') ? draft.trigger.window : windows[0],
            })}
          />
        </div>

        {draft.trigger.kind === 'window' && (
          <div className={styles['field']}>
            <span className={styles['field-label']}>{t('warmup.window_select')}</span>
            {/* A window's label is the provider's own, such as "Gemini Models · 5小时限制", so the
                options do not fit one row at any dialog width: laid out as a row each one was
                truncated to its middle, which left two families' five-hour windows reading alike. */}
            <Segmented
              block
              vertical
              classNames={{ label: styles['window-option-label'] }}
              aria-label={t('warmup.window_select')}
              value={draft.trigger.window || windows[0]}
              disabled={isDisabled}
              options={windows.map((id) => ({ value: id, label: windowLabel(id, account, t) }))}
              onChange={(win) => setTrigger({ window: String(win) })}
            />
          </div>
        )}

        {draft.trigger.kind === 'daily' && (
          <div className={styles['field-pair']}>
            <label className={styles['field']}>
              <span className={styles['field-label']}>{t('warmup.daily_time')}</span>
              <Input
                type="time"
                aria-label={t('warmup.daily_time')}
                value={draft.trigger.time ?? '08:55'}
                disabled={isDisabled}
                onChange={(e) => setTrigger({ time: e.target.value })}
              />
            </label>
            <div className={styles['field']}>
              <span className={styles['field-label']}>{t('warmup.time_zone')}</span>
              <TimeZoneSelect
                aria-label={t('warmup.time_zone')}
                value={draft.trigger.time_zone || timezone}
                serverTimezone={timezone}
                isDisabled={isDisabled}
                onChange={(zone) => setTrigger({ time_zone: zone || timezone })}
              />
            </div>
          </div>
        )}

        {draft.trigger.kind === 'every' && (
          <label className={styles['field']}>
            <span className={styles['field-label']}>{t('warmup.every_hours')}</span>
            <NumberInput
              aria-label={t('warmup.every_hours')}
              min={1}
              max={168}
              precision={0}
              suffix={t('warmup.hours_unit')}
              value={draft.trigger.hours ?? 5}
              disabled={isDisabled}
              onChange={(val) => setTrigger({ hours: typeof val === 'number' ? val : 5 })}
            />
          </label>
        )}

        <label className={styles['field']}>
          <span className={styles['field-label']}>{t('warmup.model')}</span>
          <SearchSelect
            label={t('warmup.model')}
            value={draft.model}
            disabled={isDisabled}
            showSearch={{ optionFilterProp: 'label' }}
            options={modelOptions}
            onChange={(model: string) => set({ model: model ?? '' })}
          />
        </label>

        <label className={styles['field']}>
          <span className={styles['field-label']}>{t('warmup.task_name')}</span>
          <Input
            aria-label={t('warmup.task_name')}
            value={draft.name}
            maxLength={120}
            placeholder={`${accountLabel(account, draft)} · ${describeTrigger(draft.trigger, account, timezone, t)}`}
            disabled={isDisabled}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
      </div>
    </AppModal>
  );
}

interface TaskView {
  task: WarmupTask;
  account?: WarmupCatalogAccount;
  title: string;
  meta: string[];
}

function useTaskViews(state: WarmupStateView, tasks: WarmupTask[]): Map<string, TaskView> {
  const t = useT();
  const timezone = state.catalog?.timezone || 'UTC';
  return React.useMemo(() => new Map(tasks.map((task) => {
    const account = findAccount(state.catalog, task);
    const who = accountLabel(account, task);
    const when = describeTrigger(task.trigger, account, timezone, t);
    const isNamed = hasCustomTaskName(task);
    const title = isNamed ? task.name : who;
    const meta = [
      title === when ? null : when,
      describeModel(task, account, t),
    ].filter((part): part is string => Boolean(part));
    return [task.id, { task, account, title, meta }];
  })), [state.catalog, t, tasks, timezone]);
}

function WarmupWorkspace({ state }: { state: WarmupStateView }) {
  const t = useT();
  const locale = languageLocale(useI18n().lang);
  const toast = useToast();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();

  const catalog = state.catalog;
  const timezone = catalog?.timezone || 'UTC';
  const tasks = state.tasks;
  const runs = state.runs;
  const views = useTaskViews(state, tasks);

  const [editing, setEditing] = React.useState<{ id: string | null; draft: WarmupTaskInput } | null>(null);
  const [isShowingAllRuns, setIsShowingAllRuns] = React.useState(false);

  const applyState = (next: WarmupStateView) => queryClient.setQueryData<WarmupStateView>(WARMUP_QUERY_KEY, next);
  const reportFailure = (titleKey: MessageKey) => (err: unknown) => toast.error(t(titleKey), { detail: describeError(err) });

  // The editor renders inside the task list, so a task deleted by another tab, the Agent or an MCP
  // client would leave its draft invisible while it kept every other row uneditable.
  React.useEffect(() => {
    if (editing?.id && !tasks.some((task) => task.id === editing.id)) setEditing(null);
  }, [editing, tasks]);

  const saveMutation = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: WarmupTaskInput }) => {
      const payload = toPayload(input, timezone);
      return id ? api.updateWarmupTask(id, payload) : api.createWarmupTask(payload);
    },
    onSuccess: (next) => {
      applyState(next);
      setEditing(null);
      toast.success(t('warmup.saved'));
    },
    onError: reportFailure('warmup.save_failed'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ task, enabled }: { task: WarmupTask; enabled: boolean }) =>
      api.updateWarmupTask(task.id, toPayload({ ...taskToInput(task, timezone), name: task.name, enabled }, timezone)),
    onSuccess: applyState,
    onError: reportFailure('warmup.update_failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteWarmupTask(id),
    onSuccess: (next) => {
      applyState(next);
      toast.success(t('warmup.deleted'));
    },
    onError: reportFailure('warmup.delete_failed'),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => api.runWarmupTask(id),
    onSuccess: (resp) => {
      applyState(resp.state);
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      const title = t(OUTCOME_KEYS[resp.run.outcome]);
      const detail = resp.run.message || undefined;
      if (resp.run.outcome === 'ok') toast.success(title);
      else if (resp.run.outcome === 'failed') toast.error(title, { detail });
      else toast.warning(title, { detail });
    },
    onError: reportFailure('warmup.run_failed'),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearWarmupRuns([]),
    onSuccess: (next) => {
      applyState(next);
      setIsShowingAllRuns(false);
      toast.success(t('warmup.history_cleared'));
    },
    onError: reportFailure('warmup.clear_failed'),
  });

  const startCreate = () => {
    setEditing({ id: null, draft: defaultWarmupTaskInput(catalog) });
  };

  const nextLabel = (task: WarmupTask): string => {
    if (!task.enabled) return t('warmup.paused');
    const iso = state.next[task.id];
    if (iso) return t('warmup.row_next', { time: formatInstant(iso, timezone, locale) });
    return task.trigger.kind === 'window' ? t('warmup.next_waiting') : '';
  };

  // Deleting a task deletes its runs, so a run's task is normally still listed.
  const runTitle = (run: WarmupRun): string => views.get(run.task_id)?.title ?? (run.account || run.auth_index);

  const shownRuns = isShowingAllRuns ? runs : runs.slice(0, RUNS_PREVIEW);
  const canClearRuns = runs.length > 0 && !isDemo;

  return (
    <div className={styles['workspace']}>
      <section className={styles['block']}>
        <SectionHeading
          level="label"
          as="h4"
          title={t('warmup.tasks')}
          count={tasks.length || undefined}
          extra={(
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={startCreate} disabled={isDemo} data-testid="warmup-add-task">
              {t('warmup.add_task')}
            </Button>
          )}
        />
        {tasks.length === 0 ? (
          <EmptyState size="compact" title={t('warmup.empty_tasks')} className={styles['empty']} />
        ) : (
          <ul className={styles['list']} data-testid="warmup-status">
            {tasks.map((task) => {
              const view = views.get(task.id)!;
              const next = nextLabel(task);
              const isRunning = runMutation.isPending && runMutation.variables === task.id;
              return (
                <li key={task.id} className={styles['task-row']} data-enabled={task.enabled} data-testid={`warmup-task-${task.id}`}>
                  <CredentialMark className={styles['task-mark']} credential={{ provider: task.provider, hint: task.account }} size={20} />
                  <div className={styles['task-copy']}>
                    <span className={styles['task-title']} title={view.title}>{view.title}</span>
                    <span className={styles['task-meta']}>{view.meta.join(' · ')}</span>
                    {next && <span className={styles['task-next']}>{next}</span>}
                  </div>
                  <div className={styles['task-actions']}>
                    <ToolButton
                      size="small"
                      type="text"
                      icon={<PlayCircleOutlined />}
                      label={t('warmup.run')}
                      loading={isRunning}
                      disabled={isDemo || (runMutation.isPending && !isRunning)}
                      onClick={() => runMutation.mutate(task.id)}
                    />
                    <ToolButton
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      label={t('warmup.edit_task')}
                      disabled={isDemo}
                      onClick={() => setEditing({ id: task.id, draft: taskToInput(task, timezone) })}
                    />
                    <ConfirmAction
                      title={t('warmup.confirm_delete', { name: view.title })}
                      confirmLabel={t('warmup.delete_task')}
                      isDanger
                      isConfirming={deleteMutation.isPending && deleteMutation.variables === task.id}
                      tooltip={t('warmup.delete_task')}
                      onConfirm={() => deleteMutation.mutateAsync(task.id)}
                      disabled={isDemo || isRunning}
                    >
                      <Button size="small" type="text" icon={<DeleteOutlined />} aria-label={t('warmup.delete_task')} disabled={isDemo || isRunning} />
                    </ConfirmAction>
                    <Switch
                      size="small"
                      className={styles['task-switch']}
                      aria-label={view.title}
                      checked={task.enabled}
                      loading={toggleMutation.isPending && toggleMutation.variables?.task.id === task.id}
                      disabled={isDemo}
                      onChange={(enabled) => toggleMutation.mutate({ task, enabled })}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles['block']}>
        <SectionHeading
          level="label"
          as="h4"
          title={t('warmup.history')}
          count={runs.length || undefined}
          extra={canClearRuns && (
            <ConfirmAction
              title={t('warmup.confirm_clear_history', { count: runs.length })}
              confirmLabel={t('warmup.clear_history')}
              isDanger
              isConfirming={clearMutation.isPending}
              tooltip={t('warmup.clear_history')}
              onConfirm={() => clearMutation.mutateAsync()}
            >
              <Button size="small" type="text" icon={<ClearOutlined />} aria-label={t('warmup.clear_history')} data-testid="warmup-clear-runs" />
            </ConfirmAction>
          )}
        />
        {runs.length === 0 ? (
          <EmptyState size="compact" title={t('warmup.empty_runs')} className={styles['empty']} />
        ) : (
          <>
            <ul className={styles['list']} data-testid="warmup-last-result">
              {shownRuns.map((run) => {
                const meta = [
                  t(SOURCE_KEYS[run.source] ?? 'warmup.source_manual'),
                  run.model,
                  typeof run.ms === 'number' ? formatEventDuration(run.ms) : null,
                ].filter(Boolean).join(' · ');
                return (
                  <li key={run.id} className={styles['run-row']}>
                    <div className={styles['run-head']}>
                      <StatusLabel tone={OUTCOME_TONES[run.outcome] ?? 'warn'}>
                        {t(OUTCOME_KEYS[run.outcome] ?? 'warmup.outcome_unknown')}
                      </StatusLabel>
                      <span className={styles['run-task']}>{runTitle(run)}</span>
                      <time className={styles['run-time']} dateTime={run.at}>{formatInstant(run.at, timezone, locale)}</time>
                    </div>
                    <span className={styles['run-meta']}>{meta}</span>
                    {run.message && <span className={styles['run-message']}>{run.message}</span>}
                  </li>
                );
              })}
            </ul>
            {runs.length > RUNS_PREVIEW && !isShowingAllRuns && (
              <Button type="link" size="small" className={styles['more']} onClick={() => setIsShowingAllRuns(true)}>
                {t('warmup.show_all_runs', { count: runs.length })}
              </Button>
            )}
          </>
        )}
      </section>

      <TaskEditorModal
        editing={editing}
        catalog={catalog}
        isSaving={saveMutation.isPending}
        onChange={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
        onSave={() => editing && saveMutation.mutate({ id: editing.id, input: editing.draft })}
        onCancel={() => setEditing(null)}
      />
    </div>
  );
}

function WarmupBody({ isActive }: { isActive: boolean }) {
  const t = useT();
  const query = useQuery({
    queryKey: WARMUP_QUERY_KEY,
    queryFn: api.getWarmupSettings,
    enabled: isActive,
    retry: false,
    refetchInterval: isActive ? 30_000 : false,
  });
  // A failed background refresh keeps the last answer on screen, and with it a draft being edited.
  return (
    <div className={styles['body']}>
      <p className={styles['intro']}>{t('warmup.description')}</p>
      {query.data ? (
        <WarmupWorkspace state={query.data} />
      ) : query.isError ? (
        <LoadFailure title={t('warmup.load_failed')} error={describeError(query.error)} onRetry={() => void query.refetch()} />
      ) : (
        <ListPlaceholder rows={3} isFramed />
      )}
    </div>
  );
}

export function WarmupSettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <AppDrawer widthKey="warmup_settings" open={open} onClose={onClose} title={t('warmup.settings')} destroyOnHidden>
      <WarmupBody isActive={open} />
    </AppDrawer>
  );
}
