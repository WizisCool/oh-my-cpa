import React from 'react';
import { Segmented, Tag } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ToolApprovalResponse } from '@assistant-ui/react';
import { CopyButton } from '../../components/common/CopyButton';
import { Notice } from '../../components/feedback';
import { CodeBlock } from '../../components/workspace/ModelMarkdown';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { getAppConfig } from '../../types/config';
import { decideOperation, getOperation } from './api';
import { CONNECT_CLIENTS, connectSnippet, isInsecureOrigin, mcpEndpoint } from './connect';
import type { ConnectClient } from './connect';
import { ApprovalCard } from './interrupts/ApprovalCard';
import { callStatusKey, statusTone } from './state';
import type { Capability } from './state';
import styles from './AgentPage.module.css';

const CLIENT_LABELS: Record<ConnectClient, string> = { claude: 'Claude Code', codex: 'Codex', other: '', stdio: '' };

/**
 * An operation an external agent prepared, opened from the approval link it was given.
 *
 * It has no transcript to sit in - the conversation that raised it is in another program - so it
 * is decided here, on the same card and through the same decision endpoint as the built-in
 * Agent's own (ADR 0035). The link only names the operation; the session cookie is what decides.
 */
function LinkedOperation({ operationID, capabilities }: { operationID: string; capabilities: Capability[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const operation = useQuery({
    queryKey: ['agent-operation', operationID],
    queryFn: ({ signal }) => getOperation(operationID, signal),
    retry: false,
    refetchInterval: query => (query.state.data?.status === 'pending' ? 5000 : false),
  });

  const respond = React.useCallback(async (response: ToolApprovalResponse) => {
    // The card only ever answers allow or deny; the framework's other response shape is a refusal here.
    const isApproved = 'approved' in response && response.approved;
    const decided = await decideOperation(operationID, isApproved, isApproved && response.text ? { secret: response.text } : {});
    queryClient.setQueryData(['agent-operation', operationID], decided);
    for (const key of decided.result.invalidates ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
  }, [operationID, queryClient]);

  if (operation.isPending) return null;
  const data = operation.data;
  return (
    <section className={styles['connect-operation']} data-testid="agent-linked-operation" aria-label={t('agent.connect.operation.title')}>
      <h3 className={styles['connect-label']}>{t('agent.connect.operation.title')}</h3>
      {!data && <Notice tone="warning" title={t('agent.connect.operation.missing')} />}
      {data?.status === 'pending' && (
        <ApprovalCard operation={data} capability={capabilities.find(item => item.name === data.capability)} respond={respond} />
      )}
      {data && data.status !== 'pending' && (
        <p className={styles['connect-settled']}>
          <code>{data.capability}</code>
          <Tag color={statusTone(data.status, data.result.code)}>{t(callStatusKey({ name: data.capability, result: data.result.status ? data.result : { status: data.status } }))}</Tag>
        </p>
      )}
    </section>
  );
}

export interface ExternalAgentGuideProps {
  capabilities: Capability[];
  /** The operation named by an approval link, or '' when the page was opened without one. */
  operationID: string;
  isDemo: boolean;
}

/**
 * How a program other than this page reaches the same capabilities.
 *
 * The address and every snippet are built from where the operator is reading this, so what is
 * copied is the deployment's real endpoint behind its real base path rather than an example to
 * edit. The management key is never drawn: the console does not hold it, and the snippets name
 * the environment variable to read it from wherever the client allows.
 */
export const ExternalAgentGuide = React.memo(function ExternalAgentGuide({ capabilities, operationID, isDemo }: ExternalAgentGuideProps) {
  const { t } = useI18n();
  const [client, setClient] = React.useState<ConnectClient>('claude');
  const { basePath } = getAppConfig();
  const origin = window.location.origin;
  const endpoint = mcpEndpoint(origin, basePath);
  const snippet = connectSnippet(client, origin, basePath, t('agent.connect.key_placeholder'));
  const clientLabel = (value: ConnectClient) => CLIENT_LABELS[value] || t(`agent.connect.client.${value}`);

  return (
    <div className={workspace['panel']} data-testid="agent-connect">
      {operationID && !isDemo && <LinkedOperation operationID={operationID} capabilities={capabilities} />}
      <div className={styles['connect']}>
        <div className={workspace['section-head']}>
          <h2 className={workspace['section-title']}>{t('agent.connect.title')}</h2>
        </div>
        <p className={workspace['field-hint']}>{t('agent.connect.hint')}</p>
        {isDemo && <Notice tone="info" title={t('agent.connect.demo')} />}
        {!isDemo && isInsecureOrigin(origin) && <Notice tone="warning" title={t('agent.connect.insecure')} />}

        <h3 className={styles['connect-label']}>{t('agent.connect.endpoint')}</h3>
        <div className={styles['connect-endpoint']}>
          <code data-testid="agent-connect-endpoint">{endpoint}</code>
          <CopyButton text={endpoint} label={t('agent.connect.copy_endpoint')} />
        </div>

        <h3 className={styles['connect-label']}>{t('agent.connect.client')}</h3>
        <div className={styles['connect-clients']}>
          <Segmented
            size="small"
            aria-label={t('agent.connect.client')}
            value={client}
            options={CONNECT_CLIENTS.map(value => ({ value, label: clientLabel(value) }))}
            onChange={value => setClient(value as ConnectClient)}
          />
        </div>
        <p className={workspace['field-hint']}>{t(`agent.connect.client.${client}.note`)}</p>
        <div data-testid="agent-connect-snippet">
          <CodeBlock lang={snippet.lang} block>{snippet.code}</CodeBlock>
        </div>

        <h3 className={styles['connect-label']}>{t('agent.connect.notes')}</h3>
        <ul className={styles['connect-notes']}>
          <li>{t('agent.connect.notes.key')}</li>
          <li>{t('agent.connect.notes.approval')}</li>
          <li>{t('agent.connect.notes.scope')}</li>
        </ul>
      </div>
    </div>
  );
});
