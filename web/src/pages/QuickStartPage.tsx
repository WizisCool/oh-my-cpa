import React, { useState } from 'react';
import {
  Card,
  Row,
  Col,
  Button,
  Typography,
  Tabs,
  App as AntdApp,
} from 'antd';
import {
  CloudServerOutlined,
  LoginOutlined,
  KeyOutlined,
  CodeOutlined,
  CopyOutlined,
  CheckOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n';
const { Text, Paragraph } = Typography;

export const QuickStartPage: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8080';
  const proxyBase = `${origin}/v1`;

  const handleCopy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      message.success(t('qs.copied'));
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const authHeader = ['-H', '"' + ['Authorization', 'Bearer <YOUR_CLIENT_KEY>'].join(': ') + '"'].join(' ');
  const curlSnippet = `# Test chat completions via Oh My CPA gateway
curl -X POST "${proxyBase}/chat/completions" \\
  -H "Content-Type: application/json" \\
  ${authHeader} \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello via Oh My CPA!"}]
  }'`;

  const pythonSnippet = `from openai import OpenAI

# Configure client pointing to Oh My CPA gateway
client = OpenAI(
    base_url="${proxyBase}",
    api_key="omc-sk-your-client-key",
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello from Python!"}],
)

print(response.choices[0].message.content)`;

  const nodeSnippet = `import OpenAI from 'openai';

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

main();`;

  return (
    <div className="terminal-page quick-start-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('qs.title')}</h1>
          <p className="terminal-subtitle">{t('qs.subtitle')}</p>
        </div>
      </div>

      <Card
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CloudServerOutlined style={{ color: 'var(--ant-color-primary)' }} />
            <span>{t('qs.step1_title')}</span>
          </div>
        }
        style={{ marginBottom: 16 }}
      >
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
          {t('qs.step1_desc')}
        </Paragraph>
        <Button
          type="primary"
          icon={<ArrowRightOutlined />}
          onClick={() => navigate('/ai-providers')}
        >
          {t('qs.step1_btn')}
        </Button>
      </Card>

      <Card
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LoginOutlined style={{ color: 'var(--ant-color-primary)' }} />
            <span>{t('qs.step2_title')}</span>
          </div>
        }
        style={{ marginBottom: 16 }}
      >
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
          {t('qs.step2_desc')}
        </Paragraph>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Button
            type="primary"
            icon={<LoginOutlined />}
            onClick={() => navigate('/oauth')}
          >
            {t('qs.step2_btn_oauth')}
          </Button>
          <Button
            icon={<ArrowRightOutlined />}
            onClick={() => navigate('/auth-files')}
          >
            {t('qs.step2_btn_auth')}
          </Button>
        </div>
      </Card>

      <Card
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <KeyOutlined style={{ color: 'var(--ant-color-primary)' }} />
            <span>{t('qs.step3_title')}</span>
          </div>
        }
        style={{ marginBottom: 16 }}
      >
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
          {t('qs.step3_desc')}
        </Paragraph>
        <Button
          type="primary"
          icon={<KeyOutlined />}
          onClick={() => navigate('/ai-providers')}
        >
          {t('qs.step3_btn')}
        </Button>
      </Card>

      <Card
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CodeOutlined style={{ color: 'var(--ant-color-primary)' }} />
            <span>{t('qs.step4_title')}</span>
          </div>
        }
      >
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
          {t('qs.step4_desc')}
        </Paragraph>

          <div style={{ background: 'var(--card-bg, rgba(0,0,0,0.02))', padding: 16, borderRadius: 6, marginBottom: 20 }}>
          <Row gutter={[16, 12]}>
            <Col xs={24} md={12}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('qs.endpoint_chat')}:</Text>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <code style={{ fontFamily: 'monospace', fontSize: 12, flex: 1, wordBreak: 'break-all' }}>
                  {proxyBase}/chat/completions
                </code>
                <Button
                  size="small"
                  icon={copiedKey === 'chat' ? <CheckOutlined /> : <CopyOutlined />}
                  onClick={() => handleCopy(`${proxyBase}/chat/completions`, 'chat')}
                />
              </div>
            </Col>
            <Col xs={24} md={12}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('qs.endpoint_models')}:</Text>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <code style={{ fontFamily: 'monospace', fontSize: 12, flex: 1, wordBreak: 'break-all' }}>
                  {proxyBase}/models
                </code>
                <Button
                  size="small"
                  icon={copiedKey === 'models' ? <CheckOutlined /> : <CopyOutlined />}
                  onClick={() => handleCopy(`${proxyBase}/models`, 'models')}
                />
              </div>
            </Col>
          </Row>
        </div>

          <Tabs
          defaultActiveKey="curl"
          items={[
            {
              key: 'curl',
              label: t('qs.tab_curl'),
              children: (
                <div style={{ position: 'relative' }}>
                  <pre style={{
                    padding: 16,
                    borderRadius: 6,
                    background: 'var(--code-bg, #1a1a1a)',
                    color: '#e6e6e6',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    overflowX: 'auto',
                    margin: 0,
                  }}>
                    {curlSnippet}
                  </pre>
                  <Button
                    size="small"
                    style={{ position: 'absolute', top: 12, right: 12 }}
                    icon={copiedKey === 'curl_code' ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={() => handleCopy(curlSnippet, 'curl_code')}
                  >
                    {t('qs.copy')}
                  </Button>
                </div>
              ),
            },
            {
              key: 'python',
              label: t('qs.tab_python'),
              children: (
                <div style={{ position: 'relative' }}>
                  <pre style={{
                    padding: 16,
                    borderRadius: 6,
                    background: 'var(--code-bg, #1a1a1a)',
                    color: '#e6e6e6',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    overflowX: 'auto',
                    margin: 0,
                  }}>
                    {pythonSnippet}
                  </pre>
                  <Button
                    size="small"
                    style={{ position: 'absolute', top: 12, right: 12 }}
                    icon={copiedKey === 'py_code' ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={() => handleCopy(pythonSnippet, 'py_code')}
                  >
                    {t('qs.copy')}
                  </Button>
                </div>
              ),
            },
            {
              key: 'nodejs',
              label: t('qs.tab_nodejs'),
              children: (
                <div style={{ position: 'relative' }}>
                  <pre style={{
                    padding: 16,
                    borderRadius: 6,
                    background: 'var(--code-bg, #1a1a1a)',
                    color: '#e6e6e6',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    overflowX: 'auto',
                    margin: 0,
                  }}>
                    {nodeSnippet}
                  </pre>
                  <Button
                    size="small"
                    style={{ position: 'absolute', top: 12, right: 12 }}
                    icon={copiedKey === 'node_code' ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={() => handleCopy(nodeSnippet, 'node_code')}
                  >
                    {t('qs.copy')}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};
