import React from 'react';
import { clsx } from 'clsx';
import { CopyButton } from '../../components/common/CopyButton';
import { Notice } from '../../components/feedback';
import { CodeSandboxOutlined } from '../../components/icons';
import { LobeIcon } from '../../components/LobeIcon';
import { CodeBlock } from '../../components/workspace/ModelMarkdown';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { getAppConfig } from '../../types/config';
import { CONNECT_CLIENTS, connectSnippet, isInsecureOrigin, mcpEndpoint } from './connect';
import type { ConnectClient } from './connect';
import styles from './AgentPage.module.css';

const CLIENT_LABELS: Record<ConnectClient, string> = { claude: 'Claude Code', codex: 'Codex', other: '', stdio: '' };

/** Each client's own mark; a JSON-configured client is any MCP client, so it carries the protocol's. */
const CLIENT_ICONS: Record<ConnectClient, React.ReactNode> = {
  claude: <LobeIcon iconId="ClaudeCode" size={18} />,
  codex: <LobeIcon iconId="Codex" size={18} />,
  other: <LobeIcon iconId="MCP" size={18} variant="mono" />,
  stdio: <CodeSandboxOutlined />,
};

export interface ExternalAgentGuideProps {
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
export const ExternalAgentGuide = React.memo(function ExternalAgentGuide({ isDemo }: ExternalAgentGuideProps) {
  const { t } = useI18n();
  const [client, setClient] = React.useState<ConnectClient>('claude');
  const { basePath } = getAppConfig();
  const origin = window.location.origin;
  const endpoint = mcpEndpoint(origin, basePath);
  const snippet = connectSnippet(client, origin, basePath, t('agent.connect.key_placeholder'));
  const clientLabel = (value: ConnectClient) => CLIENT_LABELS[value] || t(`agent.connect.client.${value}`);

  return (
    <div className={workspace['panel']} data-testid="agent-connect">
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
        <div className={styles['connect-clients']} role="radiogroup" aria-label={t('agent.connect.client')}>
          {CONNECT_CLIENTS.map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={client === value}
              className={clsx(styles['connect-client'], client === value && styles['is-selected'])}
              onClick={() => setClient(value)}
            >
              <span className={styles['connect-client-icon']} aria-hidden="true">{CLIENT_ICONS[value]}</span>
              <span className={styles['connect-client-label']}>{clientLabel(value)}</span>
            </button>
          ))}
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
