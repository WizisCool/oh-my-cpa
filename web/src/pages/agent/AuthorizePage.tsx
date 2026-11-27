import { translateOr } from '../../i18n/catalog';
import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ToolApprovalResponse } from '@assistant-ui/react';
import { Button } from '@/components/ui/button';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import { AuthorizeCardSkeleton } from '../../components/common/PageLoading';
import { PreferenceMenus } from '../../components/common/PreferenceMenus';
import { StatusLabel } from '../../components/common/StatusLabel';
import { Tag } from '../../components/common/Tag';
import { ApiError } from '../../api/client';
import { LoadFailure, Notice } from '../../components/feedback';
import { RightOutlined } from '../../components/icons';
import { workspaceStatusTone } from '../../components/workspace/conversationLabels';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useI18n } from '../../i18n';
import { capabilityTitle } from '../../i18n/capabilities';
import { isDemoMode } from '../../types/demoMode';
import { formatErrorCode } from '../../utils/format';
import { decideOperation, getCapabilities, getOperation } from './api';
import { isOperationID } from './connect';
import { ApprovalCard, OperationPreview } from './interrupts/ApprovalCard';
import { callStatusKey, failureKey, statusTone } from './state';
import type { Operation } from './state';
import agentStyles from './AgentPage.module.css';
import styles from './AuthorizePage.module.css';

/**
 * The consent screen an external agent's approval link opens.
 *
 * It is drawn outside the console's shell, in the sign-in page's frame, because it is the same
 * kind of moment: the operator arrives from another program to answer one question, and the
 * sign-in gate has just established who is answering. Navigation, a transcript or a side panel
 * would be things to look at instead of the request. The page says who is asking, on which
 * deployment, for what, and offers Deny and Allow; once decided, it keeps the request on screen
 * and states the outcome under it, with the reason when it failed.
 *
 * The address only names the operation; the decision goes through the same card logic and
 * decision endpoint as the built-in Agent's approvals, under the operator's session.
 */
export function AuthorizePage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const { id = '' } = useParams();
  const operationID = isOperationID(id) ? id : '';
  const canRead = !!operationID && !isDemo;

  const operation = useQuery({
    queryKey: ['agent-operation', operationID],
    queryFn: ({ signal }) => getOperation(operationID, signal),
    enabled: canRead,
    retry: false,
    // Another tab, or the request's own expiry, may settle it while this page is open.
    refetchInterval: query => (query.state.data?.status === 'pending' ? 5000 : false),
  });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: ({ signal }) => getCapabilities(signal), enabled: canRead });

  const respond = React.useCallback(async (response: ToolApprovalResponse) => {
    // The card only ever answers allow or deny; the framework's other response shape is a refusal here.
    const isApproved = 'approved' in response && response.approved;
    const decided = await decideOperation(operationID, isApproved, isApproved && response.text ? { secret: response.text } : {});
    queryClient.setQueryData(['agent-operation', operationID], decided);
    for (const key of decided.result.invalidates ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
  }, [operationID, queryClient]);

  const data = operation.data;
  // Only the server's own "no such operation" means the request is gone; any other failed read
  // may succeed on the next attempt, and telling the operator to start over would be wrong.
  const isGone = operation.error instanceof ApiError && operation.error.status === 404;
  const isMissing = !isDemo && (!operationID || isGone);
  const isUnread = canRead && operation.isError && !isGone && !data;
  const isExternal = data?.adapter !== 'agent';
  const isPending = data?.status === 'pending';
  const title = isMissing ? t('agent.authorize.missing') : t(isExternal ? 'agent.authorize.title' : 'agent.authorize.title.agent');
  useDocumentTitle(title);
  const permission = data?.permission ?? 'write';
  const capability = capabilities.data?.find(item => item.name === data?.capability);

  return (
    <div className="auth-shell" data-testid="agent-authorize-page">
      <header className="auth-header">
        <BrandArtwork shape="wordmark" height={22} className="app-brand-logo" />
        <div className="auth-header-menus"><PreferenceMenus /></div>
      </header>
      <main className="auth-main">
        <section className={`auth-card ${styles['card']}`} aria-labelledby="authorize-title" aria-busy={(canRead && operation.isPending) || undefined}>
          <h1 id="authorize-title" className="terminal-title auth-title">{title}</h1>
          {isMissing && <p className={styles['intro']}>{t('agent.authorize.missing.hint')}</p>}
          {data && (
            <p className={styles['intro']}>
              {t(isExternal ? 'agent.authorize.intro' : 'agent.authorize.intro.agent', { host: window.location.host })}
            </p>
          )}

          {isDemo && <Notice tone="info" title={t('agent.connect.demo')} data-testid="agent-authorize-demo" />}
          {isUnread && (
            <LoadFailure
              title={t('agent.authorize.failed')}
              error={operation.error}
              onRetry={() => void operation.refetch()}
              data-testid="agent-authorize-failed"
            />
          )}
          {canRead && operation.isPending && <AuthorizeCardSkeleton />}

          {data && (
            <article className={styles['request']} aria-label={capabilityTitle(data.capability, t)}>
              <header className={styles['request-head']}>
                <div className={styles['request-name']}>
                  <span className={styles['request-title']}>{capabilityTitle(data.capability, t)}</span>
                  <code className={styles['request-id']}>{data.capability}</code>
                </div>
                <Tag tone={permission === 'destructive' ? 'danger' : 'warn'}>{translateOr(t, `agent.permission.${permission}`, permission)}</Tag>
              </header>
              {isPending ? (
                <ApprovalCard variant="consent" operation={data} capability={capability} respond={respond} />
              ) : (
                <>
                  <div className={styles['request-body']}><OperationPreview operation={data} capability={capability} /></div>
                  <Outcome operation={data} />
                </>
              )}
            </article>
          )}

          {data && <p className={styles['fine']}>{isPending ? <PendingNote operation={data} /> : t('agent.authorize.settled')}</p>}
          <Button variant="link" className={styles['console']} icon={<RightOutlined />} iconPlacement="end" render={<Link to="/agent" />}>
            {t('agent.authorize.console')}
          </Button>
        </section>
      </main>
    </div>
  );
}

/** How a decided request ended, and why, when it did not succeed. */
function Outcome({ operation }: { operation: Operation }) {
  const { t } = useI18n();
  const result = operation.result.status ? operation.result : { ...operation.result, status: operation.status };
  const tone = statusTone(result.status, result.code);
  // A denial and an expiry are the operator's own outcome, not a failure to explain.
  const hasReason = !!result.code && tone !== 'success' && result.status !== 'rejected';
  // "May have been applied" leads an uncertain outcome even when it carries its own detail, so
  // the operator checks the target before asking for the change again.
  const isUncertain = result.status === 'uncertain';
  return (
    <footer className={styles['outcome']} data-testid="agent-authorize-outcome" data-status={result.status}>
      <StatusLabel tone={workspaceStatusTone(tone)}>{t(callStatusKey({ name: operation.capability, result }))}</StatusLabel>
      {hasReason && (
        <div className={agentStyles['failure']} data-tone={tone === 'warning' ? 'warning' : undefined}>
          <span>{isUncertain || !result.detail ? t(operationFailureKey(result.status, result.code ?? '')) : result.detail}</span>
          {isUncertain && result.detail && <span>{result.detail}</span>}
          <code>{formatErrorCode({ code: result.code })}</code>
        </div>
      )}
    </footer>
  );
}

/**
 * An operation's own failure sentence. A conflict here means the target moved after the preview
 * was read - the revision check refused it - not that the conversation changed, which is what
 * the same code means on the Agent's run endpoints. An uncertain outcome is never described as
 * blocked: whatever its code, the change may already have been applied.
 */
function operationFailureKey(status: string, code: string) {
  if (status === 'uncertain') return 'agent.error.uncertain';
  return code === 'resource_conflict' ? 'agent.error.target_changed' : failureKey(code);
}

/** What allowing does, and how long the request waits for it. */
function PendingNote({ operation }: { operation: Operation }) {
  const { t } = useI18n();
  const minutesLeft = operation.expires_at_ms ? Math.max(1, Math.ceil((operation.expires_at_ms - Date.now()) / 60_000)) : 0;
  return (
    <>
      <span>{t('agent.authorize.fine')}</span>
      {minutesLeft > 0 && <span>{t('agent.authorize.expires', { minutes: String(minutesLeft) })}</span>}
    </>
  );
}
