import React from 'react';
import { flushSync } from 'react-dom';
import { Button, Checkbox, Form, Input, type InputRef } from 'antd';
import { ArrowRightOutlined, LockOutlined } from '../icons';
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
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { isMotionReduced } from '../../utils/motionPreference';
import type { SignInStageState } from './SignInStage';
import { clearMirroredCPAMCCredential } from '../plugins/pluginHostCredential';
import { readKeepSignedIn, writeKeepSignedIn } from './keepSignedIn';
import { createNamedLoader, lazyRoute } from '../../utils/routeLoader';
import { currentConsolePathname, preloadBootChunks, warmRouteIntent } from '../../routePreload';
import { parseTimeZone, primeTimeZone } from '../../utils/time';
import styles from './AuthGate.module.css';

const loadSignInStage = createNamedLoader(() => import('./SignInStage'), 'SignInStage');
const LazySignInStage = lazyRoute<{ state: SignInStageState; failures: number }>(loadSignInStage);

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

function enterConsole(update: () => void): void {
  const start = (document as ViewTransitionDocument).startViewTransition;
  if (typeof start !== 'function' || isMotionReduced()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.signingIn = 'true';
  const transition = start.call(document, () => flushSync(update));
  const clear = () => { delete root.dataset.signingIn; };
  transition.finished.then(clear, clear);
}

const PASSWORD_MANAGER_ACCOUNT = 'management-key';

const AUTH_PLACEHOLDERS = [
  { width: '78%', height: 28, className: styles['placeholder-title'] },
  { width: '64%', className: `placeholder-line ${styles['placeholder-subtitle']}` },
  { width: 112, className: `placeholder-line is-meta ${styles['placeholder-label']}` },
  { height: 40 },
  { width: 96, className: `placeholder-line ${styles['placeholder-option']}` },
  { height: 40 },
];

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const [status, setStatus] = React.useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');
  useDocumentTitle(status === 'unauthenticated' ? t('auth.submit') : null);
  const [error, setError] = React.useState<string>();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isKeptSignedIn, setIsKeptSignedIn] = React.useState(readKeepSignedIn);

  const forgetGatewayCredential = React.useCallback(() => {
    clearMirroredCPAMCCredential();
    queryClient.removeQueries({ queryKey: ['cpa-credential'] });
    queryClient.removeQueries({ queryKey: ['usage-routing-window'] });
    queryClient.removeQueries({ queryKey: ['usage-routing'] });
  }, [queryClient]);

  const warmAuthenticatedBootstrap = React.useCallback(() => {
    const pathname = currentConsolePathname();
    preloadBootChunks(pathname);
    void queryClient.fetchQuery({
      queryKey: ['preferences'],
      queryFn: api.getPreferences,
      staleTime: Infinity,
      meta: { silent: true },
    }).then((prefs) => {
      const selected = parseTimeZone(prefs?.omc_timezone) || '';
      const server = parseTimeZone(prefs?.omc_server_timezone) || 'UTC';
      const timeZone = primeTimeZone(selected, server);
      warmRouteIntent(pathname, { queryClient, pathname, timeZone });
    }).catch(() => undefined);
  }, [queryClient]);

  const [failures, setFailures] = React.useState(0);
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<InputRef>(null);
  const isNarrow = useIsNarrowViewport();
  useProgressTask(status === 'loading');
  useProgressTask(isSubmitting);

  const checkSession = React.useCallback(async () => {
    try {
      const session = await api.getSession();
      if (!session.authenticated) {
        forgetGatewayCredential();
        void loadSignInStage().catch(() => undefined);
        setStatus('unauthenticated');
        return;
      }
      warmAuthenticatedBootstrap();
      setStatus('authenticated');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        forgetGatewayCredential();
        void loadSignInStage().catch(() => undefined);
        setStatus('unauthenticated');
      } else {
        setError(err instanceof Error ? err.message : t('auth.connect_failed'));
        void loadSignInStage().catch(() => undefined);
        setStatus('unauthenticated');
      }
    }
  }, [t, forgetGatewayCredential, warmAuthenticatedBootstrap]);

  React.useEffect(() => {
    // Download static shell + landing-route code chunks in parallel with session check.
    preloadBootChunks();
    setUnauthorizedHandler(() => {
      forgetGatewayCredential();
      void loadSignInStage().catch(() => undefined);
      setStatus('unauthenticated');
    });
    void checkSession();
    return () => setUnauthorizedHandler(undefined);
  }, [checkSession, forgetGatewayCredential]);

  const login = async (values: { password: string }) => {
    setIsSubmitting(true);
    setError(undefined);
    try {
      await api.login(values.password, isKeptSignedIn);
      forgetGatewayCredential();
      await queryClient.invalidateQueries();
      warmAuthenticatedBootstrap();
      enterConsole(() => setStatus('authenticated'));
      toast.success(t('auth.success'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.failed'));
      setStatus('unauthenticated');
      setFailures((count) => count + 1);
    } finally {
      setIsSubmitting(false);
    }
  };

  React.useEffect(() => {
    if (failures === 0) return;
    inputRef.current?.focus({ cursor: 'all' });
    if (isMotionReduced()) return;
    fieldRef.current?.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }],
      { duration: 360, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' },
    );
  }, [failures]);

  const changeKeptSignedIn = (next: boolean) => {
    setIsKeptSignedIn(next);
    writeKeepSignedIn(next);
  };

  if (status === 'authenticated') return <>{children}</>;

  const isLoading = status === 'loading';
  const isStaged = !isLoading && !isNarrow;
  const stageState: SignInStageState = isSubmitting ? 'submitting' : error ? 'failed' : 'idle';
  const rise = (order: number) => ({ '--rise': order }) as React.CSSProperties;

  return (
    <div className={styles['shell']} data-staged={isStaged || undefined}>
      <ProgressBar source={progressTasks} label={isLoading ? t('auth.checking') : t('common.loading')} className="auth-progress" />
      <div className={styles['pane']}>
        <header className={styles['header']}>
          <BrandArtwork shape="wordmark" height={22} className="app-brand-logo" />
          <div className={styles['menus']}><PreferenceMenus /></div>
        </header>
        <main className={styles['main']}>
          <section className={`auth-card ${styles['card']}`} aria-labelledby={isLoading ? undefined : 'auth-title'} aria-busy={isLoading || undefined}>
            {isLoading ? (
              <div role="status" aria-label={t('auth.checking')}>
                {AUTH_PLACEHOLDERS.map((placeholder, row) => <Placeholder key={row} {...placeholder} row={row} />)}
              </div>
            ) : (
              <>
                <h1 id="auth-title" className={`terminal-title auth-title ${styles['rise']}`} style={rise(0)}>{t('auth.title')}</h1>
                <p className={`${styles['subtitle']} ${styles['rise']}`} style={rise(1)}>{t('auth.subtitle')}</p>
                {error && <Notice tone="error" description={error} className="auth-alert" />}
                {isDemo && <Notice tone="info" description={t('demo.login_hint')} className="auth-alert" />}
                <Form
                  layout="vertical"
                  onFinish={login}
                  requiredMark={false}
                  size="large"
                  className="auth-form"
                  initialValues={isDemo ? { password: 'omc-demo' } : undefined}
                >
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    value={PASSWORD_MANAGER_ACCOUNT}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                    className="sr-only"
                  />
                  <div ref={fieldRef} className={styles['rise']} style={rise(2)}>
                    <Form.Item
                      label={t('auth.label')}
                      name="password"
                      rules={[{ required: true, message: t('auth.required') }]}
                    >
                      <Input.Password
                        ref={inputRef}
                        autoFocus
                        name="password"
                        prefix={<LockOutlined className="terminal-muted" />}
                        autoComplete="current-password"
                        spellCheck={false}
                      />
                    </Form.Item>
                  </div>
                  <div className={`${styles['options']} ${styles['rise']}`} style={rise(3)}>
                    <Checkbox checked={isKeptSignedIn} onChange={(event) => changeKeptSignedIn(event.target.checked)}>
                      {t('auth.keep_signed_in')}
                    </Checkbox>
                  </div>
                  <div className={styles['rise']} style={rise(4)}>
                    <Button
                      type="primary"
                      htmlType="submit"
                      block
                      loading={isSubmitting}
                      autoInsertSpace={false}
                      icon={<ArrowRightOutlined />}
                      iconPlacement="end"
                      className={`auth-submit ${styles['submit']}`}
                    >
                      {t('auth.submit')}
                    </Button>
                  </div>
                </Form>
              </>
            )}
          </section>
        </main>
      </div>
      {isStaged && (
        <React.Suspense fallback={null}>
          <LazySignInStage state={stageState} failures={failures} />
        </React.Suspense>
      )}
    </div>
  );
};
