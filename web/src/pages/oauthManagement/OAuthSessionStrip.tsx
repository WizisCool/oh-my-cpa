import { Button } from '@/components/ui/button';
import { useT } from '../../i18n';
import type { OAuthRecoveryTarget } from '../../types/oauth';
import type { OAuthProviderChoice } from '../oauthProviderLogic';
import type { OAuthSessionState, OAuthSessionsController } from './useOAuthSessions';
import styles from './OAuthSessionStrip.module.css';

interface OAuthSessionStripProps {
  sessions: OAuthSessionsController;
  choices: OAuthProviderChoice[];
  /** Opens the drawer on this attempt, with the credential it was started for, if any. */
  onOpen: (providerId: string, recoveryTarget?: OAuthRecoveryTarget) => void;
}

/**
 * The authorizations this page still owns, outside the drawer that started them.
 *
 * A session outlives the panel, so the strip is where it is answered: the panel can be
 * collapsed, another provider picked, or the drawer left closed entirely, and the attempt
 * would otherwise be visible only as a word with no way to end it. Cancelling belongs
 * here rather than in the drawer alone for exactly that reason - an operator who closed
 * the panel must not have to reopen it to stop a sign-in they no longer want.
 *
 * A failed attempt stays listed with the way back into it; a waiting one also carries its
 * cancel, which stays busy until CPA has answered.
 */
export function OAuthSessionStrip({ sessions, choices, onOpen }: OAuthSessionStripProps) {
  const t = useT();
  const entries = Object.entries(sessions.states)
    .filter(([, state]) => state.status === 'starting' || state.status === 'waiting' || state.status === 'error')
    .map(([providerId, state]) => ({
      providerId,
      state,
      title: choices.find((choice) => choice.id === providerId)?.title ?? providerId,
    }));
  if (entries.length === 0) return null;

  const statusText = (state: OAuthSessionState) => {
    if (state.status === 'error') return t('omc.session_failed');
    if (state.status === 'starting') return t('common.loading');
    return t('omc.session_waiting');
  };

  return (
    <div className={styles.strip} aria-live="polite">
      <span className={styles.label}>{t('omc.active_authorizations')}</span>
      {entries.map(({ providerId, state, title }) => (
        <span className={styles.pill} data-testid="oauth-session-pill" key={providerId}>
          <span className={styles['pill-text']}>
            <span>{title}</span>
            <span aria-hidden="true">·</span>
            <span>{statusText(state)}</span>
          </span>
          <span className={styles['pill-actions']}>
            <Button
              variant="link"
              size="sm"
              onClick={() => onOpen(providerId, state.recoveryTarget)}
            >
              {state.status === 'error' ? t('common.retry') : t('common.details')}
            </Button>
            {state.status === 'waiting' && (
              <Button
                variant="link"
                size="sm"
                danger
                loading={state.cancelling}
                data-oauth-cancel={providerId}
                onClick={() => void sessions.cancel(providerId)}
              >
                {t('oauth.cancel_session')}
              </Button>
            )}
          </span>
        </span>
      ))}
    </div>
  );
}
