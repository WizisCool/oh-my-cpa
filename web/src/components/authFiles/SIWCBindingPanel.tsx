import { App, Button, Input } from 'antd';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import { isSIWCPending, siwcTargetKey, type SIWCBindings, type SIWCSession } from '../../hooks/useSIWCBindings';
import { FactList } from '../common/FactList';
import { Notice, useToast } from '../feedback';
import { isDemoMode } from '../../types/demoMode';
import { copyText } from '../../utils/clipboard';
import { SectionHeading } from '../common/SectionHeading';
import styles from './SIWCBindingPanel.module.css';

const ERROR_KEYS: Record<NonNullable<SIWCSession['error']>, string> = {
  start: 'siwc.start_failed', callback: 'siwc.callback_failed', cancel: 'siwc.cancel_failed',
  read: 'siwc.read_failed', expired: 'siwc.expired', failed: 'siwc.failed', conflict: 'siwc.conflict',
};
const PHASE_KEYS: Record<SIWCSession['phase'], string> = {
  starting: 'siwc.starting', waiting: 'siwc.waiting', verifying: 'siwc.verifying',
  success: 'siwc.success', error: 'siwc.failed', cancelled: 'siwc.cancelled',
};

export function SIWCBindingPanel({ file, canEdit, bindings }: { file: ManagementAuthFile; canEdit: boolean; bindings: SIWCBindings }) {
  const t = useT();
  const { modal } = App.useApp();
  const toast = useToast();

  if ((file.provider || file.type)?.toLowerCase() !== 'codex') return null;
  const session = bindings.sessions[siwcTargetKey(file)];
  const summary = session?.sourceFile === file && session.confirmedFile ? session.confirmedFile : file;
  const isPending = isSIWCPending(session);
  const isSupported = summary.siwc_bind_supported === true && !file.runtime_only;
  const hasSummary = summary.siwc_bind_supported !== undefined;
  const booleanLabel = (value: boolean | undefined) => !hasSummary ? t('siwc.unknown') : t(value ? 'siwc.yes' : 'siwc.no');
  function start() {
    if (summary.siwc_bound) {
      modal.confirm({ title: t('siwc.rebind'), content: t('siwc.rebind_confirm'), okText: t('siwc.rebind'), cancelText: t('common.cancel'), onOk: () => bindings.start(file, true) });
    } else void bindings.start(file, false);
  }
  return <section className={styles['binding']} data-testid="siwc-binding">
    <SectionHeading title={t('siwc.title')} />
    <FactList emphasis="quiet" facts={[
      { key: 'support', label: t('siwc.eligibility'), value: t(isSupported ? 'siwc.supported' : 'siwc.unsupported') },
      { key: 'use', label: t('siwc.configured'), value: booleanLabel(summary.use_siwc) },
      { key: 'bound', label: t('siwc.material'), value: booleanLabel(summary.siwc_bound) },
      { key: 'expiry', label: t('siwc.expiry'), value: summary.siwc_expires_at || t('siwc.unknown') },
    ]} />
    <p className={styles['hint']}>{t('siwc.summary_hint')}</p>
    {!isSupported && <Notice tone="info" description={t('siwc.unsupported_hint')} />}
    {session && <div role="status"><Notice tone={session.phase === 'success' ? 'success' : session.phase === 'error' ? 'warning' : 'info'} description={t(PHASE_KEYS[session.phase])} /></div>}
    {session?.wasCancelRefused && isPending && <Notice tone="info" description={t('siwc.cancel_refused')} />}
    {session?.error && <Notice tone="warning" description={t(ERROR_KEYS[session.error])} />}
    {session?.phase === 'waiting' && <>
      <p className={styles['hint']}>{t('siwc.callback_hint')}</p>
      <div className={styles['actions']}>
        <Button href={session.url} target="_blank" rel="noopener noreferrer">{t('siwc.open')}</Button>
        <Button onClick={() => { void copyText(session.url ?? '').then((isCopied) => { if (isCopied) toast.success(t('common.copied')); else toast.error(t('common.copy_failed')); }); }}>{t('siwc.copy')}</Button>
      </div>
      <label className={styles['callback']}>
        <span>{t('siwc.callback')}</span>
        <Input.TextArea value={session.callbackUrl} onChange={(event) => bindings.setCallback(file, event.target.value)} autoComplete="off" spellCheck={false} rows={3} />
      </label>
      <div className={styles['actions']}>
        <Button disabled={session.isBusy || !session.callbackUrl.trim()} loading={session.isBusy} onClick={() => void bindings.submit(file)}>{t('siwc.submit')}</Button>
        <Button disabled={session.isBusy} onClick={() => void bindings.cancel(file)}>{t('common.cancel')}</Button>
      </div>
    </>}
    {!isPending && <Button disabled={!isSupported || !canEdit || isDemoMode()} onClick={start}>{t(summary.siwc_bound ? 'siwc.rebind' : 'siwc.bind')}</Button>}
  </section>;
}
