import React from 'react';
import { Alert, Button, Input, Skeleton, Tag } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { SafetyCertificateOutlined, WarningOutlined } from '../../components/icons';
import { CodeBlock } from '../../components/workspace/ModelMarkdown';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { decideOperation, failureCode, getOperation, startOperationOAuth } from './api';
import { failureKey, previewEntries, statusTone, turnLabelKey } from './state';
import type { Operation } from './state';
import styles from './AgentPage.module.css';

/**
 * A prepared operation, waiting for the operator.
 *
 * The approval is a decision about one target at one revision, so the card leads with both, lays
 * the proposed change out as fields rather than as a JSON dump where it can, and - for a
 * destructive capability - asks for the target identifier to be typed. The challenge is never
 * prefilled or offered for copying: typing it is the confirmation.
 */
export const OperationCard = React.memo(function OperationCard({ id, onSettled }: { id: string; onSettled: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const operation = useQuery({
    queryKey: ['agent-operation', id],
    queryFn: ({ signal }) => getOperation(id, signal),
    // A decision is made in this tab or not at all, so polling is only worth paying for while the
    // operation is still open.
    refetchInterval: query => (query.state.data?.status === 'pending' ? 5000 : false),
  });
  const [challenge, setChallenge] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [oauth, setOAuth] = React.useState<{ url: string; user_code: string }>();
  const [pendingAction, setPendingAction] = React.useState<'approve' | 'reject' | 'oauth' | ''>('');
  const [error, setError] = React.useState('');

  const applyResult = React.useCallback((result: Operation) => {
    queryClient.setQueryData(['agent-operation', id], result);
    for (const key of result.result.invalidates ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
    onSettled();
  }, [id, onSettled, queryClient]);

  const decide = async (approve: boolean) => {
    if (pendingAction) return;
    setPendingAction(approve ? 'approve' : 'reject');
    setError('');
    try {
      applyResult(await decideOperation(id, approve, challenge, secret));
      setSecret('');
    } catch (cause) {
      setError(failureCode(cause));
    } finally {
      setPendingAction('');
    }
  };

  const startOAuth = async () => {
    if (pendingAction) return;
    setPendingAction('oauth');
    setError('');
    try {
      setOAuth(await startOperationOAuth(id));
    } catch (cause) {
      setError(failureCode(cause));
    } finally {
      setPendingAction('');
    }
  };

  if (!operation.data) {
    return (
      <div className={styles['operation']} data-testid="agent-operation">
        {operation.isError
          ? <Alert type="error" title={t('agent.failed')} />
          : <Skeleton active={false} paragraph={{ rows: 2 }} title={false} />}
      </div>
    );
  }

  const value = operation.data;
  const isPending = value.status === 'pending';
  const isDestructive = Boolean(value.preview.challenge);
  const isChallengeMatched = !value.preview.challenge || challenge === value.preview.challenge;
  const canApprove = isPending && !pendingAction && isChallengeMatched
    && (value.human_input !== 'secret' || !!secret)
    && (value.human_input !== 'oauth' || !!oauth);
  const entries = previewEntries(value.preview.changes);

  return (
    <section
      className={clsx(styles['operation'], isPending && styles['is-pending'], isDestructive && styles['is-destructive'])}
      data-testid="agent-operation"
      aria-label={t('agent.operation.title')}
    >
      <header className={styles['operation-head']}>
        {isPending
          ? <WarningOutlined className={styles['operation-icon']} aria-hidden="true" />
          : <SafetyCertificateOutlined className={styles['operation-icon']} aria-hidden="true" />}
        <span className={styles['operation-title']}>{t(isPending ? 'agent.operation.title' : 'agent.operation.decided')}</span>
        <code className={styles['operation-capability']}>{value.capability}</code>
        {isDestructive && <Tag color="error">{t('agent.permission.destructive')}</Tag>}
        <span className={workspace['foot-spacer']} />
        <span className={workspace['status']}>
          <span className={workspace['pip']} data-tone={statusTone(value.status)} aria-hidden="true" />
          {t(turnLabelKey({ status: value.status }))}
        </span>
      </header>
      <dl className={styles['operation-fields']}>
        <div className={styles['operation-field-row']}>
          <dt>{t('agent.operation.target')}</dt>
          <dd><code>{value.preview.target}</code></dd>
        </div>
        {entries?.map(([label, text]) => (
          <div key={label} className={styles['operation-field-row']}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      {value.preview.changes !== undefined && !entries && (
        <CodeBlock lang="json" block>{JSON.stringify(value.preview.changes, null, 2)}</CodeBlock>
      )}
      {isPending && (
        <div className={styles['operation-decision']}>
          {isDestructive && (
            <div className={workspace['field']}>
              <label className={workspace['field-label']} htmlFor={`challenge-${id}`}>
                <span>{t('agent.challenge.prompt', { target: value.preview.challenge ?? '' })}</span>
              </label>
              <Input
                id={`challenge-${id}`}
                aria-label={t('agent.challenge')}
                placeholder={value.preview.challenge}
                autoComplete="off"
                spellCheck={false}
                value={challenge}
                status={challenge && !isChallengeMatched ? 'error' : undefined}
                onChange={event => setChallenge(event.target.value)}
              />
            </div>
          )}
          {value.human_input === 'secret' && (
            <div className={workspace['field']}>
              <label className={workspace['field-label']} htmlFor={`secret-${id}`}>{t('agent.private_input')}</label>
              <Input.Password
                id={`secret-${id}`}
                autoComplete="new-password"
                aria-label={t('agent.private_input')}
                value={secret}
                onChange={event => setSecret(event.target.value)}
              />
            </div>
          )}
          {value.human_input === 'oauth' && (
            <div className={workspace['field']}>
              {oauth ? (
                <div className={styles['oauth']}>
                  <a href={oauth.url} target="_blank" rel="noopener noreferrer">{t('agent.oauth')}</a>
                  {oauth.user_code && <code className={styles['oauth-code']}>{oauth.user_code}</code>}
                </div>
              ) : (
                <Button loading={pendingAction === 'oauth'} disabled={!!pendingAction} onClick={() => void startOAuth()}>{t('agent.oauth')}</Button>
              )}
            </div>
          )}
          <div className={styles['operation-actions']}>
            <Button disabled={!!pendingAction} loading={pendingAction === 'reject'} onClick={() => void decide(false)}>{t('agent.reject')}</Button>
            <Button
              type="primary"
              danger={isDestructive}
              loading={pendingAction === 'approve'}
              disabled={!canApprove}
              onClick={() => void decide(true)}
            >
              {t('agent.approve')}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className={styles['failure']} role="alert">
          <span>{t(failureKey(error))}</span>
          <code>{error}</code>
        </div>
      )}
    </section>
  );
});
