import React from 'react';
import { Button, Select } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { Switch } from '../../components/common/Switch';
import { useT } from '../../i18n';
import { messageKey } from '../../i18n/catalog';
import type { CodexResetPolicy } from '../../types/quota';
import { formatShortDateTime } from './quotaFormat';
import styles from './QuotaWindowCards.module.css';

type Consent = Pick<CodexResetPolicy, 'account_key' | 'enabled' | 'before_expiry_seconds'>;

export function CodexAutoReset({ authIndex, isDisabled = false }: { authIndex: string; isDisabled?: boolean }) {
  const t = useT();
  const client = useQueryClient();
  const queryKey = ['codex-reset-policy', authIndex];
  const policy = useQuery({
    queryKey,
    queryFn: () => api.getCodexResetPolicy(authIndex),
    retry: false,
    refetchInterval: 60_000,
  });
  const [draft, setDraft] = React.useState<Consent | null>(null);
  const isSaving = React.useRef(false);
  const save = useMutation({
    mutationFn: (consent: Consent) => api.putCodexResetPolicy(authIndex, consent),
    onSuccess: (saved) => {
      client.setQueryData(queryKey, saved);
      setDraft(null);
    },
    onError: () => { void policy.refetch(); },
    onSettled: () => { isSaving.current = false; },
  });
  const state = policy.data;
  const lastReset = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    if (!state) return;
    if (lastReset.current !== undefined && state.last_reset_at > lastReset.current) {
      void client.invalidateQueries({ queryKey: ['management-quota'] });
    }
    lastReset.current = state.last_reset_at;
  }, [state, client]);
  // A new immutable account must never inherit an unsubmitted consent draft.
  const value = state && draft?.account_key === state.account_key ? draft : state;
  const canEdit = Boolean(state && !policy.isError && !policy.isFetching && !save.isPending && !isDisabled);
  const isChanged = Boolean(state && value && (state.enabled !== value.enabled || state.before_expiry_seconds !== value.before_expiry_seconds));
  const canSave = canEdit && isChanged && !(state?.pending && value?.enabled);
  const update = (patch: Partial<Consent>) => {
    if (state && value) setDraft({ account_key: state.account_key, enabled: value.enabled, before_expiry_seconds: value.before_expiry_seconds, ...patch });
  };
  const statusKey = state && messageKey(`quota.auto_reset_${state.result}`);
  const seconds = value?.before_expiry_seconds ?? 3600;
  const leadTimes = [...new Set([900, 3600, 21600, 86400, seconds])].sort((a, b) => a - b);
  return (
    <section className={styles.group} aria-label={t('quota.auto_reset_title')}>
      <div className={styles['group-name']}>{t('quota.auto_reset_title')}</div>
      <div className={styles['auto-reset-controls']}>
        <Switch aria-label={t('quota.auto_reset_title')} checked={value?.enabled ?? false}
          disabled={!canEdit || Boolean(state?.pending && !state.enabled)} onChange={enabled => update({ enabled })} />
        <Select aria-label={t('quota.auto_reset_before')} value={seconds} disabled={!canEdit || Boolean(state?.pending)}
          options={leadTimes.map(n => ({ value: n, label: t('quota.auto_reset_minutes', { n: n / 60 }) }))}
          onChange={before_expiry_seconds => update({ before_expiry_seconds })} />
        <ConfirmAction title={t('quota.auto_reset_title')} description={t(value?.enabled ? 'quota.auto_reset_confirm' : 'quota.auto_reset_disable_confirm')}
          isConfirming={save.isPending} onConfirm={() => {
            if (!canSave || !value || isSaving.current) return;
            isSaving.current = true;
            save.mutate({ account_key: value.account_key, enabled: value.enabled, before_expiry_seconds: seconds });
          }}>
          <Button size="small" disabled={!canSave} loading={save.isPending}>{t('common.save')}</Button>
        </ConfirmAction>
      </div>
      <span className={styles.detail} role="status">
        {policy.isError ? t('quota.auto_reset_unavailable')
          : state?.pending ? t('quota.auto_reset_pending')
            : state ? t(statusKey ?? 'quota.auto_reset_unknown') : t('common.loading')}
      </span>
      {save.isError && <span role="alert">{t('quota.auto_reset_save_failed')}</span>}
      {state?.last_reset_at ? <span className={styles.detail}>{t('quota.auto_reset_last', { when: formatShortDateTime(state.last_reset_at * 1000) })}</span> : null}
      {state?.enabled && state.next_check_at > 0 && <span className={styles.detail}>{t('quota.auto_reset_next', { when: formatShortDateTime(state.next_check_at * 1000) })}</span>}
    </section>
  );
}
