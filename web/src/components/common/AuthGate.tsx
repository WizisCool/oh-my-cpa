import React from 'react';
import { Button, Form, Input } from 'antd';
import { ArrowRightOutlined, LockOutlined, SafetyCertificateOutlined } from '../icons';
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
import { Placeholder, PlaceholderLines } from './Placeholder';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const [status, setStatus] = React.useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');
  useDocumentTitle(status === 'unauthenticated' ? t('auth.submit') : null);
  const [error, setError] = React.useState<string>();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  // The session check and the sign-in request are the card's work in flight; the bar on the card's
  // top edge counts them, as the console's own bar counts its reads.
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

  return (
    <div className="auth-shell">
      {/* A dot grid in the border step: the page's only texture, drawn in tokens so it follows the
          palette, and static - nothing on this page moves except the measured bar. */}
      <svg className="auth-backdrop" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="auth-backdrop-dots" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#auth-backdrop-dots)" />
      </svg>
      <header className="auth-header">
        <div className="auth-brand">
          {/* No text sits beside the wordmark here, so it is the page's own product name
              and carries it for screen readers rather than being decorative. */}
          <BrandArtwork shape="wordmark" height={22} className="app-brand-logo" label="Oh My CPA" />
        </div>
        {/* The same two menus the console header shows, over the same stored theme and
            language, so a signed-out visitor picks from the full registry before signing in. */}
        <div className="auth-header-actions">
          <PreferenceMenus />
        </div>
      </header>
      <main className="auth-main">
        <section className="auth-card" aria-labelledby={isLoading ? undefined : 'auth-title'} aria-busy={isLoading || undefined}>
          <ProgressBar source={progressTasks} label={isLoading ? t('auth.checking') : t('common.loading')} className="auth-progress" />
          <div className="auth-card-body">
            {/* The brand's prompt mark (design.md §1), set in the console's own type. */}
            <div className="auth-mark" aria-hidden="true">
              <span className="auth-mark-prompt">›</span>
              <span className="auth-mark-cursor">_</span>
            </div>
            {isLoading ? (
              // The card's own outline at its signed-out geometry, so the form lands in place.
              <div role="status" aria-label={t('auth.checking')}>
                <div className="auth-header-block">
                  <PlaceholderLines widths={[64, '62%', '48%']} className="auth-placeholder-heading" />
                </div>
                <Placeholder width={96} row={3} className="placeholder-line is-meta auth-placeholder-label" />
                <Placeholder height={40} row={4} className="auth-placeholder-field" />
                <Placeholder height={40} row={5} className="auth-placeholder-field" />
              </div>
            ) : (
              <>
                <div className="auth-header-block">
                  <div className="terminal-eyebrow">{t('auth.eyebrow')}</div>
                  <h1 id="auth-title" className="terminal-title">{t('auth.title')}</h1>
                  <p className="auth-subtitle">{t('auth.subtitle')}</p>
                </div>
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
                  <Button
                    type="primary"
                    htmlType="submit"
                    block
                    loading={isSubmitting}
                    icon={<ArrowRightOutlined />}
                    iconPlacement="end"
                    autoInsertSpace={false}
                    className="auth-submit"
                  >
                    {t('auth.submit')}
                  </Button>
                </Form>
              </>
            )}
          </div>
          <footer className="auth-footnote">
            <SafetyCertificateOutlined className="auth-footnote-icon" />
            <span>{isDemo ? t('demo.notice') : t('auth.footnote')}</span>
          </footer>
        </section>
      </main>
    </div>
  );
};
