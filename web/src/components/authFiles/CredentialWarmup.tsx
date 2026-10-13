import React from 'react';
import { App, Button, Input, Select, Space, Tabs, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { ApiError } from '../../api/client';
function safeError(error: unknown, t: TFunc): string {
 const code = error instanceof ApiError ? error.message : '';
 return code in REASON_KEYS ? t(REASON_KEYS[code]) : t('warmup.load_failed');
}
import { isDemoMode } from '../../types/demoMode';
import { canSaveWarmupPolicy, DEFAULT_WARMUP_POLICY, type WarmupPolicy, type WarmupResult, type WarmupSettings, type WarmupCredential } from '../../types/warmup';
import { AppDrawer } from '../common/AppDrawer';
import { SectionHeading } from '../common/SectionHeading';
import { FactList } from '../common/FactList';
import { Switch } from '../common/Switch';
import { Notice, LoadFailure, useToast } from '../feedback';
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
export function warmupReason(reason: string | undefined, t: TFunc): string {
  return reason ? t(REASON_KEYS[reason] ?? 'warmup.reason_unknown') : '';
}
function ResultNotice({ result }: { result: WarmupResult }) {
  const t = useT();
  return <Notice tone={result.status === 'activated' ? 'success' : result.status === 'failed' || result.status === 'uncertain' ? 'warning' : 'info'}
    title={t(`warmup.status_${result.status}`)} description={warmupReason(result.reason, t)} />;
}
function PolicyEditor({ policy, onChange, models, disabled }: {
  policy: WarmupPolicy; onChange: (policy: WarmupPolicy) => void; models: string[]; disabled?: boolean;
}) {
  const t = useT();
  const modelOptions = [...new Set([...models, ...(policy.model ? [policy.model] : [])])].sort((first, second) =>
    Number(!first.toLowerCase().includes('haiku')) - Number(!second.toLowerCase().includes('haiku')) || first.localeCompare(second));
  return <div className={styles['policy-fields']}>
    <label className={styles['field']}><Text>{t('warmup.model')}</Text>
      <Select aria-label={t('warmup.model')} value={policy.model || undefined} placeholder={t('warmup.select_model')} disabled={disabled}
        showSearch={{ optionFilterProp: 'label' }} options={modelOptions.map(model => ({ value: model, label: model }))}
        onChange={(model: string) => onChange({ ...policy, model })} />
    </label>
    <label className={styles['field']}><Text>{t('warmup.on_reset')}</Text>
      <Select aria-label={t('warmup.on_reset')} value={policy.reset_mode} disabled={disabled}
        options={(['off', 'weekly', 'all'] as const).map(mode => ({ value: mode, label: t(`warmup.mode_${mode}`) }))}
        onChange={(reset_mode: WarmupPolicy['reset_mode']) => onChange({ ...policy, reset_mode })} />
    </label>
    <div className={styles['daily-row']}>
      <Text>{t('warmup.daily')}</Text>
      <Switch aria-label={t('warmup.daily')} checked={policy.daily_enabled} disabled={disabled}
        onChange={daily_enabled => onChange({ ...policy, daily_enabled })} />
      <Input type="time" aria-label={t('warmup.daily_time')} value={policy.daily_time} disabled={disabled || !policy.daily_enabled}
        onChange={event => onChange({ ...policy, daily_time: event.target.value })} />
    </div>
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
        <Notice tone="info" description={t('warmup.description')} />
        <PolicyEditor policy={policy} onChange={policy => { if (!draft) draftRevision.current = settingsQuery.data!.revision; setDraft(policy); }} models={settingsQuery.data.models[provider]} disabled={saveMutation.isPending || isDemoMode()} />
        <Text type="secondary">{t('warmup.timezone', { zone: settingsQuery.data.timezone })}</Text>
        <Text type="secondary">{t('warmup.daily_priority')}</Text>
      </div> : <Text>{t('common.loading')}</Text>}
  </AppDrawer>;
}

export function CredentialWarmup({ authIndex, onDirtyChange }: { authIndex: string; onDirtyChange?: (isDirty: boolean) => void }) {
  const t = useT(); const { modal } = App.useApp(); const toast = useToast(); const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<{ inherit: boolean; policy: WarmupPolicy; revision: string }>();

  const credentialQuery = useQuery({ queryKey: ['quota-warmup-credential', authIndex], queryFn: () => api.getWarmupCredential(authIndex), retry: false, refetchInterval: 60_000 });
  const credential = credentialQuery.data;
  const [manualOutcome, setManualOutcome] = React.useState<{ authIndex: string; result: WarmupResult }>();
  const manualResult = manualOutcome?.authIndex === authIndex ? manualOutcome.result : undefined;
  const durableResult = credential?.state.last_result;
  const displayedResult = manualResult && (!durableResult || durableResult.request_id !== manualResult.request_id && manualResult.started_at_ms >= durableResult.started_at_ms) ? manualResult : durableResult ?? manualResult;
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
      setManualOutcome({ authIndex, result: data });
      queryClient.setQueryData<WarmupCredential>(['quota-warmup-credential', authIndex], previous => previous ? { ...previous, state: { ...previous.state, last_result: data } } : previous);
      void queryClient.invalidateQueries({ queryKey: ['quota-warmup-credential', authIndex] });
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
    },
    onError: error => toast.error(safeError(error, t)),
  });
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
  return <section className={styles['warmup-section']} data-testid="credential-warmup">
    <SectionHeading title={t('warmup.title')} />
    {credentialQuery.isError ? <LoadFailure title={t('warmup.load_failed')} error={safeError(credentialQuery.error, t)} onRetry={() => void credentialQuery.refetch()} /> : credential ? <>
      <Notice tone="info" description={t('warmup.description')} />
      <Select aria-label={t('warmup.policy_source')} value={values.inherit ? 'inherit' : 'override'} disabled={saveMutation.isPending || runMutation.isPending || isDemoMode()}
        options={[{ value: 'inherit', label: t('warmup.inherit') }, { value: 'override', label: t('warmup.override') }]}
        onChange={value => setDraft({ inherit: value === 'inherit', policy: { ...values.policy }, revision: draft?.revision ?? credential.revision })} />
      <PolicyEditor policy={values.policy} models={credential.models} onChange={policy => setDraft({ inherit: false, policy, revision: draft?.revision ?? credential.revision })} disabled={values.inherit || saveMutation.isPending || runMutation.isPending || isDemoMode()} />
      <Text type="secondary">{t('warmup.timezone', { zone: credential.timezone })}</Text>
      <FactList emphasis="quiet" facts={[
        { key: 'activation', label: t('warmup.activation_observation'), value: t(credential.state.protocol_verified && credential.state.verified_model === credential.policy.model ? 'warmup.observed' : 'warmup.not_observed') },
        { key: 'billing', label: t('warmup.paid_fallback'), value: t(`warmup.paid_${credential.state.observation?.paid_fallback ?? 'unknown'}`) },
      ]} />
      {credential.next_at_ms && <Text>{t('warmup.next', { time: new Intl.DateTimeFormat(undefined, { timeZone: credential.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(credential.next_at_ms) })}</Text>}
      {credential.reason && <Notice tone="info" description={warmupReason(credential.reason, t)} />}
      {displayedResult && <ResultNotice result={displayedResult} />}
      <div className={styles['actions']}>
        <Button onClick={() => setDraft(undefined)} disabled={!isDirty || saveMutation.isPending}>{t('common.cancel')}</Button>
        <Button type="primary" onClick={save} loading={saveMutation.isPending} disabled={!isDirty || !values.inherit && !canSaveWarmupPolicy(values.policy) || isDemoMode()}>{t('common.save')}</Button>
        <Button onClick={run} loading={runMutation.isPending} disabled={isDirty || saveMutation.isPending || !credential.policy.model || isDemoMode()}>{t('warmup.run')}</Button>
      </div>
    </> : <Text>{t('common.loading')}</Text>}
  </section>;
}
