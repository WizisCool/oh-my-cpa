import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Switch } from '../common/Switch';
import { App, Button, Input, Tooltip } from 'antd';
import { CopyOutlined, InfoCircleOutlined } from '../icons';
import { StatusLabel, type StatusTone } from '../common/StatusLabel';
import { formatGatewayTimestamp } from '../../utils/time';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import { isSIWCPending, siwcTargetKey, type SIWCBindings, type SIWCSession } from '../../hooks/useSIWCBindings';
import { Notice, useToast } from '../feedback';
import { isDemoMode } from '../../types/demoMode';
import { copyText } from '../../utils/clipboard';
import styles from './SIWCBindingPanel.module.css';

const ERROR_KEYS: Record<NonNullable<SIWCSession['error']>, string> = {
  start: 'siwc.start_failed', callback: 'siwc.callback_failed', incomplete: 'siwc.callback_incomplete', cancel: 'siwc.cancel_failed',
  read: 'siwc.read_failed', expired: 'siwc.expired', failed: 'siwc.failed', conflict: 'siwc.conflict',
};
const PHASE_TONES: Record<SIWCSession['phase'], StatusTone> = {
  starting: 'accent', waiting: 'accent', verifying: 'accent', success: 'success', error: 'warn', cancelled: 'neutral',
};
const PHASE_KEYS: Record<SIWCSession['phase'], string> = {
  starting: 'siwc.starting', waiting: 'siwc.waiting', verifying: 'siwc.verifying',
  success: 'siwc.success', error: 'siwc.failed', cancelled: 'siwc.cancelled',
};

export function SIWCBindingPanel({ file, canEdit, bindings }: { file: ManagementAuthFile; canEdit: boolean; bindings: SIWCBindings }) {
  const t = useT();
  const { modal } = App.useApp();
  const toast = useToast();

  const queryClient = useQueryClient();
  const session = bindings.sessions[siwcTargetKey(file)];
  const bindingSummary = session?.sourceFile === file && session.confirmedFile ? session.confirmedFile : file;
  const [saved, setSaved] = React.useState<{ source: ManagementAuthFile; bindingSummary: ManagementAuthFile; file: ManagementAuthFile }>();
  const useMutationResult = useMutation({
    mutationFn: ({ source, useSIWC }: { source: ManagementAuthFile; bindingSummary: ManagementAuthFile; useSIWC: boolean }) => api.patchManagementAuthFileFields(source.name, { use_siwc: useSIWC }, source.auth_index),
    onSuccess: (response, variables) => {
      if (response.file) setSaved({ source: variables.source, bindingSummary: variables.bindingSummary, file: response.file });
      toast.success(t('af.save_fields_success'));
    },
    onError: () => { toast.error(t('siwc.use_failed')); },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] }); },
  });
  if ((file.provider || file.type)?.toLowerCase() !== 'codex') return null;
  const summary = saved?.source === file && saved.bindingSummary === bindingSummary ? saved.file : bindingSummary;
  const isPending = isSIWCPending(session);
  const isSupported = summary.siwc_bind_supported === true && !file.runtime_only;
  const hasSummary = summary.siwc_bind_supported !== undefined;
  function start() {
    if (summary.siwc_bound) {
      modal.confirm({ title: t('siwc.rebind'), content: t('siwc.rebind_confirm'), okText: t('siwc.rebind'), cancelText: t('common.cancel'), onOk: () => bindings.start(file, true) });
    } else void bindings.start(file, false);
  }
  const localStatus = summary.siwc_status;
  const statusTone: StatusTone = localStatus === 'valid' ? 'success' : localStatus === 'invalid' ? 'danger' : 'neutral';
  const statusKey = localStatus === 'off' ? 'siwc.status_off' : localStatus === 'valid' ? 'siwc.status_valid' : localStatus === 'invalid' ? 'siwc.status_invalid' : 'siwc.unknown';
  return <section className={styles['binding']} data-testid="siwc-binding">
    {/* The state is one card: CPA's local verdict as the headline, then the facts it rests on.
        What the verdict does and does not mean is a tap away rather than a paragraph under it. */}
    <div className={styles['status-card']}>
      <div className={styles['status-head']}>
        <StatusLabel tone={statusTone} className={styles['status-label']}>{t(statusKey)}</StatusLabel>
        <Tooltip title={t('siwc.summary_hint')}>
          <button type="button" className={styles['info']} aria-label={t('siwc.about_status')}><InfoCircleOutlined /></button>
        </Tooltip>
      </div>
      <div className={styles['status-meta']}>
        {hasSummary && <span>{t(summary.siwc_bound ? 'siwc.bound' : 'siwc.badge_unbound')}</span>}
        {summary.siwc_expires_at && <span>{t('siwc.expires', { time: formatGatewayTimestamp(summary.siwc_expires_at) })}</span>}
        {!isSupported && (
          <Tooltip title={t('siwc.unsupported_hint')}>
            <span className={styles['meta-hint']} tabIndex={0}>{t('siwc.unsupported')}</span>
          </Tooltip>
        )}
      </div>
    </div>
    {summary.siwc_status === 'invalid' && !isPending && <Notice tone="warning" description={t('siwc.invalid_hint')} />}
    <div className={styles['setting']}>
      <span className={styles['setting-label']}>
        {t('siwc.use')}
        <Tooltip title={t('siwc.use_hint')}>
          <button type="button" className={styles['info']} aria-label={t('siwc.about_use')}><InfoCircleOutlined /></button>
        </Tooltip>
      </span>
      <Switch aria-label={t('siwc.use')} checked={Boolean(summary.use_siwc)} loading={useMutationResult.isPending}
        disabled={!canEdit || file.runtime_only || isPending || isDemoMode() || summary.siwc_status === undefined || (!summary.use_siwc && summary.siwc_bound !== true)}
        onChange={(isEnabled) => useMutationResult.mutate({ source: file, bindingSummary, useSIWC: isEnabled })} />
    </div>
    {/* Progress is a line, not a box: the boxes are kept for what the operator has to act on. */}
    {session && (
      <div role="status" className={styles['phase']}>
        <StatusLabel tone={PHASE_TONES[session.phase]}>{t(PHASE_KEYS[session.phase])}</StatusLabel>
      </div>
    )}
    {session?.wasCancelRefused && isPending && <Notice tone="info" description={t('siwc.cancel_refused')} />}
    {session?.error && <Notice tone="warning" description={t(ERROR_KEYS[session.error])} />}
    {session?.phase === 'waiting' && (
      <ol className={styles['steps']}>
        <li className={styles['step']}>
          <span className={styles['step-index']} aria-hidden="true">1</span>
          <div className={styles['step-body']}>
            <div className={styles['row-actions']}>
              <Button href={session.url} target="_blank" rel="noopener noreferrer">{t('siwc.open')}</Button>
              <Tooltip title={t('siwc.copy')}>
                <Button
                  icon={<CopyOutlined />}
                  aria-label={t('siwc.copy')}
                  onClick={() => { void copyText(session.url ?? '').then((isCopied) => { if (isCopied) toast.success(t('common.copied')); else toast.error(t('common.copy_failed')); }); }}
                />
              </Tooltip>
            </div>
          </div>
        </li>
        <li className={styles['step']}>
          <span className={styles['step-index']} aria-hidden="true">2</span>
          <div className={styles['step-body']}>
            <span className={styles['step-title']}>
              {t('siwc.callback')}
              <Tooltip title={t('siwc.callback_hint')}>
                <button type="button" className={styles['info']} aria-label={t('siwc.about_callback')}><InfoCircleOutlined /></button>
              </Tooltip>
            </span>
            <Input.TextArea
              aria-label={t('siwc.callback')}
              value={session.callbackUrl}
              onChange={(event) => bindings.setCallback(file, event.target.value)}
              placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…&client_id=…"
              autoComplete="off"
              spellCheck={false}
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
            <div className={styles['row-actions']}>
              <Button type="primary" disabled={session.isBusy || !session.callbackUrl.trim()} loading={session.isBusy} onClick={() => void bindings.submit(file)}>{t('siwc.submit')}</Button>
              <Button disabled={session.isBusy} onClick={() => void bindings.cancel(file)}>{t('common.cancel')}</Button>
            </div>
          </div>
        </li>
      </ol>
    )}
    {!isPending && (
      <div className={styles['footer']}>
        <Button type={summary.siwc_status === 'invalid' || !summary.siwc_bound ? 'primary' : 'default'} disabled={!isSupported || !canEdit || useMutationResult.isPending || isDemoMode()} onClick={start}>{t(summary.siwc_bound ? 'siwc.rebind' : 'siwc.bind')}</Button>
      </div>
    )}
  </section>;
}
