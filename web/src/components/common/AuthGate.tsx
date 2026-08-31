import React from 'react';
import { Alert, Button, Card, Form, Input, Spin, Typography, message } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { api, ApiError, setUnauthorizedHandler } from '../../api/client';
import { useQueryClient } from '@tanstack/react-query';

const { Text, Title } = Typography;

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');
  const [error, setError] = React.useState<string>();
  const [submitting, setSubmitting] = React.useState(false);

  const checkSession = React.useCallback(async () => {
    try {
      const session = await api.getSession();
      setStatus(session.authenticated ? 'authenticated' : 'unauthenticated');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setStatus('unauthenticated');
      else {
        setError(err instanceof Error ? err.message : '无法连接认证服务');
        setStatus('unauthenticated');
      }
    }
  }, []);

  React.useEffect(() => {
    setUnauthorizedHandler(() => setStatus('unauthenticated'));
    void checkSession();
    return () => setUnauthorizedHandler(undefined);
  }, [checkSession]);

  const login = async (values: { password: string }) => {
    setSubmitting(true);
    setError(undefined);
    try {
      await api.login(values.password);
      await queryClient.invalidateQueries();
      setStatus('authenticated');
      message.success('登录成功');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
      setStatus('unauthenticated');
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'loading') {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><Spin size="large" tip="正在检查登录状态" /></div>;
  }
  if (status === 'authenticated') return <>{children}</>;

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f8fafc' }}>
      <Card style={{ width: '100%', maxWidth: 420, borderRadius: 16, boxShadow: '0 18px 50px rgba(15, 23, 42, .08)' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ width: 52, height: 52, margin: '0 auto 16px', borderRadius: 14, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 24, fontWeight: 700, background: 'linear-gradient(135deg, #1677FF, #722ED1)' }}>Ω</div>
          <Title level={2} style={{ margin: 0 }}>登录 Oh My CPA</Title>
          <Text type="secondary">管理员登录后管理 CPA 资源</Text>
        </div>
        {error && <Alert showIcon type="error" message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={login} requiredMark={false}>
          <Form.Item label="管理员密码" name="password" rules={[{ required: true, message: '请输入管理员密码' }]}>
            <Input.Password autoFocus prefix={<LockOutlined />} placeholder="请输入密码" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={submitting}>登录</Button>
        </Form>
      </Card>
    </div>
  );
};
