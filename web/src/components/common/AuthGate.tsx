import React from 'react';
import { Button, Form, Input } from 'antd';
import { LockOutlined } from '../icons';
import { api, ApiError, setUnauthorizedHandler } from '../../api/client';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '../../i18n';
import { BrandArtwork } from './BrandArtwork';
import { PreferenceMenus } from './PreferenceMenus';
import { isDemoMode } from '../../types/demoMode';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useToast } from '../feedback';
import { Notice } from '../feedback';
import { useProgressTask } from '../../hooks/useProgressTask';
import { progressTasks } from '../../utils/progressTasks';
import { ProgressBar } from './ProgressBar';
import { Placeholder } from './Placeholder';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const [status, setStatus] = React.useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');
  useDocumentTitle(status === 'unauthenticated' ? t('auth.submit') : null);
  const [error, setError] = React.useState<string>();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  // The session check and the sign-in request are the page's work in flight; the bar along the
  // page's top edge counts them, as the console's own bar counts its reads.
  useProgressTask(status === 'loading');
  useProgressTask(isSubmitting);

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
      toast.success(t('auth.success'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.failed'));
      setStatus('unauthenticated');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (status === 'authenticated') return <>{children}</>;

  const isLoading = status === 'loading';

  // One centred column, as the consoles operators already sign in to (Cloudflare, Vercel,
  // Grafana): the wordmark, the page's one title, the field and its button. Nothing else is on
  // the page, because nothing else helps a reader who only has to paste a key.
  return (
    <div className="auth-shell">
      <ProgressBar source={progressTasks} label={isLoading ? t('auth.checking') : t('common.loading')} className="auth-progress" />
      {/* The same two menus the console header shows, over the same stored theme and
          language, so a signed-out visitor picks from the full registry before signing in. */}
      <header className="auth-header">
        <PreferenceMenus />
      </header>
      <main className="auth-main">
        <section className="auth-card" aria-labelledby={isLoading ? undefined : 'auth-title'} aria-busy={isLoading || undefined}>
          {/* The page's only drawing of the brand. The title below names the product too, so
              the wordmark is decorative here rather than announced twice. */}
          <div className="auth-brand">
            <BrandArtwork shape="wordmark" height={28} className="app-brand-logo" />
          </div>
          {isLoading ? (
            // The column's own outline at its signed-out geometry, so the form lands in place.
            <div role="status" aria-label={t('auth.checking')}>
              <Placeholder width="64%" className="auth-placeholder-title" />
              <Placeholder width={112} row={1} className="placeholder-line is-meta auth-placeholder-label" />
              <Placeholder height={40} row={2} className="auth-placeholder-field" />
              <Placeholder height={40} row={3} className="auth-placeholder-field" />
            </div>
          ) : (
            <>
              <h1 id="auth-title" className="terminal-title auth-title">{t('auth.title')}</h1>
              {error && <Notice tone="error" description={error} className="auth-alert" />}
              {/* The demonstration signs in anyone who asks, so the field is filled in for
                  them. It is still the ordinary form: what it protects is the deployment's
                  own session, and there is nothing behind it that a demo must withhold. */}
              {isDemo && <Notice tone="info" description={t('demo.login_hint')} className="auth-alert" />}
              <Form
                layout="vertical"
                onFinish={login}
                requiredMark={false}
                size="large"
                className="auth-form"
                initialValues={isDemo ? { password: 'omc-demo' } : undefined}
              >
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
                <Button type="primary" htmlType="submit" block loading={isSubmitting} autoInsertSpace={false} className="auth-submit">
                  {t('auth.submit')}
                </Button>
              </Form>
            </>
          )}
        </section>
      </main>
    </div>
  );
};
