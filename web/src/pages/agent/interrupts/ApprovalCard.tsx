import React from 'react';
import { Alert, Button, Input, Skeleton, Tag } from 'antd';
import type { ToolApprovalResponse } from '@assistant-ui/react';
import { CodeBlock } from '../../../components/workspace/ModelMarkdown';
import workspace from '../../../components/workspace/Workspace.module.css';
import { useI18n } from '../../../i18n';
import { capabilityDescription } from '../../../i18n/capabilities';
import { failureCode, startOperationOAuth } from '../api';
import { failureKey, previewEntries } from '../state';
import type { Capability, Operation } from '../state';
import styles from '../AgentPage.module.css';

export interface ApprovalCardProps {
  operation: Operation | undefined;
  capability?: Capability;
  /** The framework's approval response; resolves once the decision is recorded. */
  respond: (response: ToolApprovalResponse) => Promise<void>;
}

/**
 * The agent asking to change something, decided where the call is (ADR 0043).
 *
 * One allow-or-deny decision (ADR 0035), bound on the server to the revision the preview was read
 * at, which is what makes one click safe: a target that changed in between is refused, not
 * overwritten. The card sits in the transcript under the call that raised it, so the answer the
 * operator is deciding about stays in view instead of behind a modal. Private input - a credential,
 * an OAuth hand-off - is collected here and goes only to the decision endpoint; deciding continues
 * the run without a separate step.
 */
export function ApprovalCard({ operation, capability, respond }: ApprovalCardProps) {
  const { t } = useI18n();
  const [secret, setSecret] = React.useState('');
  const [oauth, setOAuth] = React.useState<{ url: string; user_code: string }>();
  const [pendingAction, setPendingAction] = React.useState<'approve' | 'reject' | 'oauth' | ''>('');
  const [error, setError] = React.useState('');

  if (!operation) {
    return (
      <div className={styles['approval']} data-testid="agent-authorization" aria-busy="true">
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      </div>
    );
  }

  const permission = operation.permission ?? capability?.permission ?? 'write';
  const isDestructive = permission === 'destructive';
  const entries = previewEntries(operation.preview.changes);
  const description = capabilityDescription(operation.capability, capability?.description ?? '', t);
  const canApprove = !pendingAction
    && (operation.human_input !== 'secret' || !!secret)
    && (operation.human_input !== 'oauth' || !!oauth);

  const decide = async (approve: boolean) => {
    if (pendingAction) return;
    setPendingAction(approve ? 'approve' : 'reject');
    setError('');
    try {
      await respond(approve && operation.human_input === 'secret' ? { approved: true, text: secret } : { approved: approve });
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
      setOAuth(await startOperationOAuth(operation.id));
    } catch (cause) {
      setError(failureCode(cause));
    } finally {
      setPendingAction('');
    }
  };

  return (
    <section
      className={styles['approval']}
      data-destructive={isDestructive || undefined}
      data-testid="agent-authorization"
      data-approval-id={operation.id}
      aria-label={t('agent.operation.title')}
      tabIndex={-1}
    >
      <header className={styles['approval-head']}>
        <span className={styles['approval-title']}>{t('agent.operation.title')}</span>
        <Tag color={isDestructive ? 'error' : 'warning'}>{t(`agent.permission.${permission}`)}</Tag>
      </header>
      <p className={styles['approval-lead']}>{t('agent.operation.lead')}</p>
      {description && <p className={styles['approval-description']}>{description}</p>}
      <dl className={styles['operation-fields']}>
        <div className={styles['operation-field-row']}>
          <dt>{t('agent.operation.target')}</dt>
          <dd><code>{operation.preview.target}</code></dd>
        </div>
        {entries?.map(([label, text]) => (
          <div key={label} className={styles['operation-field-row']}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      {operation.preview.changes !== undefined && !entries && (
        <CodeBlock lang="json" block>{JSON.stringify(operation.preview.changes, null, 2)}</CodeBlock>
      )}
      {isDestructive && <Alert type="error" showIcon title={t('agent.operation.irreversible')} />}
      {operation.human_input === 'secret' && (
        <div className={workspace['field']}>
          <label className={workspace['field-label']} htmlFor={`secret-${operation.id}`}>{t('agent.private_input')}</label>
          <Input.Password
            id={`secret-${operation.id}`}
            autoComplete="new-password"
            aria-label={t('agent.private_input')}
            value={secret}
            onChange={event => setSecret(event.target.value)}
          />
        </div>
      )}
      {operation.human_input === 'oauth' && (
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
      {error && (
        <div className={styles['failure']} role="alert">
          <span>{t(failureKey(error))}</span>
          <code>{error}</code>
        </div>
      )}
      <footer className={styles['operation-actions']}>
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
      </footer>
    </section>
  );
}
