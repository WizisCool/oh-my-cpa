import React from 'react';
import { Alert, App as AntdApp, Button, Card, Form, Input, Skeleton, Tooltip } from 'antd';
import { LockOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { api, ApiError, setUnauthorizedHandler } from '../../api/client';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n, useT } from '../../i18n';
import { useThemeMode } from '../../theme/ThemeContext';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT();
  const { lang, toggleLang } = useI18n();
  const { themeMode, toggleTheme } = useThemeMode();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');
  const [error, setError] = React.useState<string>();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const checkSession = React.useCallback(async () => {
    try {
      const session = await api.getSession();
      setStatus(session.authenticated ? 'authenticated' : 'unauthenticated');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setStatus('unauthenticated');
      else {
        setError(err instanceof Error ? err.message : t('auth.connect_failed'));
        setStatus('unauthenticated');
      }
    }
  }, [t]);

  React.useEffect(() => {
    setUnauthorizedHandler(() => setStatus('unauthenticated'));
    void checkSession();
    return () => setUnauthorizedHandler(undefined);
  }, [checkSession]);

  const login = async (values: { password: string }) => {
    setIsSubmitting(true);
    setError(undefined);
    try {
      await api.login(values.password);
      await queryClient.invalidateQueries();
      setStatus('authenticated');
      message.success(t('auth.success'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.failed'));
      setStatus('unauthenticated');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (status === 'authenticated') return <>{children}</>;

  const header = (
    <header className="auth-header">
      <div className="auth-brand">
        <div className="app-brand-mark">›_</div>
        <div className="app-brand-copy">
          <strong>oh-my-cpa</strong>
          <span>{t('app.sub')}</span>
        </div>
      </div>
      <div className="auth-header-actions">
        <Tooltip title={t('header.theme')}>
          <Button
            type="text"
            icon={themeMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleTheme}
            aria-label={t('header.theme')}
          />
        </Tooltip>
        <Tooltip title={t('header.language')}>
          <Button type="text" onClick={toggleLang} aria-label={t('header.language')}>
            <span className="terminal-mono">{lang === 'zh' ? 'EN' : '中'}</span>
          </Button>
        </Tooltip>
      </div>
    </header>
  );

  if (status === 'loading') {
    return (
      <div className="auth-shell">
        {header}
        <main className="auth-main">
          <Card className="auth-card">
            <div className="auth-header-block">
              <Skeleton active={false} title={{ width: '30%' }} paragraph={{ rows: 2, width: ['60%', '80%'] }} />
            </div>
            <div style={{ marginTop: 24 }}>
              <Skeleton active={false} title={{ width: '40%' }} paragraph={{ rows: 2, width: ['100%', '100%'] }} />
            </div>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      {header}
      <main className="auth-main">
        <Card className="auth-card">
          <div className="auth-header-block">
            <div className="terminal-eyebrow">{t('auth.eyebrow')}</div>
            <h1 className="terminal-title">{t('auth.title')}</h1>
            <p className="auth-subtitle">{t('auth.subtitle')}</p>
          </div>
          {error && <Alert showIcon type="error" description={error} className="auth-alert" />}
          <Form layout="vertical" onFinish={login} requiredMark={false}>
            <Form.Item
              label={t('auth.label')}
              name="password"
              rules={[{ required: true, message: t('auth.required') }]}
            >
              <Input.Password
                autoFocus
                prefix={<LockOutlined className="terminal-muted" />}
                placeholder={t('auth.placeholder')}
                autoComplete="current-password"
                spellCheck={false}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={isSubmitting}>
              {t('auth.submit')}
            </Button>
          </Form>
          <div className="auth-footnote">{t('auth.footnote')}</div>
        </Card>
      </main>
    </div>
  );
};
