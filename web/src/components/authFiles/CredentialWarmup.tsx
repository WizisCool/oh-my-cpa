import React from 'react';
import { App, Button, Input, Segmented, Select, Space, Tabs, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useI18n, useT, type TFunc } from '../../i18n';
import { languageLocale } from '../../i18n/language';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { isDemoMode } from '../../types/demoMode';
import { canSaveWarmupPolicy, DEFAULT_WARMUP_POLICY, isWarmupPolicyEnabled, type WarmupPolicy, type WarmupResult, type WarmupSettings, type WarmupCredential } from '../../types/warmup';
import { AppDrawer } from '../common/AppDrawer';
import { SectionHeading } from '../common/SectionHeading';
import { StatusLabel, type StatusTone } from '../common/StatusLabel';
import { Switch } from '../common/Switch';
import { LoadFailure, useToast } from '../feedback';
import styles from './CredentialWarmup.module.css';

const { Text } = Typography;
const REASON_KEYS: Record<string, string> = {
  disabled: 'warmup.reason_disabled', model_required: 'warmup.reason_model_required',
  model_unavailable: 'warmup.reason_model_unavailable', quota_unknown: 'warmup.reason_quota_unknown',
  paid_usage_enabled: 'warmup.reason_paid_enabled', paid_usage_unknown: 'warmup.reason_paid_unknown',
  quota_exhausted: 'warmup.reason_exhausted', already_active: 'warmup.reason_active',
  waiting_daily: 'warmup.reason_waiting_daily', retry_wait: 'warmup.reason_retry',
  credential_disabled: 'warmup.reason_disabled_credential',
  credential_unavailable: 'warmup.reason_unavailable_credential', cooldown: 'warmup.reason_cooldown',
  outcome_unknown: 'warmup.reason_unknown', activation_pending: 'warmup.reason_pending',
  activation_unconfirmed: 'warmup.reason_unconfirmed', protocol_unsupported: 'warmup.reason_unsupported',
  needs_reauth: 'warmup.reason_reauth', rate_limited: 'warmup.reason_rate_limited',
  already_attempted: 'warmup.reason_attempted', resource_conflict: 'warmup.reason_conflict',
  unexpected_tool: 'warmup.reason_unsupported',
};
// Reasons that stop automatic warmup until the operator or the provider changes something.
const PAUSING_REASONS = new Set(['model_required', 'model_unavailable', 'quota_unknown', 'paid_usage_enabled', 'paid_usage_unknown',
  'quota_exhausted', 'credential_disabled', 'credential_unavailable', 'cooldown', 'protocol_unsupported', 'unexpected_tool', 'needs_reauth']);

export function warmupReason(reason: string | undefined, t: TFunc): string {
  return reason ? t(REASON_KEYS[reason] ?? 'warmup.reason_unknown') : '';
}
function safeError(error: unknown, t: TFunc): string {
  const code = error instanceof ApiError ? error.message : '';
  return code in REASON_KEYS ? t(REASON_KEYS[code]) : t('warmup.load_failed');
}
function formatInstant(ms: number, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}
function addHours(clock: string, hours: number): string {
  const [hour, minute] = clock.split(':').map(Number);
  return `${String((hour + hours) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The rules a policy runs, each as one plain sentence; empty when nothing is automatic. */
function describePolicy(policy: WarmupPolicy, timezone: string, t: TFunc): string[] {
  const rules: string[] = [];
  if (policy.daily_enabled) rules.push(t('warmup.summary_daily', { time: policy.daily_time, zone: timezone }));
  if (policy.reset_mode !== 'off') rules.push(t(`warmup.summary_reset_${policy.reset_mode}`));
  return rules;
}

function RuleEditor({ policy, onChange, models, timezone, disabled }: {
  policy: WarmupPolicy; onChange: (policy: WarmupPolicy) => void; models: string[]; timezone: string; disabled?: boolean;
}) {
  const t = useT();
  const modelOptions = [...new Set([...models, ...(policy.model ? [policy.model] : [])])].sort((first, second) =>
    Number(!/haiku|mini/i.test(first)) - Number(!/haiku|mini/i.test(second)) || first.localeCompare(second));
  const isResetOn = policy.reset_mode !== 'off';
  return <div className={styles['rules']}>
    <div className={styles['rule']}>
      <Switch aria-label={t('warmup.rule_daily')} checked={policy.daily_enabled} disabled={disabled}
        onChange={daily_enabled => onChange({ ...policy, daily_enabled })} />
      <div className={styles['rule-body']}>
        <div className={styles['rule-head']}>
          <Text>{t('warmup.rule_daily')}</Text>
          <Input type="time" aria-label={t('warmup.daily_time')} value={policy.daily_time} disabled={disabled || !policy.daily_enabled}
            className={styles['rule-time']} onChange={event => onChange({ ...policy, daily_time: event.target.value })} />
        </div>
        <Text type="secondary" className={styles['rule-hint']}>
          {t('warmup.daily_hint', { start: policy.daily_time, end: addHours(policy.daily_time, 5), zone: timezone })}
        </Text>
      </div>
    </div>
    <div className={styles['rule']}>
      <Switch aria-label={t('warmup.rule_reset')} checked={isResetOn} disabled={disabled}
        onChange={isOn => onChange({ ...policy, reset_mode: isOn ? 'all' : 'off' })} />
      <div className={styles['rule-body']}>
        <Text>{t('warmup.rule_reset')}</Text>
        <Text type="secondary" className={styles['rule-hint']}>{t('warmup.reset_hint')}</Text>
        {isResetOn && <Segmented size="small" aria-label={t('warmup.reset_scope')} value={policy.reset_mode} disabled={disabled}
          options={[{ value: 'all', label: t('warmup.reset_all') }, { value: 'weekly', label: t('warmup.reset_weekly') }]}
          onChange={reset_mode => onChange({ ...policy, reset_mode: reset_mode as WarmupPolicy['reset_mode'] })} />}
      </div>
    </div>
    <label className={styles['model']}>
      <Text>{t('warmup.model')}</Text>
      <Select aria-label={t('warmup.model')} value={policy.model || undefined} placeholder={t('warmup.select_model')} disabled={disabled}
        showSearch={{ optionFilterProp: 'label' }} options={modelOptions.map(model => ({ value: model, label: model }))}
        onChange={(model: string) => onChange({ ...policy, model })} />
      <Text type="secondary" className={styles['rule-hint']}>{t('warmup.model_hint')}</Text>
    </label>
  </div>;
}

/** An inherited policy reads as what it does, not as a form the operator cannot touch. */
function RuleSummary({ policy, provider, timezone }: { policy: WarmupPolicy; provider: string; timezone: string }) {
  const t = useT();
  const rules = describePolicy(policy, timezone, t);
  return <div className={styles['summary']}>
    <ul className={styles['summary-rules']}>
      {rules.length ? rules.map(rule => <li key={rule}>{rule}</li>) : <li>{t('warmup.summary_none')}</li>}
      {rules.length > 0 && policy.model && <li className={styles['summary-model']}>{t('warmup.summary_model', { model: policy.model })}</li>}
    </ul>
    <Text type="secondary" className={styles['rule-hint']}>{t('warmup.inherit_hint', { provider: provider === 'codex' ? 'Codex' : 'Claude' })}</Text>
  </div>;
}

function StatusCard({ credential, result }: { credential: WarmupCredential; result?: WarmupResult }) {
  const t = useT(); const locale = languageLocale(useI18n().lang);
  const isOn = isWarmupPolicyEnabled(credential.policy);
  const isConfirming = result?.status === 'pending' || result?.status === 'executing';
  const isPaused = isOn && Boolean(credential.reason && PAUSING_REASONS.has(credential.reason));
  const tone: StatusTone = !isOn ? 'neutral' : isPaused ? 'warn' : isConfirming ? 'accent' : 'success';
  const headline = isConfirming ? t(`warmup.status_${result!.status}`) : t(!isOn ? 'warmup.auto_off' : isPaused ? 'warmup.auto_paused' : 'warmup.auto_on');
  const detail = isConfirming ? warmupReason('activation_pending', t) : isOn ? warmupReason(credential.reason, t) : t('warmup.auto_off_hint');
  const paid = credential.state.observation?.paid_fallback ?? 'unknown';
  const lastTone: StatusTone = result?.status === 'activated' ? 'success' : result?.status === 'failed' || result?.status === 'uncertain' ? 'warn' : 'neutral';
  return <div className={styles['status']} data-testid="warmup-status">
    <div className={styles['status-head']}>
      <StatusLabel tone={tone} className={styles['status-headline']}>{headline}</StatusLabel>
      {detail && <Text type="secondary" className={styles['status-detail']}>{detail}</Text>}
    </div>
    <dl className={styles['status-facts']}>
      {isOn && credential.next_at_ms && <div><dt>{t('warmup.row_next')}</dt><dd>{formatInstant(credential.next_at_ms, credential.timezone, locale)}</dd></div>}
      {result && !isConfirming && <div data-testid="warmup-last-result">
        <dt>{t('warmup.row_last')}</dt>
        <dd>
          <span className={styles['last-line']}>
            <StatusLabel tone={lastTone}>{t(`warmup.status_${result.status}`)}</StatusLabel>
            <span className={styles['last-meta']}>{formatInstant(result.finished_at_ms ?? result.started_at_ms, credential.timezone, locale)} · {t(`warmup.trigger_${result.trigger}`)}</span>
          </span>
          {result.status !== 'activated' && result.reason && <span className={styles['last-reason']}>{warmupReason(result.reason, t)}</span>}
        </dd>
      </div>}
      <div><dt>{t('warmup.row_billing')}</dt><dd>{t(`warmup.billing_${paid}`)}</dd></div>
    </dl>
  </div>;
}

export function WarmupSettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(); const { modal } = App.useApp(); const toast = useToast(); const queryClient = useQueryClient();
  const [provider, setProvider] = React.useState<'codex' | 'claude'>('codex');
  const [draft, setDraft] = React.useState<WarmupPolicy>();
  const draftRevision = React.useRef<string>();
  const settingsQuery = useQuery({ queryKey: ['quota-warmup-settings'], queryFn: api.getWarmupSettings, enabled: open, retry: false });
  const baseline = settingsQuery.data?.providers[provider];
  const policy = draft ?? baseline ?? DEFAULT_WARMUP_POLICY;
  const isDirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(baseline));
  const saveMutation = useMutation({
    mutationFn: ({ policy, revision }: { policy: WarmupPolicy; revision: string }) => api.saveWarmupSettings(provider, policy, revision),
    onSuccess: data => { queryClient.setQueryData<WarmupSettings>(['quota-warmup-settings'], previous => ({ ...data, models: previous?.models ?? data.models })); void queryClient.invalidateQueries({ queryKey: ['quota-warmup-settings'] }); setDraft(undefined); void queryClient.invalidateQueries({ queryKey: ['quota-warmup-credential'] }); toast.success(t('warmup.saved')); },
    onError: error => toast.error(safeError(error, t)),
  });
  const attemptClose = React.useCallback(() => {
    if (saveMutation.isPending) return;
    if (!isDirty) { setDraft(undefined); onClose(); return; }
    modal.confirm({ title: t('af.unsaved_confirm_title'), content: t('af.unsaved_confirm_desc'), okText: t('common.confirm'), cancelText: t('common.cancel'), onOk: () => { setDraft(undefined); onClose(); } });
  }, [isDirty, modal, onClose, saveMutation.isPending, t]);
  useOverlayHistory({ isOpen: open, onClose: attemptClose });
  const save = () => {
    if (!settingsQuery.data || !canSaveWarmupPolicy(policy)) return;
    const revision = draftRevision.current ?? settingsQuery.data.revision; const selectedPolicy = { ...policy };
    modal.confirm({ title: t('warmup.confirm_settings'), content: t('warmup.confirm_settings_desc'), okText: t('common.save'), cancelText: t('common.cancel'),
      onOk: () => saveMutation.mutateAsync({ policy: selectedPolicy, revision }) });
  };
  return <AppDrawer open={open} onClose={attemptClose} title={t('warmup.settings')} destroyOnHidden
    footer={<Space><Button onClick={() => setDraft(undefined)} disabled={!isDirty || saveMutation.isPending}>{t('common.cancel')}</Button>
      <Button type="primary" onClick={save} loading={saveMutation.isPending} disabled={!isDirty || !canSaveWarmupPolicy(policy) || isDemoMode()}>{t('common.save')}</Button></Space>}>
    <Tabs activeKey={provider} items={[{ key: 'codex', label: 'Codex', disabled: isDirty || saveMutation.isPending }, { key: 'claude', label: 'Claude', disabled: isDirty || saveMutation.isPending }]}
      onChange={value => { setProvider(value as 'codex' | 'claude'); setDraft(undefined); }} />
    {settingsQuery.isError ? <LoadFailure title={t('warmup.load_failed')} error={safeError(settingsQuery.error, t)} onRetry={() => void settingsQuery.refetch()} /> : settingsQuery.data ?
      <div className={styles['warmup-section']}>
        <Text type="secondary">{t('warmup.settings_description')}</Text>
        <RuleEditor policy={policy} timezone={settingsQuery.data.timezone} models={settingsQuery.data.models[provider]} disabled={saveMutation.isPending || isDemoMode()}
          onChange={policy => { if (!draft) draftRevision.current = settingsQuery.data!.revision; setDraft(policy); }} />
        <Text type="secondary" className={styles['rule-hint']}>{t('warmup.daily_priority')}</Text>
      </div> : <Text>{t('common.loading')}</Text>}
  </AppDrawer>;
}

export function CredentialWarmup({ authIndex, onDirtyChange }: { authIndex: string; onDirtyChange?: (isDirty: boolean) => void }) {
  const t = useT(); const { modal } = App.useApp(); const toast = useToast(); const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<{ inherit: boolean; policy: WarmupPolicy; revision: string }>();

  const credentialQuery = useQuery({ queryKey: ['quota-warmup-credential', authIndex], queryFn: () => api.getWarmupCredential(authIndex), retry: false, refetchInterval: 60_000 });
  const credential = credentialQuery.data;
  // Switching back to the default must show the default, not the override being discarded.
  const isInheritDraft = Boolean(draft?.inherit && credential && !credential.inherit);
  const defaultsQuery = useQuery({ queryKey: ['quota-warmup-settings'], queryFn: api.getWarmupSettings, enabled: isInheritDraft, retry: false });
  const values = draft ?? { inherit: credential?.inherit ?? true, policy: credential?.policy ?? DEFAULT_WARMUP_POLICY };
  const isDirty = Boolean(draft && credential && (draft.inherit !== credential.inherit || JSON.stringify(draft.policy) !== JSON.stringify(credential.policy)));
  React.useEffect(() => { onDirtyChange?.(isDirty); return () => onDirtyChange?.(false); }, [isDirty, onDirtyChange]);
  const saveMutation = useMutation({
    mutationFn: ({ inherit, policy, revision }: { inherit: boolean; policy: WarmupPolicy; revision: string }) => api.saveWarmupCredential(authIndex, inherit, policy, revision),
    onSuccess: data => { queryClient.setQueryData(['quota-warmup-credential', authIndex], data); setDraft(undefined); toast.success(t('warmup.saved')); },
    onError: error => toast.error(safeError(error, t)),
  });
  const runMutation = useMutation({
    mutationFn: ({ requestId, revision }: { requestId: string; revision: string }) => api.runWarmup(authIndex, requestId, revision),
    onSuccess: data => {
      // A refused click leaves the durable run alone; only a sent request becomes the last result.
      if (data.status !== 'skipped') queryClient.setQueryData<WarmupCredential>(['quota-warmup-credential', authIndex], previous => previous ? { ...previous, state: { ...previous.state, last_result: data } } : previous);
      void queryClient.invalidateQueries({ queryKey: ['quota-warmup-credential', authIndex] });
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      const title = t(`warmup.status_${data.status}`); const detail = warmupReason(data.reason, t) || undefined;
      if (data.status === 'activated') toast.success(title);
      else if (data.status === 'failed') toast.error(title, { detail });
      else if (data.status === 'uncertain') toast.warning(title, { detail });
      else toast.info(title, { detail });
    },
    onError: error => toast.error(safeError(error, t)),
  });
  const isBusy = saveMutation.isPending || runMutation.isPending || isDemoMode();
  const save = () => {
    if (!credential) return;
    const submitted = { ...values, policy: { ...values.policy }, revision: draft?.revision ?? credential.revision };
    modal.confirm({ title: t('warmup.confirm_settings'), content: t('warmup.confirm_credential_desc'), okText: t('common.save'), cancelText: t('common.cancel'), onOk: () => saveMutation.mutateAsync(submitted) });
  };
  const run = () => {
    if (!credential) return;
    const requestId = crypto.randomUUID(); const revision = credential.revision;
    modal.confirm({ title: t('warmup.run'), content: t('warmup.confirm_run', { name: credential.name, model: credential.policy.model }), okText: t('warmup.run'), cancelText: t('common.cancel'),
      onOk: () => runMutation.mutateAsync({ requestId, revision }) });
  };
  const runButton = credential && <Button size="small" onClick={run} loading={runMutation.isPending}
    disabled={isDirty || saveMutation.isPending || !credential.policy.model || isDemoMode()}>{t('warmup.run')}</Button>;
  return <section className={styles['warmup-section']} data-testid="credential-warmup">
    <SectionHeading title={t('warmup.title')} description={t('warmup.description')} extra={runButton} />
    {credentialQuery.isError ? <LoadFailure title={t('warmup.load_failed')} error={safeError(credentialQuery.error, t)} onRetry={() => void credentialQuery.refetch()} /> : credential ? <>
      <StatusCard credential={credential} result={credential.state.last_result} />
      <div className={styles['rules-block']}>
        <SectionHeading level="label" as="h4" title={t('warmup.rules')} extra={
          <Segmented size="small" aria-label={t('warmup.policy_source')} value={values.inherit ? 'inherit' : 'override'} disabled={isBusy}
            options={[{ value: 'inherit', label: t('warmup.inherit') }, { value: 'override', label: t('warmup.override') }]}
            onChange={value => setDraft({ inherit: value === 'inherit', policy: { ...values.policy }, revision: draft?.revision ?? credential.revision })} />} />
        {values.inherit ? (isInheritDraft && !defaultsQuery.data ? (defaultsQuery.isError
          ? <LoadFailure title={t('warmup.load_failed')} error={safeError(defaultsQuery.error, t)} onRetry={() => void defaultsQuery.refetch()} />
          : <Text type="secondary">{t('common.loading')}</Text>)
          : <RuleSummary policy={isInheritDraft ? defaultsQuery.data!.providers[credential.provider] : credential.policy} provider={credential.provider} timezone={credential.timezone} />) :
          <RuleEditor policy={values.policy} models={credential.models} timezone={credential.timezone} disabled={isBusy}
            onChange={policy => setDraft({ inherit: false, policy, revision: draft?.revision ?? credential.revision })} />}
        {isDirty && <div className={styles['actions']}>
          <Button size="small" onClick={() => setDraft(undefined)} disabled={saveMutation.isPending}>{t('common.cancel')}</Button>
          <Button size="small" type="primary" onClick={save} loading={saveMutation.isPending} disabled={!values.inherit && !canSaveWarmupPolicy(values.policy) || isInheritDraft && !defaultsQuery.data || isDemoMode()}>{t('common.save')}</Button>
        </div>}
      </div>
    </> : <Text>{t('common.loading')}</Text>}
  </section>;
}
