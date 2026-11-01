import { App, Button, Space } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import { isDemoMode } from '../../types/demoMode';
import { formatGatewayTimestamp } from '../../utils/time';
import { FactList } from '../common/FactList';
import { SectionHeading } from '../common/SectionHeading';
import { StatusLabel } from '../common/StatusLabel';
import { Notice, useToast } from '../feedback';
import { recoveryStageLabel, renewalLabel, renewalTone } from './credentialRecovery';

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
  const evidence = (value: boolean | undefined) => t(value === undefined ? 'recovery.unknown' : value ? 'recovery.confirmed' : 'recovery.unconfirmed');
  const isBlocked = !canEdit || isDemoMode() || !file.recovery_supported;
  return <section aria-label={t('recovery.title')} data-testid="credential-recovery">
    <SectionHeading title={t('recovery.title')} extra={<StatusLabel tone={renewalTone(file)}>{t(renewalLabel(file))}</StatusLabel>} />
    {file.requires_sign_in && <Notice tone="warning" title={t('recovery.sign_in_required')} description={t('recovery.sign_in_hint')} />}
    {!file.recovery_supported && <Notice tone="info" title={t('recovery.unknown')} description={t('recovery.upgrade_required')} />}
    <FactList facts={[
      { key: 'stage', label: t('recovery.stage'), value: t(recoveryStageLabel(file)) },
      { key: 'expiry', label: t('recovery.access_expires'), value: file.access_token_expires_at ? formatGatewayTimestamp(file.access_token_expires_at) : t('recovery.unknown') },
      { key: 'next', label: t('recovery.next_refresh'), value: file.next_refresh_after ? formatGatewayTimestamp(file.next_refresh_after) : t('recovery.unknown') },
      { key: 'adopted', label: t('recovery.adopted'), value: evidence(file.adopted) },
      { key: 'inference', label: t('recovery.inference'), value: evidence(file.inference_verified) },
      { key: 'renewal', label: t('recovery.renewal'), value: evidence(file.renewal_verified) },
      ...(file.refresh_error ? [{ key: 'error', label: t('recovery.refresh_error'), value: [file.refresh_error.code, file.refresh_error.http_status].filter(Boolean).join(' · ') }] : []),
    ]} />
    <Space wrap>
      {onRecover && <Button disabled={isBlocked} onClick={onRecover} data-credential-recover>{t('recovery.recover')}</Button>}
      <Button disabled={isBlocked} loading={verification.isPending} data-credential-verify onClick={() => modal.confirm({
        title: t('recovery.verify'),
        content: t('recovery.verify_warning', { name: file.display_name || file.name }),
        okText: t('recovery.verify'), cancelText: t('common.cancel'),
        onOk: () => verification.mutateAsync({ name: file.name, authIndex: file.auth_index }).then(
          () => undefined,
          // Mutation callbacks report failure and refresh evidence; retire this confirmation either way.
          () => undefined,
        ),
      })}>{t('recovery.verify')}</Button>
    </Space>
  </section>;
}
