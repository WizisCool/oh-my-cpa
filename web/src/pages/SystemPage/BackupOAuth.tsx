import { useEffect, useState } from 'react';
import { Button, Checkbox, Input, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api, apiErrorCode } from '../../api/client';
import { SecretInput } from '../../components/common/SecretInput';
import { Notice } from '../../components/feedback';
import { useT } from '../../i18n';
import { databaseBackupErrorKey } from '../../utils/databaseBackupErrors';
import type { MessageKey } from '../../i18n/catalog';
import type { BackupAuthorization } from '../../types/databaseBackup';
import styles from './DatabaseBackups.module.css';

interface Props {
  provider: 'drive' | 'onedrive';
  hasConnection: boolean;
  onAuthorized: (id: string) => void;
}
export function BackupOAuth({ provider, hasConnection, onAuthorized }: Props) {
  const t = useT();
  const [session, setSession] = useState<BackupAuthorization | null>(null);
  const [callback, setCallback] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [hasAutomaticCallback, setHasAutomaticCallback] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const status = useQuery({
    queryKey: ['backup-authorization', session?.id],
    queryFn: () => api.getBackupAuthorization(session!.id),
    enabled: !!session && session.status === 'waiting' && !!clientId && hasAutomaticCallback,
    retry: false,
    refetchInterval: (query) =>
      query.state.error || query.state.data?.status !== 'waiting' ? false : 2000,
  });
  useEffect(() => {
    if (status.data && status.data.status !== 'waiting' && session?.status === 'waiting') {
      setSession(status.data);
      setCallback('');
      if (status.data.status === 'connected') {
        setClientSecret('');
        onAuthorized(status.data.id);
      } else setErrorKey('sys.backup_oauth_error');
    }
  }, [status.data, session?.status, onAuthorized]);
  const run = async (action: () => Promise<void>) => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      await action();
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_oauth_error'));
    } finally {
      setIsWorking(false);
    }
  };
  const connected = hasConnection || session?.status === 'connected';
  return (
    <div className={styles['content']}>
      {connected && (
        <Notice
          tone="success"
          title={t('sys.backup_oauth_connected')}
        />
      )}
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      {status.error && <Notice tone="error" title={t('sys.backup_oauth_error')} />}
      {!session && (
        <>
          <p className={styles['hint']}>{t('sys.backup_oauth_intro')}</p>
          <details className={styles['advanced']}>
            <summary>{t('sys.backup_oauth_own_app')}</summary>
            <div className={styles['content']}>
              <label className={styles['field']}>
                <span>{t('sys.backup_oauth_client_id')}</span>
                <Input
                  value={clientId}
                  maxLength={1024}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </label>
              <label className={styles['field']}>
                <span>{t('sys.backup_oauth_client_secret')}</span>
                <SecretInput
                  value={clientSecret}
                  maxLength={4096}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </label>
              <Checkbox
                checked={hasAutomaticCallback}
                onChange={(event) => setHasAutomaticCallback(event.target.checked)}
              >
                {t('sys.backup_oauth_auto_return')}
              </Checkbox>
              <p className={styles['hint']}>{t('sys.backup_oauth_register_callback')}</p>
              <code className={styles['hint']}>{api.databaseBackupOAuthCallbackUrl()}</code>
            </div>
          </details>
          <Button
            type={connected ? 'default' : 'primary'}
            loading={isWorking}
            onClick={() =>
              void run(async () => {
                const next = await api.startBackupAuthorization({
                  provider,
                  client_id: clientId,
                  client_secret: clientSecret,
                  automatic_callback: !!clientId && hasAutomaticCallback,
                });
                setSession(next);
              })
            }
          >
            {t(connected ? 'sys.backup_oauth_reconnect' : 'sys.backup_oauth_connect')}
          </Button>
        </>
      )}
      {session?.status === 'waiting' && (
        <>
          <Button
            type="primary"
            href={session.authorization_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('sys.backup_oauth_open')}
          </Button>
          {!!clientId && hasAutomaticCallback ? (
            <p role="status" className={styles['hint']}>
              {t('sys.backup_oauth_waiting')}
            </p>
          ) : (
            <>
              <p className={styles['hint']}>{t('sys.backup_oauth_return_hint')}</p>
              <label className={styles['field']}>
                <span>{t('sys.backup_oauth_callback')}</span>
                <SecretInput
                  value={callback}
                  maxLength={16384}
                  disabled={isWorking}
                  onChange={(event) => setCallback(event.target.value)}
                />
              </label>
              <Button
                aria-label={t('sys.backup_oauth_finish')}
                loading={isWorking}
                disabled={isWorking || !callback.trim()}
                onClick={() =>
                  void run(async () => {
                    const next = await api.completeBackupAuthorization(session.id, callback);
                    setSession(next);
                    setCallback('');
                    setClientSecret('');
                    onAuthorized(next.id);
                  })
                }
              >
                {t('sys.backup_oauth_finish')}
              </Button>
            </>
          )}
        </>
      )}
      {session && session.status !== 'connected' && (
        <Space>
          <Button
            type="text"
            disabled={isWorking}
            onClick={() =>
              void run(async () => {
                await api.cancelBackupAuthorization(session.id);
                setSession(null);
                setCallback('');
              })
            }
          >
            {t('sys.backup_oauth_restart')}
          </Button>
        </Space>
      )}
    </div>
  );
}
