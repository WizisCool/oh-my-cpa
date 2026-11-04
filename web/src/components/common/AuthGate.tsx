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
import { SignInStage, type SignInStageState } from './SignInStage';
import { readKeepSignedIn, writeKeepSignedIn } from './keepSignedIn';
import styles from './AuthGate.module.css';

// The signed-out column's outline - title, subtitle, label, field, option, button - so
// the form lands where its outline was.
type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * Hands the page from the sign-in screen to the console in one composited move: the browser
 * snapshots both, and `data-signing-in` selects the sign-in keyframes (index.css) over the
 * palette cross-fade. The console is rendered inside the callback, so nothing waits on the motion;
 * without the API or under reduced motion it simply lands.
 */
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
  // `finished` rejects only when the update itself threw, which React has already reported.
  transition.finished.then(clear, clear);
}

/** The account a password manager files the key under: one per origin, never localized. */
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
  // Counts refused attempts, so each one replays the field's shake and the gateway's flash.
  const [failures, setFailures] = React.useState(0);
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<InputRef>(null);
  const isNarrow = useIsNarrowViewport();
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
      await api.login(values.password, isKeptSignedIn);
      await queryClient.invalidateQueries();
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

  // A refused key shakes the field once and puts the caret back in it, selected, so the next
  // attempt is one paste away. The shake is a gesture's answer, so it uses the spring's budget.
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
  // The showcase waits for the session check: a visitor who is already signed in goes straight
  // to the console and should never see it flash past.
  const isStaged = !isLoading && !isNarrow;
  const stageState: SignInStageState = isSubmitting ? 'submitting' : error ? 'failed' : 'idle';
  const rise = (order: number) => ({ '--rise': order }) as React.CSSProperties;

  return (
    <div className={styles['shell']} data-staged={isStaged || undefined}>
      <ProgressBar source={progressTasks} label={isLoading ? t('auth.checking') : t('common.loading')} className="auth-progress" />
      <div className={styles['pane']}>
        {/* The wordmark, and the same two menus the console header shows, over the same stored
            theme and language, so a signed-out visitor picks from the full registry first. The
            title below names the product, so the wordmark is decorative here. */}
        <header className={styles['header']}>
          <BrandArtwork shape="wordmark" height={22} className="app-brand-logo" />
          <div className={styles['menus']}><PreferenceMenus /></div>
        </header>
        <main className={styles['main']}>
          <section className={`auth-card ${styles['card']}`} aria-labelledby={isLoading ? undefined : 'auth-title'} aria-busy={isLoading || undefined}>
            {isLoading ? (
              // The column's own outline at its signed-out geometry, so the form lands in place.
              <div role="status" aria-label={t('auth.checking')}>
                {AUTH_PLACEHOLDERS.map((placeholder, row) => <Placeholder key={row} {...placeholder} row={row} />)}
              </div>
            ) : (
              <>
                <h1 id="auth-title" className={`terminal-title auth-title ${styles['rise']}`} style={rise(0)}>{t('auth.title')}</h1>
                <p className={`${styles['subtitle']} ${styles['rise']}`} style={rise(1)}>{t('auth.subtitle')}</p>
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
                  {/* Password managers - the browser's own, and extensions such as Bitwarden and
                      1Password - recognise a sign-in form by an account field beside a
                      current-password field, and file the saved key under that account. The key
                      has no account, so this fixed one stands in. It is clipped rather than
                      `display: none`, because some managers skip fields that are not rendered,
                      and read-only so autofill cannot change it. Saving is the manager's own
                      offer, accepted by the operator; the console itself never stores the key. */}
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
      {isStaged && <SignInStage state={stageState} failures={failures} />}
    </div>
  );
};
