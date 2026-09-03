import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Button,
  Tag,
  Typography,
  Alert,
  Spin,
  Input,
  Form,
  App as AntdApp,
} from 'antd';
import {
  LoginOutlined,
  SyncOutlined,
  LinkOutlined,
  StopOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { OAuthProviderItem, StartOAuthResponse } from '../types/oauth';

const { Text, Title, Paragraph } = Typography;

export const OAuthPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [activeSession, setActiveSession] = useState<StartOAuthResponse | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>('waiting');
  const [sessionMessage, setSessionMessage] = useState<string>('');
  const [manualCode, setManualCode] = useState<string>('');
  const [manualState, setManualState] = useState<string>('');

  // 1. Providers list
  const {
    data: providersData,
    isLoading: providersLoading,
    isFetching: providersFetching,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['oauth-providers'],
    queryFn: api.getOAuthProviders,
    staleTime: 60000,
  });

  const providers: OAuthProviderItem[] = providersData?.providers || [];

  // 2. Start flow mutation
  const startMutation = useMutation({
    mutationFn: (providerId: string) => api.startOAuthFlow(providerId),
    onSuccess: (data: StartOAuthResponse) => {
      setActiveSession(data);
      setSessionStatus('waiting');
      setSessionMessage('');
      if (data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer');
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  // 3. Polling session status
  useEffect(() => {
    if (!activeSession || sessionStatus === 'ok' || sessionStatus === 'success' || sessionStatus === 'failed') {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const res = await api.getOAuthStatus(activeSession.session_id);
        if (res.status === 'ok' || res.status === 'success') {
          setSessionStatus('success');
          setSessionMessage(res.message || '');
          message.success(t('oauth.status_success'));
          void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
          void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
        } else if (res.status === 'failed' || res.status === 'error') {
          setSessionStatus('failed');
          setSessionMessage(res.message || '');
        } else if (res.status) {
          setSessionStatus(res.status);
          if (res.message) setSessionMessage(res.message);
        }
      } catch {
        // Polling failure is non-fatal
      }
    }, 2500);

    return () => clearInterval(timer);
  }, [activeSession, sessionStatus, t, queryClient, message]);

  // 4. Cancel session
  const cancelMutation = useMutation({
    mutationFn: (sessionId: string) => api.cancelOAuthSession(sessionId),
    onSuccess: () => {
      message.info(t('oauth.session_cancelled'));
      setActiveSession(null);
      setSessionStatus('waiting');
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  // 5. Manual callback submit
  const callbackMutation = useMutation({
    mutationFn: ({ code, state }: { code: string; state: string }) =>
      api.handleOAuthCallback(code, state),
    onSuccess: () => {
      message.success(t('oauth.callback_success'));
      setManualCode('');
      setManualState('');
      setActiveSession(null);
      setSessionStatus('success');
      void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('oauth.callback_failed', { msg }));
    },
  });

  return (
    <div className="terminal-page oauth-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('oauth.title')}</h1>
          <p className="terminal-subtitle">{t('oauth.subtitle')}</p>
        </div>

        <Button
          size="small"
          icon={<SyncOutlined spin={providersFetching} />}
          onClick={() => void refetchProviders()}
        >
          {t('common.refresh')}
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginBottom: 20 }}
        description={t('oauth.security_notice')}
      />

      {/* Active Session Card */}
      {activeSession && (
        <Card
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {sessionStatus === 'waiting' && <Spin size="small" />}
              {sessionStatus === 'success' && <CheckCircleOutlined style={{ color: 'var(--ant-color-success)' }} />}
              {sessionStatus === 'failed' && <CloseCircleOutlined style={{ color: 'var(--ant-color-error)' }} />}
              <span>{t('oauth.active_session')} ({activeSession.provider})</span>
            </div>
          }
          extra={
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              loading={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate(activeSession.session_id)}
            >
              {t('oauth.cancel_session')}
            </Button>
          }
          style={{ marginBottom: 20 }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Text strong>{t('oauth.status_polling')}</Text>{' '}
              {sessionStatus === 'waiting' && (
                <Tag color="processing">{t('oauth.status_waiting')}</Tag>
              )}
              {sessionStatus === 'success' && (
                <Tag color="success">{t('oauth.status_success')}</Tag>
              )}
              {sessionStatus === 'failed' && (
                <Tag color="error">{t('oauth.status_failed')}</Tag>
              )}
              {sessionMessage && (
                <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
                  {sessionMessage}
                </Paragraph>
              )}
            </div>

            {activeSession.url && (
              <div>
                <Button
                  type="primary"
                  icon={<LinkOutlined />}
                  href={activeSession.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('oauth.open_auth_url')}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Providers Grid */}
      <Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
        {t('oauth.providers_title')}
      </Title>

      {providersLoading ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Spin size="large" />
        </div>
      ) : (
        <Row gutter={[16, 16]}>
          {providers.map((p) => (
            <Col xs={24} sm={12} lg={12} key={p.id}>
              <Card
                hoverable
                style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <Text strong style={{ fontSize: 16 }}>{p.name}</Text>
                  <Tag color="blue">{p.id}</Tag>
                </div>
                <Paragraph type="secondary" style={{ flex: 1, fontSize: 13, marginBottom: 16 }}>
                  {p.description}
                </Paragraph>
                <div>
                  <Button
                    type="primary"
                    icon={<LoginOutlined />}
                    loading={startMutation.isPending && startMutation.variables === p.id}
                    onClick={() => startMutation.mutate(p.id)}
                  >
                    {t('oauth.start_auth')}
                  </Button>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* Manual Callback Submission */}
      <Card
        title={t('oauth.manual_callback_title')}
        style={{ marginTop: 24 }}
      >
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          {t('oauth.manual_callback_desc')}
        </Paragraph>
        <Form layout="vertical" onFinish={() => callbackMutation.mutate({ code: manualCode, state: manualState })}>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label={t('oauth.code')} required>
                <Input
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="e.g. 4/0AY0e-g..."
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label={t('oauth.state')} required>
                <Input
                  value={manualState}
                  onChange={(e) => setManualState(e.target.value)}
                  placeholder="e.g. session-state-param"
                />
              </Form.Item>
            </Col>
          </Row>
          <Button
            type="default"
            htmlType="submit"
            disabled={!manualCode.trim() || !manualState.trim() || callbackMutation.isPending}
            loading={callbackMutation.isPending}
          >
            {t('oauth.submit_callback')}
          </Button>
        </Form>
      </Card>
    </div>
  );
};
