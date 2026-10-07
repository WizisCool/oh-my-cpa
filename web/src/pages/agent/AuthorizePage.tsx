import React from 'react';
import { Tag } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ToolApprovalResponse } from '@assistant-ui/react';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import { ParagraphPlaceholder } from '../../components/common/ContentPlaceholder';
import { PreferenceMenus } from '../../components/common/PreferenceMenus';
import { ApiError } from '../../api/client';
import { LoadFailure, Notice } from '../../components/feedback';
import { CheckCircleOutlined, CloseCircleOutlined, RobotOutlined, SwapOutlined } from '../../components/icons';
import { LobeIcon } from '../../components/LobeIcon';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useI18n } from '../../i18n';
import { capabilityTitle } from '../../i18n/capabilities';
import { isDemoMode } from '../../types/demoMode';
import { decideOperation, getCapabilities, getOperation } from './api';
import { isOperationID } from './connect';
import { ApprovalCard } from './interrupts/ApprovalCard';
import { callStatusKey, statusTone } from './state';
import styles from './AuthorizePage.module.css';

/**
 * The consent screen an external agent's approval link opens.
 *
 * It is drawn outside the console's shell, on the sign-in page's own column, because it is the
 * same kind of moment: the operator arrives from another program to answer one question, and the
 * sign-in gate has just established who is answering. Navigation, a transcript or a side panel
 * would be things to look at instead of the request. The page says who is asking, on which
 * deployment, for what, and offers Deny and Allow - the shape operators already know from the
 * authorization screens of the services their agents connect to.
 *
 * The address only names the operation; the decision goes through the same card logic and
 * decision endpoint as the built-in Agent's approvals (ADR 0035), under the operator's session.
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
  const minutesLeft = data?.expires_at_ms ? Math.max(1, Math.ceil((data.expires_at_ms - Date.now()) / 60_000)) : 0;
  const host = window.location.host;

  return (
    <div className="auth-shell" data-testid="agent-authorize-page">
      <header className="auth-header">
        <PreferenceMenus />
      </header>
      <main className="auth-main">
        <section className={`auth-card ${styles['card']}`} aria-labelledby="authorize-title" aria-busy={(canRead && operation.isPending) || undefined}>
          {/* Who is asking, and whom: the requester on the left, this deployment on the right. */}
          <div className={styles['parties']} aria-hidden="true">
            <span className={styles['party']}>
              {isExternal ? <LobeIcon iconId="MCP" size={26} variant="mono" /> : <RobotOutlined style={{ fontSize: 26 }} />}
            </span>
            <SwapOutlined className={styles['link']} />
            <span className={styles['party']}><BrandArtwork shape="o" height={26} /></span>
          </div>
          <h1 id="authorize-title" className="terminal-title auth-title">{title}</h1>

          {isDemo && <Notice tone="info" title={t('agent.connect.demo')} data-testid="agent-authorize-demo" />}
          {isMissing && <p className={styles['intro']}>{t('agent.authorize.missing.hint')}</p>}
          {isUnread && (
            <LoadFailure
              title={t('agent.authorize.failed')}
              error={operation.error}
              onRetry={() => void operation.refetch()}
              data-testid="agent-authorize-failed"
            />
          )}
          {canRead && operation.isPending && <ParagraphPlaceholder rows={4} />}

          {data && (
            <>
              <p className={styles['intro']}>
                {t(isExternal ? 'agent.authorize.intro' : 'agent.authorize.intro.agent', { host })}
              </p>
              <div className={styles['request']} data-destructive={permission === 'destructive' || undefined}>
                <div className={styles['request-head']}>
                  <span className={styles['request-title']}>{capabilityTitle(data.capability, t)}</span>
                  <Tag color={permission === 'destructive' ? 'error' : 'warning'}>{t(`agent.permission.${permission}`)}</Tag>
                </div>
                <code className={styles['request-name']}>{data.capability}</code>
                {isPending ? (
                  <ApprovalCard
                    variant="consent"
                    operation={data}
                    capability={capabilities.data?.find(item => item.name === data.capability)}
                    respond={respond}
                  />
                ) : (
                  <p className={styles['outcome']} data-tone={statusTone(data.status, data.result.code)} data-testid="agent-authorize-outcome">
                    {data.status === 'success' ? <CheckCircleOutlined aria-hidden="true" /> : <CloseCircleOutlined aria-hidden="true" />}
                    <span>{t(callStatusKey({ name: data.capability, result: data.result.status ? data.result : { status: data.status } }))}</span>
                  </p>
                )}
              </div>
              <p className={styles['fine']}>
                {isPending
                  ? `${t('agent.authorize.fine')}${minutesLeft ? ` ${t('agent.authorize.expires', { minutes: String(minutesLeft) })}` : ''}`
                  : t('agent.authorize.settled')}
              </p>
            </>
          )}
          <Link className={styles['console']} to="/agent">{t('agent.authorize.console')}</Link>
        </section>
      </main>
    </div>
  );
}
