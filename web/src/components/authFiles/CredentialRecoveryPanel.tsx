import { App, Button, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import { isDemoMode } from '../../types/demoMode';
import { formatGatewayTimestamp } from '../../utils/time';
import { SectionHeading } from '../common/SectionHeading';
import { StatusLabel } from '../common/StatusLabel';
import { Notice, useToast } from '../feedback';
import { CheckOutlined } from '../icons';
import { renewalDetail, renewalLabel, renewalTone } from './credentialRecovery';
import styles from './CredentialRecoveryPanel.module.css';

const { Text } = Typography;

/** One piece of evidence: confirmed, refuted, or not yet observed at all. */
function EvidenceStep({ title, value, hint, action }: {
  title: string;
  value: boolean | undefined;
  hint?: string;
  action?: React.ReactNode;
}) {
  const t = useT();
  const evidence = value === undefined ? 'unknown' : value ? 'confirmed' : 'unconfirmed';
  return <li className={clsx(styles['step'], styles[`is-${evidence}`])}>
    <span className={styles['step-marker']} aria-hidden="true">{value && <CheckOutlined />}</span>
    <div className={styles['step-body']}>
      <span className={styles['step-title']}>{title}</span>
      <span className={styles['step-state']}>{t(`recovery.${evidence}`)}</span>
      {hint && <Text type="secondary" className={styles['hint']}>{hint}</Text>}
    </div>
    {action}
  </li>;
}

export function CredentialRecoveryPanel({ file, canEdit, onRecover, onChanged }: {
  file: ManagementAuthFile;
  canEdit: boolean;
  onRecover?: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const { modal } = App.useApp();
  const toast = useToast();
  const verification = useMutation({
    mutationFn: (target: { name: string; authIndex?: string }) => api.verifyManagementAuthFile(target.name, target.authIndex),
    onSuccess: (result) => result.verified ? toast.success(t('recovery.verify_success')) : toast.warning(t('recovery.verify_unconfirmed')),
    onError: (error) => toast.error(t('recovery.verify_failed', { msg: describeError(error) })),
    onSettled: onChanged,
  });
  const isBlocked = !canEdit || isDemoMode() || !file.recovery_supported;
  const timestamp = (value: string | undefined) => value ? formatGatewayTimestamp(value) : t('recovery.unknown');
  const verify = () => modal.confirm({
    title: t('recovery.verify'),
    content: t('recovery.verify_warning', { name: file.display_name || file.name }),
    okText: t('recovery.verify'), cancelText: t('common.cancel'),
    onOk: () => verification.mutateAsync({ name: file.name, authIndex: file.auth_index }).then(
      () => undefined,
      // Mutation callbacks report failure and refresh evidence; retire this confirmation either way.
      () => undefined,
    ),
  });
  return <section className={styles['panel']} aria-label={t('recovery.title')} data-testid="credential-recovery">
    <SectionHeading title={t('recovery.title')} description={t('recovery.description')} />
    {!file.recovery_supported && <Notice tone="info" title={t('recovery.unknown')} description={t('recovery.upgrade_required')} />}

    {/* The status leads: whether CPA can keep this credential alive without the operator. */}
    <div className={styles['status']}>
      <div className={styles['status-head']}>
        <StatusLabel tone={renewalTone(file)} className={styles['status-headline']}>{t(renewalLabel(file))}</StatusLabel>
        <Text type="secondary" className={styles['status-detail']}>{t(renewalDetail(file))}</Text>
      </div>
      <dl className={styles['status-facts']}>
        <div><dt>{t('recovery.access_expires')}</dt><dd className="mono-num">{timestamp(file.access_token_expires_at)}</dd></div>
        <div><dt>{t('recovery.next_refresh')}</dt><dd className="mono-num">{timestamp(file.next_refresh_after)}</dd></div>
        {file.refresh_error && <div>
          <dt>{t('recovery.refresh_error')}</dt>
          <dd className="mono-num"><span className={styles['fact-error']}>{[file.refresh_error.code, file.refresh_error.http_status].filter(Boolean).join(' · ')}</span></dd>
        </div>}
      </dl>
    </div>

    {/* Quota blocking is CPA's current stage, not evidence: it outranks confirmed inference,
        so it is stated beside the status instead of overwriting a verified step. */}
    {file.recovery_stage === 'quota_blocked' && <Notice tone="warning" title={t('recovery.quota_blocked')} description={t('recovery.quota_blocked_hint')} />}

    <div className={styles['block']}>
      <SectionHeading level="label" as="h4" title={t('recovery.progress')} />
      {/* Once inference is confirmed, verifying again would spend tokens to relearn a known fact. */}
      <ol className={styles['steps']}>
        <EvidenceStep title={t('recovery.adopted')} value={file.adopted} />
        <EvidenceStep
          title={t('recovery.inference')}
          value={file.inference_verified}
          hint={file.inference_verified ? undefined : t('recovery.inference_hint')}
          action={file.inference_verified ? undefined : <Button size="small" disabled={isBlocked} loading={verification.isPending} data-credential-verify onClick={verify}>
            {t('recovery.verify_now')}
          </Button>}
        />
        <EvidenceStep title={t('recovery.renewal')} value={file.renewal_verified} />
      </ol>
    </div>

    {onRecover && <div className={styles['block']}>
      <SectionHeading level="label" as="h4" title={t('recovery.sign_in')} />
      <div className={styles['recover']}>
        <Text type="secondary" className={styles['hint']}>{t('recovery.recover_hint')}</Text>
        <Button type={file.requires_sign_in ? 'primary' : 'default'} disabled={isBlocked} onClick={onRecover} data-credential-recover>
          {t('recovery.recover')}
        </Button>
      </div>
    </div>}
  </section>;
}
