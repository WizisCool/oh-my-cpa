import React from 'react';
import { Button, Tabs } from 'antd';
import {
  CloudServerOutlined,
  LoginOutlined,
  KeyOutlined,
  CodeOutlined,
  ArrowRightOutlined,
} from '../components/icons';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n';
import { PageHeader } from '../components/common/PageHeader';
import { CodeFrame } from '../components/common/CodeFrame';
import { CopyButton } from '../components/common/CopyButton';
import styles from './QuickStartPage.module.css';

interface QuickStartStepProps {
  index: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}

/**
 * One setup step: its number on a rail, then what to do and the control that does it.
 *
 * The rail carries the order, so the titles name the task alone - a title that also said
 * "Step 2" printed the number twice.
 */
function QuickStartStep({ index, icon, title, description, children }: QuickStartStepProps) {
  return (
    <li className={styles['step']}>
      <span className={styles['step-index']} aria-hidden="true">{index}</span>
      <section className={styles['step-body']}>
        <h2 className={styles['step-title']}>
          <span className={styles['step-icon']}>{icon}</span>
          {title}
        </h2>
        <p className={styles['step-desc']}>{description}</p>
        {children}
      </section>
    </li>
  );
}

function EndpointRow({ label, url }: { label: string; url: string }) {
  return (
    <div className={styles['endpoint']}>
      <span className={styles['endpoint-label']}>{label}</span>
      <div className={styles['endpoint-value']}>
        <code>{url}</code>
        <CopyButton text={url} label={label} />
      </div>
    </div>
  );
}

export const QuickStartPage: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();

  const proxyBase = `${window.location.origin}/v1`;

  const authHeader = ['-H', '"' + ['Authorization', 'Bearer <YOUR_CLIENT_KEY>'].join(': ') + '"'].join(' ');
  const snippets = [
    {
      key: 'curl',
      label: t('qs.tab_curl'),
      language: 'bash',
      code: `# Test chat completions via Oh My CPA gateway
curl -X POST "${proxyBase}/chat/completions" \\
  -H "Content-Type: application/json" \\
  ${authHeader} \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello via Oh My CPA!"}]
  }'`,
    },
    {
      key: 'python',
      label: t('qs.tab_python'),
      language: 'python',
      code: `from openai import OpenAI

# Configure client pointing to Oh My CPA gateway
client = OpenAI(
    base_url="${proxyBase}",
    api_key="omc-sk-your-client-key",
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello from Python!"}],
)

print(response.choices[0].message.content)`,
    },
    {
      key: 'nodejs',
      label: t('qs.tab_nodejs'),
      language: 'javascript',
      code: `import OpenAI from 'openai';

// Configure client pointing to Oh My CPA gateway
const client = new OpenAI({
  baseURL: '${proxyBase}',
  apiKey: 'omc-sk-your-client-key',
});

async function main() {
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello from Node.js!' }],
  });

  console.log(response.choices[0].message.content);
}

main();`,
    },
  ];

  return (
    <div className="terminal-page quick-start-page">
      <PageHeader title={t('qs.title')} />

      <ol className={styles['steps']}>
        <QuickStartStep index={1} icon={<CloudServerOutlined />} title={t('qs.step1_title')} description={t('qs.step1_desc')}>
          <div className={styles['step-actions']}>
            <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => navigate('/ai-providers')}>
              {t('qs.step1_btn')}
            </Button>
          </div>
        </QuickStartStep>

        <QuickStartStep index={2} icon={<LoginOutlined />} title={t('qs.step2_title')} description={t('qs.step2_desc')}>
          <div className={styles['step-actions']}>
            <Button type="primary" icon={<LoginOutlined />} onClick={() => navigate('/oauth-management?action=connect')}>
              {t('qs.step2_btn_oauth')}
            </Button>
            <Button icon={<ArrowRightOutlined />} onClick={() => navigate('/oauth-management')}>
              {t('qs.step2_btn_auth')}
            </Button>
          </div>
        </QuickStartStep>

        <QuickStartStep index={3} icon={<KeyOutlined />} title={t('qs.step3_title')} description={t('qs.step3_desc')}>
          <div className={styles['step-actions']}>
            <Button type="primary" icon={<KeyOutlined />} onClick={() => navigate('/api-keys')}>
              {t('qs.step3_btn')}
            </Button>
          </div>
        </QuickStartStep>

        <QuickStartStep index={4} icon={<CodeOutlined />} title={t('qs.step4_title')} description={t('qs.step4_desc')}>
          <div className={styles['endpoints']}>
            <EndpointRow label={t('qs.endpoint_chat')} url={`${proxyBase}/chat/completions`} />
            <EndpointRow label={t('qs.endpoint_models')} url={`${proxyBase}/models`} />
          </div>
          <Tabs
            className={styles['snippets']}
            defaultActiveKey="curl"
            items={snippets.map((snippet) => ({
              key: snippet.key,
              label: snippet.label,
              children: <CodeFrame code={snippet.code} label={snippet.language} />,
            }))}
          />
        </QuickStartStep>
      </ol>
    </div>
  );
};
