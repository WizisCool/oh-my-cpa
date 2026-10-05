import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import {
  resolveStartedOAuthFlow,
  normalizeOAuthStatus,
  type OAuthFlowKind,
  type OAuthProviderChoice,
} from '../oauthProviderLogic';
import { useToast } from '../../components/feedback';

export type OAuthSessionStatus = 'idle' | 'starting' | 'waiting' | 'success' | 'error';

export interface OAuthSessionState {
  url?: string;
  state?: string;
  flow?: OAuthFlowKind;
  userCode?: string;
  status: OAuthSessionStatus;
  error?: string;
  starting?: boolean;
  cancelling?: boolean;
  checkingDevice?: boolean;
  polling?: boolean;
  cancelError?: string;
  callbackUrl: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
}

export interface OAuthSessionsController {
  states: Record<string, OAuthSessionState>;
  activeProviders: string[];
  start: (providerId: string) => Promise<void>;
  cancel: (providerId: string) => Promise<void>;
  submitCallback: (providerId: string) => Promise<void>;
  check: (providerId: string) => Promise<void>;
  setCallbackUrl: (providerId: string, value: string) => void;
  reset: (providerId: string) => void;
}

const STATUS_POLL_INTERVAL_MS = 3000;
const SUCCESS_RESET_DELAY_MS = 10_000;

/**
 * Whether a status read leaves the attempt alive and the poll armed.
 *
 * `unread` is not a failure of the attempt: the read never reached CPA's answer, so
 * the only honest response is to try again while the session stays waiting.
 */
function isPollingOutcome(outcome: 'ok' | 'error' | 'wait' | 'unread'): boolean {
  return outcome === 'wait' || outcome === 'unread';
}

function emptySession(): OAuthSessionState {
  return {
    status: 'idle',
    callbackUrl: '',
  };
}

export function isOAuthSessionActive(state: OAuthSessionState | undefined): boolean {
  return state?.status === 'starting' || state?.status === 'waiting';
}

/**
 * Owns every authorization attempt above the task panel.
 *
 * The drawer is presentation only. Closing it must not dispose a session,
 * duplicate a poller or reset a generation, so the timers and guards live here
 * and survive every panel open/close transition.
 */
export function useOAuthSessions(
  choices: OAuthProviderChoice[],
  onCompleted?: (providerId: string) => void,
  { shouldNotifyCompletion = true }: { shouldNotifyCompletion?: boolean } = {},
): OAuthSessionsController {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [states, setStates] = React.useState<Record<string, OAuthSessionState>>({});
  const choicesRef = React.useRef(choices);
  const generationRef = React.useRef<Record<string, number>>({});
  const startInFlightRef = React.useRef<Record<string, boolean>>({});
  const disposedRef = React.useRef(false);
  const statusTimersRef = React.useRef<Record<string, number>>({});
  const statusReadFailuresRef = React.useRef<Record<string, string>>({});
  const successTimersRef = React.useRef<Record<string, number>>({});
  const checkQueuesRef = React.useRef<Record<string, Promise<void>>>({});
  const completedRef = React.useRef(onCompleted);

  React.useEffect(() => {
    choicesRef.current = choices;
  }, [choices]);

  React.useEffect(() => {
    completedRef.current = onCompleted;
  }, [onCompleted]);

  const updateProviderState = React.useCallback((providerId: string, next: Partial<OAuthSessionState>) => {
    setStates((previous) => ({
      ...previous,
      [providerId]: { ...(previous[providerId] ?? emptySession()), ...next },
    }));
  }, []);

  const clearStatusTimer = React.useCallback((providerId: string) => {
    const timer = statusTimersRef.current[providerId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete statusTimersRef.current[providerId];
    }
  }, []);

  const clearSuccessTimer = React.useCallback((providerId: string) => {
    const timer = successTimersRef.current[providerId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete successTimersRef.current[providerId];
    }
  }, []);

  const clearProviderTimers = React.useCallback((providerId: string) => {
    clearStatusTimer(providerId);
    clearSuccessTimer(providerId);
  }, [clearStatusTimer, clearSuccessTimer]);

  React.useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      Object.values(statusTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      Object.values(successTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      statusTimersRef.current = {};
      successTimersRef.current = {};
    };
  }, []);

  const reset = React.useCallback((providerId: string) => {
    clearProviderTimers(providerId);
    delete statusReadFailuresRef.current[providerId];
    generationRef.current[providerId] = (generationRef.current[providerId] ?? 0) + 1;
    setStates((previous) => ({ ...previous, [providerId]: emptySession() }));
  }, [clearProviderTimers]);

  const complete = React.useCallback((providerId: string, generation: number) => {
    if (disposedRef.current || generationRef.current[providerId] !== generation) return;
    clearProviderTimers(providerId);
    updateProviderState(providerId, {
      url: undefined,
      state: undefined,
      flow: undefined,
      userCode: undefined,
      status: 'success',
      starting: false,
      cancelling: false,
      checkingDevice: false,
      polling: false,
      error: undefined,
      cancelError: undefined,
      callbackUrl: '',
      callbackSubmitting: false,
      callbackStatus: undefined,
      callbackError: undefined,
    });
    void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
    void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
    void queryClient.invalidateQueries({ queryKey: ['management-overview'] });
    completedRef.current?.(providerId);
    if (shouldNotifyCompletion) toast.success(t('oauth.status_success_badge'));
    successTimersRef.current[providerId] = window.setTimeout(() => {
      if (generationRef.current[providerId] === generation) reset(providerId);
    }, SUCCESS_RESET_DELAY_MS);
  }, [clearProviderTimers, toast, queryClient, reset, shouldNotifyCompletion, t, updateProviderState]);

  const enqueueCheck = React.useCallback(<T,>(providerId: string, task: () => Promise<T>): Promise<T> => {
    const previous = checkQueuesRef.current[providerId] ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    checkQueuesRef.current[providerId] = next.then(() => undefined, () => undefined);
    return next;
  }, []);

  const performStatusCheck = React.useCallback(async (
    providerId: string,
    token: string,
    generation: number,
    surfaceErrors: boolean,
  ): Promise<'ok' | 'error' | 'wait' | 'unread'> => {
    try {
      const response = await api.getOAuthStatus(token || undefined);
      if (disposedRef.current || generationRef.current[providerId] !== generation) return 'wait';
      // Written only when the previous read had failed, so a healthy poll stays free
      // of state writes while a recovered one drops the note it left behind.
      if (statusReadFailuresRef.current[providerId]) {
        delete statusReadFailuresRef.current[providerId];
        updateProviderState(providerId, { error: undefined });
      }
      const status = normalizeOAuthStatus(response.status);
      if (status === 'ok') {
        complete(providerId, generation);
        return 'ok';
      }
      if (status === 'error') {
        const errorMessage = (response.message || response.error || '').trim() || t('oauth.status_failed');
        clearStatusTimer(providerId);
        updateProviderState(providerId, {
          status: 'error',
          starting: false,
          polling: false,
          checkingDevice: false,
          error: errorMessage,
          ...(choicesRef.current.find((choice) => choice.id === providerId)?.requiresExplicitCancel
            ? { url: undefined, state: undefined, flow: undefined, userCode: undefined, callbackUrl: '' }
            : {}),
        });
        if (surfaceErrors) toast.error(t('oauth.status_error_badge', { msg: errorMessage }));
        return 'error';
      }
      return 'wait';
    } catch (error: unknown) {
      if (disposedRef.current || generationRef.current[providerId] !== generation) return 'wait';
      const errorMessage = describeError(error);
      // A read that failed says nothing about the attempt: CPA may still hold it and
      // the browser may still be on the vendor's consent screen. Ending the attempt
      // here would strand a live session behind a Retry that opens a second one, so
      // the failure becomes a note on a still-waiting attempt and the poll continues.
      statusReadFailuresRef.current[providerId] = errorMessage;
      updateProviderState(providerId, { checkingDevice: false, error: errorMessage });
      return 'unread';
    }
  }, [clearStatusTimer, complete, toast, t, updateProviderState]);

  const scheduleStatusPoll = React.useCallback((providerId: string, token: string, generation: number) => {
    if (disposedRef.current) return;
    clearStatusTimer(providerId);
    const tick = async () => {
      if (generationRef.current[providerId] !== generation) return;
      const outcome = await enqueueCheck(providerId, () => performStatusCheck(providerId, token, generation, true));
      if (disposedRef.current) return;
      if (isPollingOutcome(outcome) && generationRef.current[providerId] === generation) {
        // The timer that ran this pass has already fired, and a callback submission
        // for the same generation may have armed its own while this check was in
        // flight. Clearing first is what keeps one loop rather than two.
        clearStatusTimer(providerId);
        statusTimersRef.current[providerId] = window.setTimeout(() => {
          void tick();
        }, STATUS_POLL_INTERVAL_MS);
      }
    };
    statusTimersRef.current[providerId] = window.setTimeout(() => {
      void tick();
    }, STATUS_POLL_INTERVAL_MS);
  }, [clearStatusTimer, enqueueCheck, performStatusCheck]);

  const start = React.useCallback(async (providerId: string) => {
    const choice = choicesRef.current.find((candidate) => candidate.id === providerId);
    if (!choice || choice.pluginPageRoute) return;
    const current = states[providerId];
    if (startInFlightRef.current[providerId] || isOAuthSessionActive(current) || current?.starting) return;
    startInFlightRef.current[providerId] = true;

    clearProviderTimers(providerId);
    delete statusReadFailuresRef.current[providerId];
    const generation = (generationRef.current[providerId] ?? 0) + 1;
    generationRef.current[providerId] = generation;
    updateProviderState(providerId, {
      ...emptySession(),
      status: 'starting',
      starting: true,
    });

    try {
      const response = await api.startOAuthFlow(providerId);
      if (disposedRef.current || generationRef.current[providerId] !== generation) return;
      const token = (response.state || response.session_id || '').trim();
      const flow = resolveStartedOAuthFlow(choice.flow, response);
      const userCode = (response.user_code || '').trim() || undefined;
      updateProviderState(providerId, {
        url: response.url,
        state: token || undefined,
        flow,
        userCode,
        status: 'waiting',
        starting: false,
        polling: Boolean(token),
      });
      if (token) scheduleStatusPoll(providerId, token, generation);
    } catch (error: unknown) {
      if (generationRef.current[providerId] !== generation) return;
      const errorMessage = describeError(error);
      updateProviderState(providerId, {
        status: 'error',
        starting: false,
        error: errorMessage,
      });
      toast.error(t('oauth.status_error_badge', { msg: errorMessage }));
    } finally {
      startInFlightRef.current[providerId] = false;
    }
  }, [clearProviderTimers, toast, scheduleStatusPoll, states, t, updateProviderState]);

  const cancel = React.useCallback(async (providerId: string) => {
    const choice = choicesRef.current.find((candidate) => candidate.id === providerId);
    if (!choice) return;
    const token = (states[providerId]?.state ?? '').trim();
    const generation = (generationRef.current[providerId] ?? 0) + 1;
    generationRef.current[providerId] = generation;
    updateProviderState(providerId, { cancelling: true, cancelError: undefined });

    try {
      const response = token
        ? await api.cancelOAuthSession(token)
        : { status: 'ok', cancelled: true };
      if (disposedRef.current || generationRef.current[providerId] !== generation) return;
      clearProviderTimers(providerId);
      if (response.cancelled) {
        setStates((previous) => ({ ...previous, [providerId]: emptySession() }));
        toast.info(t('oauth.session_cancelled'));
        return;
      }

      // CPA says the session could not be cancelled, which means it may already
      // have completed. Re-read it instead of painting a false cancellation.
      updateProviderState(providerId, { cancelling: false, status: 'waiting' });
      const outcome = await enqueueCheck(providerId, () => performStatusCheck(providerId, token, generation, true));
      if (disposedRef.current) return;
      if (isPollingOutcome(outcome) && generationRef.current[providerId] === generation) {
        updateProviderState(providerId, { polling: true });
        scheduleStatusPoll(providerId, token, generation);
      }
    } catch (error: unknown) {
      if (disposedRef.current || generationRef.current[providerId] !== generation) return;
      const errorMessage = describeError(error);
      updateProviderState(providerId, { cancelling: false, cancelError: errorMessage, polling: Boolean(token) });
      if (token) scheduleStatusPoll(providerId, token, generation);
      toast.error(t('oauth.cancel_failed', { msg: errorMessage }));
    }
  }, [clearProviderTimers, enqueueCheck, toast, performStatusCheck, scheduleStatusPoll, states, t, updateProviderState]);

  const setCallbackUrl = React.useCallback((providerId: string, value: string) => {
    updateProviderState(providerId, { callbackUrl: value });
  }, [updateProviderState]);

  const submitCallback = React.useCallback(async (providerId: string) => {
    const choice = choicesRef.current.find((candidate) => candidate.id === providerId);
    const rules = choice?.callback;
    if (!rules) return;
    const current = states[providerId] ?? emptySession();
    const rawInput = current.callbackUrl.trim();
    if (!rawInput) {
      toast.warning(t('oauth.callback_required'));
      return;
    }
    const callbackError = rules.validate?.(rawInput, current.state);
    if (callbackError) {
      const key = callbackError === 'state_mismatch'
        ? rules.errorKeys.stateMismatch
        : rules.errorKeys.invalid;
      toast.warning(t(key ?? rules.errorKeys.invalid));
      return;
    }
    const redirectUrl = rules.resolve ? rules.resolve(rawInput, current.state) : rawInput;
    if (!redirectUrl) {
      toast.warning(t(rules.errorKeys.missingState));
      return;
    }
    if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
      toast.warning(t(rules.errorKeys.invalid));
      return;
    }

    const generation = generationRef.current[providerId] ?? 0;
    updateProviderState(providerId, {
      callbackSubmitting: true,
      callbackStatus: undefined,
      callbackError: undefined,
    });

    try {
      const response = await api.handleOAuthCallback({ provider: providerId, redirect_url: redirectUrl });
      if (disposedRef.current || generationRef.current[providerId] !== generation) return;
      if (response.completed) {
        complete(providerId, generation);
        return;
      }
      updateProviderState(providerId, { callbackSubmitting: false, callbackStatus: 'success' });
      toast.success(t('oauth.callback_submitted'));
      const token = (current.state ?? '').trim();
      if (token) {
        const outcome = await enqueueCheck(providerId, () => performStatusCheck(providerId, token, generation, false));
        if (isPollingOutcome(outcome) && generationRef.current[providerId] === generation) {
          updateProviderState(providerId, { polling: true });
          scheduleStatusPoll(providerId, token, generation);
        }
      }
    } catch (error: unknown) {
      if (disposedRef.current || generationRef.current[providerId] !== generation) return;
      const token = (current.state ?? '').trim();
      if (token) {
        const outcome = await enqueueCheck(providerId, () => performStatusCheck(providerId, token, generation, false));
        if (outcome === 'ok') return;
      }
      if (disposedRef.current || generationRef.current[providerId] !== generation) return;
      const errorMessage = describeError(error);
      updateProviderState(providerId, {
        callbackSubmitting: false,
        callbackStatus: 'error',
        callbackError: errorMessage,
      });
      toast.error(t('oauth.callback_failed', { msg: errorMessage }));
    }
  }, [complete, enqueueCheck, toast, performStatusCheck, scheduleStatusPoll, states, t, updateProviderState]);

  const check = React.useCallback(async (providerId: string) => {
    const generation = generationRef.current[providerId] ?? 0;
    const token = (states[providerId]?.state ?? '').trim();
    updateProviderState(providerId, { checkingDevice: true });
    const outcome = await enqueueCheck(providerId, () => performStatusCheck(providerId, token, generation, true));
    if (disposedRef.current || generationRef.current[providerId] !== generation) return;
    updateProviderState(providerId, { checkingDevice: false });
    if (outcome === 'wait') toast.info(t('oauth.status_waiting_badge'));
  }, [enqueueCheck, toast, performStatusCheck, states, t, updateProviderState]);

  const activeProviders = React.useMemo(
    () => Object.entries(states)
      .filter(([, state]) => isOAuthSessionActive(state))
      .map(([providerId]) => providerId),
    [states],
  );

  return {
    states,
    activeProviders,
    start,
    cancel,
    submitCallback,
    check,
    setCallbackUrl,
    reset,
  };
}
