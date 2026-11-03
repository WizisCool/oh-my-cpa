import { useState } from 'react';
import { Button, Input, Select } from 'antd';
import { apiErrorCode } from '../../api/client';
import { SecretInput } from '../../components/common/SecretInput';
import { Notice } from '../../components/feedback';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { BackupAutomationInput, BackupProvider } from '../../types/databaseBackup';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import { BackupOAuth } from './BackupOAuth';
import { BackupProviderMark } from './BackupProviderMark';
import styles from './DatabaseBackups.module.css';

export const BACKUP_PROVIDERS: { value: BackupProvider; label: string }[] = [
  { value: 'onedrive', label: 'OneDrive' },
  { value: 'drive', label: 'Google Drive' },
  { value: 's3', label: 'S3 / R2' },
  { value: 'webdav', label: 'WebDAV' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'smb', label: 'SMB' },
  { value: 'ftp', label: 'FTP / FTPS' },
];
export type DestinationInput = BackupAutomationInput['destinations'][number];
type Field = { key: string; label: MessageKey; isSecret?: boolean; isOptional?: boolean };
const FIELDS: Record<BackupProvider, Field[]> = {
  onedrive: [],
  drive: [],
  webdav: [
    { key: 'url', label: 'sys.backup_field_url' },
    { key: 'user', label: 'sys.backup_field_user', isOptional: true },
    { key: 'pass', label: 'sys.backup_field_password', isSecret: true, isOptional: true },
  ],
  s3: [
    { key: 'endpoint', label: 'sys.backup_field_endpoint', isOptional: true },
    { key: 'access_key_id', label: 'sys.backup_field_access_key' },
    { key: 'secret_access_key', label: 'sys.backup_field_secret_key', isSecret: true },
  ],
  sftp: [
    { key: 'host', label: 'sys.backup_field_host' },
    { key: 'user', label: 'sys.backup_field_user' },
    { key: 'pass', label: 'sys.backup_field_password', isSecret: true, isOptional: true },
    { key: 'host_keys', label: 'sys.backup_field_host_key' },
  ],
  smb: [
    { key: 'host', label: 'sys.backup_field_host' },
    { key: 'user', label: 'sys.backup_field_user' },
    { key: 'pass', label: 'sys.backup_field_password', isSecret: true },
  ],
  ftp: [
    { key: 'host', label: 'sys.backup_field_host' },
    { key: 'user', label: 'sys.backup_field_user' },
    { key: 'pass', label: 'sys.backup_field_password', isSecret: true },
  ],
};
interface Props {
  value: DestinationInput;
  hasConnection?: boolean;
  isBusy: boolean;
  onApply: (value: DestinationInput) => Promise<void>;
  onBack: () => void;
}
export function BackupDestination({
  value,
  hasConnection = false,
  isBusy,
  onApply,
  onBack,
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [isWorking, setIsWorking] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const isOAuth = draft.provider === 'drive' || draft.provider === 'onedrive';
  const setOption = (key: string, next: string) =>
    setDraft((current) => ({ ...current, options: { ...current.options, [key]: next } }));
  const blocked = isBusy || isWorking;
  const canSave =
    draft.name.trim() &&
    (!['s3', 'smb'].includes(draft.provider) || !!draft.root.trim()) &&
    (isOAuth
      ? hasConnection || !!draft.authorization_id
      : hasConnection ||
        FIELDS[draft.provider].every(
          (field) => field.isOptional || !!draft.options?.[field.key]?.trim()
        ));
  const apply = async () => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      await onApply(draft);
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_auto_error'));
    } finally {
      setIsWorking(false);
    }
  };
  return (
    <section className={styles['form']}>
      <div className={styles['connect-head']}>
        <BackupProviderMark provider={draft.provider} size={40} />
        <span className={styles['hint']}>
          {t(isOAuth ? 'sys.backup_destination_kind_account' : 'sys.backup_destination_kind_server')}
        </span>
      </div>
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      {isOAuth ? (
        <BackupOAuth
          provider={draft.provider as 'drive' | 'onedrive'}
          hasConnection={hasConnection || !!draft.authorization_id}
          onAuthorized={(authorization_id) =>
            setDraft((current) => ({ ...current, authorization_id }))
          }
        />
      ) : (
        FIELDS[draft.provider].map((field) => (
          <label className={styles['field']} key={field.key}>
            <span>{t(field.label)}</span>
            {field.isSecret ? (
              <SecretInput
                value={draft.options?.[field.key] ?? ''}
                disabled={blocked}
                maxLength={32768}
                onChange={(event) => setOption(field.key, event.target.value)}
              />
            ) : (
              <Input
                value={draft.options?.[field.key] ?? ''}
                disabled={blocked}
                maxLength={2048}
                onChange={(event) => setOption(field.key, event.target.value)}
              />
            )}
          </label>
        ))
      )}
      {(!isOAuth || hasConnection || !!draft.authorization_id) && (
        <>
          <label className={styles['field']}>
            <span>
              {t(
                draft.provider === 's3'
                  ? 'sys.backup_field_bucket_path'
                  : draft.provider === 'smb'
                    ? 'sys.backup_field_share_path'
                    : 'sys.backup_destination_root'
              )}
            </span>
            <Input
              value={draft.root}
              maxLength={1024}
              disabled={blocked}
              onChange={(event) => setDraft({ ...draft, root: event.target.value })}
            />
          </label>
          <details className={styles['advanced']}>
            <summary>{t('sys.backup_advanced')}</summary>
            <div className={styles['form']}>
              <label className={styles['field']}>
                <span>{t('sys.backup_destination_name')}</span>
                <Input
                  value={draft.name}
                  maxLength={100}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              {hasConnection && <p className={styles['hint']}>{t('sys.backup_keep_connection')}</p>}
              {draft.provider === 's3' && (
                <>
                  <label className={styles['field']}>
                    <span>{t('sys.backup_field_s3_provider')}</span>
                    <Select
                      value={draft.options?.provider ?? 'Other'}
                      options={['Other', 'AWS', 'Cloudflare', 'Minio'].map((provider) => ({
                        value: provider,
                        label: provider === 'Other' ? t('sys.backup_field_s3_other') : provider,
                      }))}
                      onChange={(provider) => setOption('provider', provider)}
                    />
                  </label>
                  <label className={styles['field']}>
                    <span>{t('sys.backup_field_region')}</span>
                    <Input
                      value={draft.options?.region ?? ''}
                      onChange={(event) => setOption('region', event.target.value)}
                    />
                  </label>
                </>
              )}
              {['sftp', 'smb', 'ftp'].includes(draft.provider) && (
                <label className={styles['field']}>
                  <span>{t('sys.backup_field_port')}</span>
                  <Input
                    value={draft.options?.port ?? ''}
                    inputMode="numeric"
                    onChange={(event) => setOption('port', event.target.value)}
                  />
                </label>
              )}
              {draft.provider === 'sftp' && (
                <label className={styles['field']}>
                  <span>{t('sys.backup_field_private_key')}</span>
                  <SecretInput
                    value={draft.options?.key_pem ?? ''}
                    maxLength={32768}
                    onChange={(event) => setOption('key_pem', event.target.value)}
                  />
                </label>
              )}
              {draft.provider === 'smb' && (
                <label className={styles['field']}>
                  <span>{t('sys.backup_field_domain')}</span>
                  <Input
                    value={draft.options?.domain ?? ''}
                    onChange={(event) => setOption('domain', event.target.value)}
                  />
                </label>
              )}
              {draft.provider === 'ftp' && (
                <label className={styles['field']}>
                  <span>{t('sys.backup_field_transport')}</span>
                  <Select
                    value={
                      draft.options?.tls === 'true'
                        ? 'implicit'
                        : draft.options?.explicit_tls === 'false'
                          ? 'plain'
                          : 'explicit'
                    }
                    options={[
                      { value: 'explicit', label: 'FTPS (Explicit TLS)' },
                      { value: 'implicit', label: 'FTPS (TLS)' },
                      { value: 'plain', label: 'FTP' },
                    ]}
                    onChange={(mode) =>
                      setDraft((current) => ({
                        ...current,
                        options: {
                          ...current.options,
                          explicit_tls: String(mode === 'explicit'),
                          tls: String(mode === 'implicit'),
                        },
                      }))
                    }
                  />
                </label>
              )}
            </div>
          </details>
        </>
      )}
      <div className={styles['actions']}>
        <Button onClick={onBack} disabled={blocked}>
          {t('common.cancel')}
        </Button>
        <Button
          type="primary"
          loading={isWorking}
          disabled={blocked || !canSave}
          onClick={() => void apply()}
        >
          {t('sys.backup_destination_save')}
        </Button>
      </div>
    </section>
  );
}
export function providerLabel(provider: BackupProvider): string {
  return BACKUP_PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}
export function newBackupDestination(provider: BackupProvider): DestinationInput {
  return {
    id: '',
    provider,
    name: providerLabel(provider),
    root: provider === 's3' || provider === 'smb' ? '' : 'OMC Backups',
    options:
      provider === 'ftp'
        ? { explicit_tls: 'true' }
        : provider === 's3'
          ? { provider: 'Other' }
          : {},
  };
}
