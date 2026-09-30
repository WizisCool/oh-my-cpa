import React from 'react';
import { Button, Input, Modal, Tag } from 'antd';
import { CodeBlock } from '../../components/workspace/ModelMarkdown';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { capabilityDescription, capabilityTitle } from '../../i18n/capabilities';
import { Notice } from '../../components/feedback';
import { decideOperation, failureCode, startOperationOAuth } from './api';
import { failureKey, previewEntries } from './state';
import type { Capability, Operation } from './state';
import styles from './AgentPage.module.css';

export interface AuthorizationDialogProps {
  operation: Operation;
  capability?: Capability;
  isOpen: boolean;
  onClose: () => void;
  onDecided: (operation: Operation) => void;
}

/**
 * The agent asking to change something, as one allow-or-deny decision (ADR 0035).
 *
 * The dialog opens by itself when a run stops for approval, so the request is in front of the
 * operator rather than somewhere in the transcript, and deciding it continues the run: there is
 * no separate resume step. The approval is bound on the server to the revision the preview was
 * read at, which is what makes one click safe - a target that changed in between is refused, not
 * overwritten. Private input and the OAuth hand-off appear here only when the capability needs them.
 */
export function AuthorizationDialog({ operation, capability, isOpen, onClose, onDecided }: AuthorizationDialogProps) {
  const { t } = useI18n();
  const [secret, setSecret] = React.useState('');
  const [oauth, setOAuth] = React.useState<{ url: string; user_code: string }>();
  const [pendingAction, setPendingAction] = React.useState<'approve' | 'reject' | 'oauth' | ''>('');
  const [error, setError] = React.useState('');

  const permission = operation.permission ?? capability?.permission ?? 'write';
  const isDestructive = permission === 'destructive';
  const entries = previewEntries(operation.preview.changes);
  const title = capabilityTitle(operation.capability, t);
  const description = capabilityDescription(operation.capability, capability?.description ?? '', t);
  const canApprove = !pendingAction
    && (operation.human_input !== 'secret' || !!secret)
    && (operation.human_input !== 'oauth' || !!oauth);

  const decide = async (approve: boolean) => {
    if (pendingAction) return;
    setPendingAction(approve ? 'approve' : 'reject');
    setError('');
    try {
      const decided = await decideOperation(operation.id, approve, operation.human_input === 'secret' && approve ? { secret } : {});
      setSecret('');
      onDecided(decided);
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
    <Modal
      open={isOpen}
      title={t('agent.operation.title')}
      onCancel={onClose}
      mask={{ closable: false }}
      destroyOnHidden
      width={520}
      footer={(
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
      )}
    >
      <div className={styles['authorization']} data-testid="agent-authorization">
        <p className={styles['authorization-lead']}>{t('agent.operation.lead')}</p>
        <div className={styles['operation-head']}>
          {title !== operation.capability && <span className={styles['authorization-capability']}>{title}</span>}
          <code className={styles['operation-capability']}>{operation.capability}</code>
          <Tag color={isDestructive ? 'error' : 'warning'}>{t(`agent.permission.${permission}`)}</Tag>
        </div>
        {description && <p className={styles['authorization-description']}>{description}</p>}
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
        {isDestructive && <Notice tone="error" title={t('agent.operation.irreversible')} />}
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
      </div>
    </Modal>
  );
}
