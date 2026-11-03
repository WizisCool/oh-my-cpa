import { startTransition, useEffect, useState } from 'react';
import { Button, Input } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api, apiErrorCode } from '../../api/client';
import { SecretInput } from '../../components/common/SecretInput';
import { Notice } from '../../components/feedback';
import { CheckCircleOutlined, ExternalLinkOutlined } from '../../components/icons';
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

type Step = 'idle' | 'authorizing' | 'paste';

/**
 * Connecting a cloud account, as two steps on one page: open the provider's sign-in page, then
 * come back. When the server can receive the provider's redirect (an HTTPS deployment with a
 * public address) the second step finishes itself; otherwise the operator paste the address the
 * provider sent the browser to, which is the one thing that has to be explained rather than asked.
 */
export function BackupOAuth({ provider, hasConnection, onAuthorized }: Props) {
  const t = useT();
  const [session, setSession] = useState<BackupAuthorization | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [callback, setCallback] = useState('');
  // The OMC server receives the provider's redirect when it has a public address, so it waits for
  // the sign-in to finish by itself. Without a custom application there is no such address to
  // register, and the operator pastes the browser's final address instead.
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [hasAutomaticCallback, setHasAutomaticCallback] = useState(false);
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
  const start = async () => {
    setIsWorking(true);
    setErrorKey(null);
    try {
      const next = await api.startBackupAuthorization({
        provider,
        client_id: clientId,
        client_secret: clientSecret,
        automatic_callback: !!clientId && hasAutomaticCallback,
      });
      // One update, so the next step never appears with its controls still disabled.
      startTransition(() => {
        setSession(next);
        setStep(next.status === 'waiting' ? 'authorizing' : 'idle');
        setIsWorking(false);
      });
    } catch (error) {
      setErrorKey(databaseBackupErrorKey(apiErrorCode(error), 'sys.backup_oauth_error'));
      setIsWorking(false);
    }
  };
  return (
    <div className={styles['connect']}>
      {errorKey && <Notice tone="error" title={t(errorKey)} />}
      {status.error && <Notice tone="error" title={t('sys.backup_oauth_error')} />}
      {connected ? (
        <Notice tone="success" icon={<CheckCircleOutlined />} title={t('sys.backup_oauth_connected')} />
      ) : (
      <ol className={styles['steps']}>
        <li className={styles['step']} data-state={step === 'idle' ? 'active' : 'done'}>
          <span className={styles['step-index']} aria-hidden>
            {step === 'idle' ? 1 : <CheckCircleOutlined />}
          </span>
          <div className={styles['step-body']}>
            <strong>{t('sys.backup_oauth_step_sign_in')}</strong>
            {step === 'idle' ? (
              <>
                <span className={styles['hint']}>{t('sys.backup_oauth_intro')}</span>
                <div className={styles['actions']}>
                  <Button type="primary" loading={isWorking} onClick={() => void start()}>
                    {t('sys.backup_oauth_connect')}
                  </Button>
                </div>
              </>
            ) : (
              <span className={styles['step-value']}>{t('sys.backup_oauth_signed_in')}</span>
            )}
            <details className={styles['advanced']}>
              <summary>{t('sys.backup_oauth_own_app')}</summary>
              <div className={styles['form']}>
                <label className={styles['field']}>
                  <span>{t('sys.backup_oauth_client_id')}</span>
                  <Input
                    value={clientId}
                    maxLength={1024}
                    disabled={step !== 'idle'}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </label>
                <label className={styles['field']}>
                  <span>{t('sys.backup_oauth_client_secret')}</span>
                  <SecretInput
                    value={clientSecret}
                    maxLength={4096}
                    disabled={step !== 'idle'}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                </label>
                <label className={styles['check-row']}>
                  <input
                    type="checkbox"
                    checked={hasAutomaticCallback}
                    disabled={step !== 'idle'}
                    onChange={(event) => setHasAutomaticCallback(event.target.checked)}
                  />
                  {t('sys.backup_oauth_auto_return')}
                </label>
                <p className={styles['hint']}>{t('sys.backup_oauth_register_callback')}</p>
                <code className={styles['callback-url']}>{api.databaseBackupOAuthCallbackUrl()}</code>
              </div>
            </details>
          </div>
        </li>
        <li className={styles['step']} data-state={step === 'idle' ? 'muted' : 'active'}>
          <span className={styles['step-index']} aria-hidden>
            2
          </span>
          <div className={styles['step-body']}>
            <strong>{t('sys.backup_oauth_step_return')}</strong>
            {step === 'idle' && <span className={styles['hint']}>{t('sys.backup_oauth_step_return_hint')}</span>}
            {step === 'authorizing' && (
              <>
                {/* A link the operator clicks, rather than a window opened for them: the browser
                    treats a window opened after the request returns as a pop-up and blocks it. */}
                <div className={styles['actions']}>
                  <Button
                    type="primary"
                    href={session?.authorization_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    icon={<ExternalLinkOutlined />}
                  >
                    {t('sys.backup_oauth_open')}
                  </Button>
                </div>
                {!!clientId && hasAutomaticCallback ? (
                  <p role="status" className={styles['hint']}>{t('sys.backup_oauth_waiting')}</p>
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
                    <div className={styles['actions']}>
                      <Button
                        type="primary"
                        loading={isWorking}
                        disabled={isWorking || !callback.trim()}
                        onClick={() =>
                          void run(async () => {
                            const next = await api.completeBackupAuthorization(session!.id, callback);
                            setSession(next);
                            setCallback('');
                            setClientSecret('');
                            onAuthorized(next.id);
                          })
                        }
                      >
                        {t('sys.backup_oauth_finish')}
                      </Button>
                      <Button
                        type="text"
                        disabled={isWorking}
                        onClick={() =>
                          void run(async () => {
                            await api.cancelBackupAuthorization(session!.id);
                            setSession(null);
                            setStep('idle');
                            setCallback('');
                          })
                        }
                      >
                        {t('sys.backup_oauth_restart')}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </li>
      </ol>
      )}
    </div>
  );
}
