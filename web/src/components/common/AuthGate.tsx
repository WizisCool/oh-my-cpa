import React from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { PasswordInput } from '@/components/ui/input';
import { ArrowRightOutlined, LockOutlined, ReloadOutlined } from '../icons';
import { api, ApiError, setUnauthorizedHandler } from '../../api/client';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '../../i18n';
import { BrandArtwork } from './BrandArtwork';
import { PreferenceMenus } from './PreferenceMenus';
import { ShellLoading } from './ShellLoading';
import { isDemoMode } from '../../types/demoMode';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useToast } from '../feedback';
import { Notice } from '../feedback';
import { useProgressTask } from '../../hooks/useProgressTask';
import { progressTasks } from '../../utils/progressTasks';
import { ProgressBar } from './ProgressBar';
import { LoadingRegion, Placeholder } from './Placeholder';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { isMotionReduced } from '../../utils/motionPreference';
import type { SignInStageState } from './SignInStage';
import { clearMirroredCPAMCCredential } from '../plugins/pluginHostCredential';
import { readKeepSignedIn, writeKeepSignedIn } from './keepSignedIn';
import { createNamedLoader, lazyRoute } from '../../utils/routeLoader';
import { currentConsolePathname, prefetchLandingRouteData, preloadBootChunks, warmRouteIntent } from '../../routePreload';
import { parseTimeZone, primeTimeZone } from '../../utils/time';
import {
  clearReloadRecoveryState,
  isTransientSessionError,
  readAuthShellHint,
  writeAuthShellHint,
} from '../../utils/reloadRecovery';
import styles from './AuthGate.module.css';

const SESSION_RETRY_DELAYS_MS = [400, 1200] as const;

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
  { width: '78%', height: 28, className: `placeholder-title ${styles['placeholder-title']}` },
  { width: '64%', className: `placeholder-line ${styles['placeholder-subtitle']}` },
  { width: 112, className: `placeholder-line is-meta ${styles['placeholder-label']}` },
  { height: 40, className: 'is-control' },
];

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT();
  const tRef = React.useRef(t);
  React.useEffect(() => {
    tRef.current = t;
  }, [t]);
  const toast = useToast();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const [status, setStatus] = React.useState<'loading' | 'authenticated' | 'reconnecting' | 'unauthenticated'>('loading');
  const [hasInitialShellHint] = React.useState<boolean>(() => isDemo || readAuthShellHint());
  const checkGenerationRef = React.useRef(0);
  const retryTimerRef = React.useRef<number | null>(null);
  const [isRetryingSession, setIsRetryingSession] = React.useState(false);
  useDocumentTitle(status === 'unauthenticated' ? t('auth.submit') : null);
  const [error, setError] = React.useState<string>();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const isSubmittingRef = React.useRef(false);
  const [isKeptSignedIn, setIsKeptSignedIn] = React.useState(readKeepSignedIn);

  const clearPendingRetry = React.useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const forgetGatewayCredential = React.useCallback(() => {
    clearMirroredCPAMCCredential();
    queryClient.removeQueries({ queryKey: ['cpa-credential'] });
    queryClient.removeQueries({ queryKey: ['usage-routing-window'] });
    queryClient.removeQueries({ queryKey: ['usage-routing'] });
  }, [queryClient]);

  const warmAuthenticatedBootstrap = React.useCallback(() => {
    const pathname = currentConsolePathname();
    const search = typeof window !== 'undefined' ? window.location.search : '';
    preloadBootChunks(pathname);
    prefetchLandingRouteData(queryClient, pathname, search);
    void queryClient.fetchQuery({
      queryKey: ['preferences'],
      queryFn: api.getPreferences,
      staleTime: Infinity,
      meta: { silent: true },
    }).then((prefs) => {
      const selected = parseTimeZone(prefs?.omc_timezone) || '';
      const server = parseTimeZone(prefs?.omc_server_timezone) || 'UTC';
      const timeZone = primeTimeZone(selected, server);
      warmRouteIntent(pathname, { queryClient, pathname, search, timeZone });
    }).catch(() => undefined);
  }, [queryClient]);

  const [failures, setFailures] = React.useState(0);
  const [password, setPassword] = React.useState(() => (isDemo ? 'omc-demo' : ''));
  const [fieldError, setFieldError] = React.useState<string>();
  // A refused password is the field's own failure, so the field shows it until the next keystroke;
  // a rate limit or an unreachable gateway is not, and stays in the notice alone.
  const [isRejected, setIsRejected] = React.useState(false);
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const isNarrow = useIsNarrowViewport();
  useProgressTask(status === 'loading' || isRetryingSession);
  useProgressTask(isSubmitting);

  const enterUnauthenticated = React.useCallback((message?: string) => {
    checkGenerationRef.current += 1;
    clearPendingRetry();
    setIsRetryingSession(false);
    clearReloadRecoveryState();
    forgetGatewayCredential();
    setError(message);
    void loadSignInStage().catch(() => undefined);
    setStatus('unauthenticated');
  }, [clearPendingRetry, forgetGatewayCredential]);

  const checkSession = React.useCallback(async (options: { allowAutoRetry?: boolean; showSpinner?: boolean } = {}) => {
    const { allowAutoRetry = true, showSpinner = false } = options;
    clearPendingRetry();
    const generation = ++checkGenerationRef.current;
    if (showSpinner) setIsRetryingSession(true);

    const runAttempt = async (attempt: number): Promise<void> => {
      try {
        const session = await api.getSession();
        if (checkGenerationRef.current !== generation) return;
        if (!session.authenticated) {
          enterUnauthenticated(undefined);
          return;
        }
        writeAuthShellHint(true);
        setError(undefined);
        warmAuthenticatedBootstrap();
        setStatus('authenticated');
      } catch (err) {
        if (checkGenerationRef.current !== generation) return;
        if (err instanceof ApiError && err.status === 401) {
          enterUnauthenticated(undefined);
          return;
        }
        if (isTransientSessionError(err)) {
          const isOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
          const nextDelay = allowAutoRetry && isOnline ? SESSION_RETRY_DELAYS_MS[attempt] : undefined;
          if (nextDelay !== undefined) {
            await new Promise<void>((resolve) => {
              retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                resolve();
              }, nextDelay);
            });
            if (checkGenerationRef.current !== generation) return;
            await runAttempt(attempt + 1);
            return;
          }
          // Keep transient transport errors in reconnect mode regardless of shell hint so
          // saved recovery state survives offline cold launches or mobile wake-ups.
          setError(err instanceof Error ? err.message : tRef.current('auth.connect_failed'));
          setStatus('reconnecting');
          return;
        }
        enterUnauthenticated(err instanceof Error ? err.message : tRef.current('auth.connect_failed'));
      }
    };

    try {
      await runAttempt(0);
    } finally {
      if (checkGenerationRef.current === generation) {
        setIsRetryingSession(false);
      }
    }
  }, [clearPendingRetry, enterUnauthenticated, warmAuthenticatedBootstrap]);

  React.useEffect(() => {
    // Download static shell + landing-route code chunks in parallel with session check.
    preloadBootChunks();
    setUnauthorizedHandler(() => {
      enterUnauthenticated(undefined);
    });
    void checkSession({ allowAutoRetry: true });
    return () => {
      checkGenerationRef.current += 1;
      clearPendingRetry();
      setUnauthorizedHandler(undefined);
    };
  }, [checkSession, clearPendingRetry, enterUnauthenticated]);

  React.useEffect(() => {
    if (status !== 'reconnecting') return undefined;
    const retryOnRecovery = () => {
      if (isSubmittingRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void checkSession({ allowAutoRetry: false, showSpinner: true });
    };
    window.addEventListener('online', retryOnRecovery);
    document.addEventListener('visibilitychange', retryOnRecovery);
    return () => {
      window.removeEventListener('online', retryOnRecovery);
      document.removeEventListener('visibilitychange', retryOnRecovery);
    };
  }, [status, checkSession]);

  const login = async (values: { password: string }) => {
    // Take ownership of the gate immediately so any in-flight session probe cannot
    // resolve afterward and kick a freshly signed-in operator back to sign-in.
    checkGenerationRef.current += 1;
    clearPendingRetry();
    setIsRetryingSession(false);
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setError(undefined);
    try {
      await api.login(values.password, isKeptSignedIn);
      forgetGatewayCredential();
      await queryClient.invalidateQueries();
      writeAuthShellHint(true);
      if (!isDemo) setPassword('');
      warmAuthenticatedBootstrap();
      enterConsole(() => setStatus('authenticated'));
      toast.success(t('auth.success'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.failed'));
      setIsRejected(err instanceof ApiError && err.status === 401);
      setStatus('unauthenticated');
      setFailures((count) => count + 1);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  React.useEffect(() => {
    if (failures === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
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
  if (status === 'loading' && hasInitialShellHint) return <ShellLoading />;

  const isLoading = status === 'loading';
  const isReconnecting = status === 'reconnecting';
  const isStaged = !isLoading && !isReconnecting && !isNarrow;
  const stageState: SignInStageState = isSubmitting ? 'submitting' : error ? 'failed' : 'idle';
  const rise = (order: number) => ({ '--rise': order }) as React.CSSProperties;

  return (
    <div className={styles['shell']} data-staged={isStaged || undefined}>
      <ProgressBar source={progressTasks} label={isLoading || isRetryingSession ? t('auth.checking') : t('common.loading')} className="auth-progress" />
      <div className={styles['pane']}>
        <header className={styles['header']}>
          <BrandArtwork shape="wordmark" height={22} className="app-brand-logo" />
          <div className={styles['menus']}><PreferenceMenus /></div>
        </header>
        <main className={styles['main']}>
          <section className={`auth-card ${styles['card']}`} aria-labelledby={isLoading ? undefined : 'auth-title'} aria-busy={isLoading || isRetryingSession || undefined}>
            {isLoading ? (
              <LoadingRegion isImmediate>
                {AUTH_PLACEHOLDERS.map((placeholder, row) => <Placeholder key={row} {...placeholder} row={row} />)}
                <div className={`placeholder-auth-check ${styles['placeholder-option']}`} aria-hidden="true">
                  <Placeholder width={16} height={16} row={4} className="is-control" />
                  <Placeholder width={88} row={4} className="placeholder-line" />
                </div>
                <Placeholder height={40} row={5} className="is-control" />
              </LoadingRegion>
            ) : isReconnecting ? (
              <>
                <h1 id="auth-title" className={`terminal-title auth-title ${styles['rise']}`} style={rise(0)}>
                  {t('auth.reconnect_title')}
                </h1>
                {error && <Notice tone="warning" description={error} className="auth-alert" />}
                <div className={styles['reconnect-actions']}>
                  <Button
                    variant="primary"
                    size="lg"
                    block
                    loading={isRetryingSession}
                    icon={<ReloadOutlined />}
                    onClick={() => void checkSession({ allowAutoRetry: false, showSpinner: true })}
                  >
                    {t('auth.reconnect_retry')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="lg"
                    block
                    onClick={() => enterUnauthenticated(undefined)}
                  >
                    {t('auth.use_signin')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h1 id="auth-title" className={`terminal-title auth-title ${styles['rise']}`} style={rise(0)}>{t('auth.title')}</h1>
                <p className={`${styles['subtitle']} ${styles['rise']}`} style={rise(1)}>{t('auth.subtitle')}</p>
                {error && <Notice tone="error" description={error} className="auth-alert" />}
                {isDemo && <Notice tone="info" description={t('demo.login_hint')} className="auth-alert" />}
                <form
                  className="auth-form"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!password) {
                      setFieldError(t('auth.required'));
                      inputRef.current?.focus();
                      return;
                    }
                    setFieldError(undefined);
                    void login({ password });
                  }}
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
                  <div ref={fieldRef} className={`mb-5 flex flex-col gap-2 ${styles['rise']}`} style={rise(2)}>
                    <label htmlFor="auth-password" className="text-sm text-muted-foreground tracking-[0.04em]">
                      {t('auth.label')}
                    </label>
                    <PasswordInput
                      ref={inputRef}
                      id="auth-password"
                      size="lg"
                      autoFocus
                      name="password"
                      value={password}
                      aria-invalid={Boolean(fieldError) || isRejected || undefined}
                      aria-describedby={fieldError ? 'auth-password-error' : undefined}
                      prefix={<LockOutlined className="terminal-muted" />}
                      revealLabel={t('common.reveal_secret')}
                      hideLabel={t('common.hide_secret')}
                      autoComplete="current-password"
                      spellCheck={false}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setIsRejected(false);
                        if (fieldError && event.target.value) setFieldError(undefined);
                      }}
                    />
                    {fieldError && (
                      <p id="auth-password-error" role="alert" className="m-0 text-sm text-danger">
                        {fieldError}
                      </p>
                    )}
                  </div>
                  <div className={`${styles['options']} ${styles['rise']}`} style={rise(3)}>
                    <Checkbox checked={isKeptSignedIn} onCheckedChange={changeKeptSignedIn}>
                      {t('auth.keep_signed_in')}
                    </Checkbox>
                  </div>
                  <div className={styles['rise']} style={rise(4)}>
                    <Button
                      variant="primary"
                      size="lg"
                      type="submit"
                      block
                      loading={isSubmitting}
                      icon={<ArrowRightOutlined />}
                      iconPlacement="end"
                      className={`auth-submit ${styles['submit']}`}
                    >
                      {t('auth.submit')}
                    </Button>
                  </div>
                </form>
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
