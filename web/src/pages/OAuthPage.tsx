import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Input,
  Tag,
  Typography,
  Spin,
  App as AntdApp,
} from 'antd';
import {
  SyncOutlined,
  LinkOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ArrowRightOutlined,
  ApiOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { LobeIcon, getProviderDefaultIcon } from '../components/LobeIcon';
import styles from './OAuthPage.module.css';

const { Text, Paragraph } = Typography;

interface ProviderState {
  url?: string;
  state?: string;
  status?: 'idle' | 'waiting' | 'success' | 'error';
  error?: string;
  starting?: boolean;
  cancelling?: boolean;
  checkingDevice?: boolean;
  polling?: boolean;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
}

interface BuiltInOAuthDefinition {
  kind: 'builtin';
  id: string;
  titleKey: string;
  hintKey: string;
  loginBtnKey: string;
  iconId: string;
  flowKind: 'manual-callback' | 'device';
}

interface PluginOAuthDefinition {
  kind: 'plugin';
  id: string;
  pluginId: string;
  title: string;
  rawTitle: string;
  description: string;
  flowKind: 'manual-callback';
}

type OAuthCardDefinition = BuiltInOAuthDefinition | PluginOAuthDefinition;

const BUILTIN_PROVIDERS: BuiltInOAuthDefinition[] = [
  {
    kind: 'builtin',
    id: 'kimi',
    titleKey: 'oauth.kimi_title',
    hintKey: 'oauth.kimi_hint',
    loginBtnKey: 'oauth.kimi_login',
    iconId: 'Kimi',
    flowKind: 'device',
  },
  {
    kind: 'builtin',
    id: 'codex',
    titleKey: 'oauth.codex_title',
    hintKey: 'oauth.codex_hint',
    loginBtnKey: 'oauth.codex_login',
    iconId: 'Codex',
    flowKind: 'manual-callback',
  },
  {
    kind: 'builtin',
    id: 'anthropic',
    titleKey: 'oauth.anthropic_title',
    hintKey: 'oauth.anthropic_hint',
    loginBtnKey: 'oauth.anthropic_login',
    iconId: 'Claude',
    flowKind: 'manual-callback',
  },
  {
    kind: 'builtin',
    id: 'antigravity',
    titleKey: 'oauth.antigravity_title',
    hintKey: 'oauth.antigravity_hint',
    loginBtnKey: 'oauth.antigravity_login',
    iconId: 'Antigravity',
    flowKind: 'manual-callback',
  },
  {
    kind: 'builtin',
    id: 'xai',
    titleKey: 'oauth.xai_title',
    hintKey: 'oauth.xai_hint',
    loginBtnKey: 'oauth.xai_login',
    iconId: 'Grok',
    flowKind: 'manual-callback',
  },
];

const BUILTIN_IDS = new Set<string>(BUILTIN_PROVIDERS.map((p) => p.id));
const OAUTH_PROVIDER_PATTERN = /^[a-z0-9-]+$/;
const SUCCESS_RESET_DELAY_MS = 10000;
const OAUTH_STATUS_POLL_INTERVAL_MS = 3000;
const XAI_CALLBACK_URL = 'http://127.0.0.1:56121/callback';

// normalizeOAuthStatus maps CPA get-auth-status variants to one UI
// contract: "ok" completed, "error" failed, "wait" still in flight.
// "success"/"pending" are legacy aliases that must not flip the card
// into a terminal state on their own.
export function normalizeOAuthStatus(status: unknown): 'ok' | 'error' | 'wait' {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'ok' || normalized === 'success') return 'ok';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'error';
  return 'wait';
}

function readQueryLikeCallbackParams(value: string): URLSearchParams | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  const rawParams = queryStart >= 0 ? trimmed.slice(queryStart + 1) : hashStart >= 0 ? trimmed.slice(hashStart + 1) : trimmed;
  if (!/(^|[&#?])(code|state|error)=/i.test(rawParams)) return null;
  try {
    return new URLSearchParams(rawParams.replace(/^[?#]/, ''));
  } catch {
    return null;
  }
}

function extractDisplayedXaiCode(value: string): string {
  const trimmed = value.trim();
  const codeMatch = trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i);
  return (codeMatch?.[1] ?? trimmed).trim();
}

// resolveOAuthCallbackUrl mirrors CPAMC: non-xai providers submit the pasted
// redirect URL verbatim, while xai also accepts a bare code shown on the
// Grok page and rebuilds the fixed local callback URL with the live state.
export function resolveOAuthCallbackUrl(provider: string, input: string, state?: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (provider !== 'xai') return trimmed;
  try {
    // eslint-disable-next-line no-new -- absolute-URL probe only
    new URL(trimmed);
    return trimmed;
  } catch {
    // Relative input falls through to code/state reconstruction below.
  }
  const params = readQueryLikeCallbackParams(trimmed);
  if (params) {
    const code = params.get('code')?.trim();
    const error = params.get('error')?.trim();
    const errorDescription = params.get('error_description')?.trim();
    const callbackState = params.get('state')?.trim() || state?.trim();
    if (!callbackState) return null;
    const callbackUrl = new URL(XAI_CALLBACK_URL);
    callbackUrl.searchParams.set('state', callbackState);
    if (code) callbackUrl.searchParams.set('code', code);
    if (error) callbackUrl.searchParams.set('error', error);
    if (errorDescription) callbackUrl.searchParams.set('error_description', errorDescription);
    return callbackUrl.toString();
  }
  const code = extractDisplayedXaiCode(trimmed);
  const callbackState = state?.trim();
  if (!code || !callbackState) return null;
  const callbackUrl = new URL(XAI_CALLBACK_URL);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', callbackState);
  return callbackUrl.toString();
}

export const OAuthPage: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [states, setStates] = useState<Record<string, ProviderState>>({});
  const successResetTimers = useRef<Record<string, number>>({});
  // Active get-auth-status pollers per provider, mirroring the CPAMC
  // OAuth page: started after startAuth, stopped on success/error/cancel.
  const statusPollTimers = useRef<Record<string, number>>({});
  const generationRef = useRef<Record<string, number>>({});

  // 1. Fetch CPA Plugins to discover dynamic OAuth providers
  const {
    data: pluginsData,
    isLoading: pluginsLoading,
    isFetching: pluginsFetching,
    refetch: refetchPlugins,
  } = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 30000,
  });

  // 2. Build dynamic plugin OAuth card definitions
  const pluginCards = useMemo<PluginOAuthDefinition[]>(() => {
    if (!pluginsData?.plugins) return [];
    const seen = new Set<string>(BUILTIN_IDS);
    const list: PluginOAuthDefinition[] = [];

    for (const plugin of pluginsData.plugins) {
      const supportsOAuth = Boolean(plugin.supports_oauth);
      const providerKey = (plugin.oauth_provider || (supportsOAuth ? plugin.id : '')).trim().toLowerCase();
      const isEnabled = plugin.effective_enabled ?? plugin.enabled;

      if (!supportsOAuth || !isEnabled || !providerKey || seen.has(providerKey) || !OAUTH_PROVIDER_PATTERN.test(providerKey)) {
        continue;
      }
      seen.add(providerKey);

      const title = plugin.metadata?.name?.trim() || plugin.name?.trim() || plugin.id;

      list.push({
        kind: 'plugin',
        id: providerKey,
        pluginId: plugin.id,
        title: t('oauth.plugin_title', { name: title }),
        rawTitle: title,
        description: plugin.description?.trim() || t('oauth.plugin_hint', { name: title }),
        flowKind: 'manual-callback',
      });
    }
    return list;
  }, [pluginsData, t]);

  const updateProviderState = useCallback((provider: string, next: Partial<ProviderState>) => {
    setStates((prev) => ({
      ...prev,
      [provider]: { ...(prev[provider] ?? {}), ...next },
    }));
  }, []);

  const clearSuccessTimer = useCallback((provider: string) => {
    const timer = successResetTimers.current[provider];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete successResetTimers.current[provider];
    }
  }, []);

  const clearStatusPollTimer = useCallback((provider: string) => {
    const timer = statusPollTimers.current[provider];
    if (timer !== undefined) {
      window.clearInterval(timer);
      delete statusPollTimers.current[provider];
    }
  }, []);

  const clearProviderTimers = useCallback((provider: string) => {
    clearSuccessTimer(provider);
    clearStatusPollTimer(provider);
  }, [clearSuccessTimer, clearStatusPollTimer]);

  const clearAllTimers = useCallback(() => {
    Object.values(successResetTimers.current).forEach((timer) => window.clearTimeout(timer));
    Object.values(statusPollTimers.current).forEach((timer) => window.clearInterval(timer));
    successResetTimers.current = {};
    statusPollTimers.current = {};
  }, []);

  useEffect(() => {
    return () => {
      clearAllTimers();
    };
  }, [clearAllTimers]);

  const resetProviderSession = useCallback((provider: string) => {
    clearProviderTimers(provider);
    setStates((prev) => ({
      ...prev,
      [provider]: {},
    }));
  }, [clearProviderTimers]);

  // completeProviderAuth is the single terminal-success transition. Only
  // the status poller (or an explicit device check) may call it, so a
  // manual callback submission can never paint "success" before CPA
  // confirms the credential exchange.
  const completeProviderAuth = useCallback((provider: string, generation: number, opts?: { silent?: boolean }) => {
    if (generationRef.current[provider] !== generation) return;
    clearProviderTimers(provider);
    updateProviderState(provider, {
      url: undefined,
      state: undefined,
      status: 'success',
      polling: false,
      error: undefined,
      callbackUrl: '',
      callbackSubmitting: false,
      callbackStatus: undefined,
      callbackError: undefined,
    });

    void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
    void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
    void queryClient.invalidateQueries({ queryKey: ['management-overview'] });

    if (!opts?.silent) {
      message.success(t('oauth.status_success_badge'));
    }

    successResetTimers.current[provider] = window.setTimeout(() => {
      if (generationRef.current[provider] === generation) {
        resetProviderSession(provider);
      }
    }, SUCCESS_RESET_DELAY_MS);
  }, [clearProviderTimers, message, queryClient, resetProviderSession, t, updateProviderState]);

  // pollOAuthStatusUntilSettled mirrors the CPAMC OAuth page: after the
  // authorization URL is issued, keep asking CPA for the session outcome.
  // This is what turns an automatic browser redirect (which completes the
  // flow without any manual submission) into a success badge, and what
  // absorbs a duplicate manual submission that CPA answers with 409.
  const pollOAuthStatusUntilSettled = useCallback((provider: string, token: string, generation: number) => {
    clearStatusPollTimer(provider);
    statusPollTimers.current[provider] = window.setInterval(() => {
      void (async () => {
        if (generationRef.current[provider] !== generation) {
          clearStatusPollTimer(provider);
          return;
        }
        let res;
        try {
          res = await api.getOAuthStatus(token);
        } catch (err: unknown) {
          if (generationRef.current[provider] !== generation) return;
          const errMsg = err instanceof ApiError ? err.message : String(err);
          clearStatusPollTimer(provider);
          updateProviderState(provider, { status: 'error', polling: false, error: errMsg });
          message.error(t('oauth.status_error_badge', { msg: errMsg }));
          return;
        }
        if (generationRef.current[provider] !== generation) return;
        const normalized = normalizeOAuthStatus(res.status);
        if (normalized === 'ok') {
          completeProviderAuth(provider, generation);
        } else if (normalized === 'error') {
          const errMsg = (res.message || res.error || '').trim() || t('oauth.status_failed');
          clearStatusPollTimer(provider);
          updateProviderState(provider, { status: 'error', polling: false, error: errMsg });
          message.error(t('oauth.status_error_badge', { msg: errMsg }));
        }
        // "wait" keeps the spinner; no message spam on every tick.
      })();
    }, OAUTH_STATUS_POLL_INTERVAL_MS);
  }, [clearStatusPollTimer, completeProviderAuth, message, t, updateProviderState]);

  const handleStartAuth = async (card: OAuthCardDefinition) => {
    const providerId = card.id;
    clearProviderTimers(providerId);

    const startGen = (generationRef.current[providerId] || 0) + 1;
    generationRef.current[providerId] = startGen;

    updateProviderState(providerId, {
      url: undefined,
      state: undefined,
      status: 'idle',
      starting: true,
      cancelling: false,
      checkingDevice: false,
      polling: false,
      error: undefined,
      callbackUrl: '',
      callbackSubmitting: false,
      callbackStatus: undefined,
      callbackError: undefined,
    });

    try {
      const res = await api.startOAuthFlow(providerId);
      if (generationRef.current[providerId] !== startGen) return;

      const token = (res.state || res.session_id || '').trim();
      if (!token) {
        // CPA variants without a state (device flows answered elsewhere)
        // cannot be polled; surface the URL and let the explicit check
        // button drive completion.
        updateProviderState(providerId, {
          url: res.url,
          state: undefined,
          status: 'waiting',
          starting: false,
        });
        return;
      }
      updateProviderState(providerId, {
        url: res.url,
        state: token,
        status: 'waiting',
        polling: true,
        starting: false,
      });
      pollOAuthStatusUntilSettled(providerId, token, startGen);
    } catch (err: unknown) {
      if (generationRef.current[providerId] !== startGen) return;
      const errMsg = err instanceof ApiError ? err.message : String(err);
      updateProviderState(providerId, {
        status: 'error',
        starting: false,
        error: errMsg,
      });
      message.error(t('oauth.status_error_badge', { msg: errMsg }));
    }
  };

  const handleCancelAuth = async (card: OAuthCardDefinition) => {
    const providerId = card.id;
    const currentState = states[providerId] || {};
    const token = currentState.state;

    const cancelGen = (generationRef.current[providerId] || 0) + 1;
    generationRef.current[providerId] = cancelGen;

    updateProviderState(providerId, {
      cancelling: true,
    });

    try {
      if (token) {
        await api.cancelOAuthSession(token);
      }
      clearProviderTimers(providerId);

      if (generationRef.current[providerId] === cancelGen) {
        updateProviderState(providerId, {
          url: undefined,
          state: undefined,
          status: 'idle',
          starting: false,
          polling: false,
          cancelling: false,
          checkingDevice: false,
          error: undefined,
          callbackUrl: '',
          callbackSubmitting: false,
          callbackStatus: undefined,
          callbackError: undefined,
        });
        message.info(t('oauth.session_cancelled'));
      }
    } catch (err: unknown) {
      const errMsg = err instanceof ApiError ? err.message : String(err);
      if (generationRef.current[providerId] === cancelGen) {
        updateProviderState(providerId, {
          cancelling: false,
        });
        message.error(t('oauth.status_error_badge', { msg: errMsg }));
      }
    }
  };

  const handleCopyLink = async (url?: string) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message.success(t('oauth.link_copied'));
    } catch {
      message.error(t('oauth.copy_failed'));
    }
  };

  const handleSubmitCallback = async (card: OAuthCardDefinition) => {
    const providerId = card.id;
    const currentState = states[providerId] || {};
    const rawInput = (currentState.callbackUrl || '').trim();

    if (!rawInput) {
      message.warning(t('oauth.callback_required'));
      return;
    }
    // Non-xai providers submit the pasted provider redirect URL verbatim;
    // only xai accepts a bare code and rebuilds the fixed local callback.
    const redirectUrl = providerId === 'xai'
      ? resolveOAuthCallbackUrl(providerId, rawInput, currentState.state)
      : rawInput;
    if (!redirectUrl) {
      message.warning(t(providerId === 'xai' ? 'oauth.xai_callback_state_missing' : 'oauth.missing_state'));
      return;
    }
    if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
      message.warning(t('oauth.callback_invalid_url'));
      return;
    }

    const currentGen = generationRef.current[providerId] || 0;

    updateProviderState(providerId, {
      callbackSubmitting: true,
      callbackStatus: undefined,
      callbackError: undefined,
    });

    let callbackRes;
    try {
      callbackRes = await api.handleOAuthCallback({
        provider: providerId,
        redirect_url: redirectUrl,
      });
    } catch (err: unknown) {
      // A duplicate submission for an already-completed flow is not a
      // failure: CPA answers 409, the facade re-checks get-auth-status,
      // and a completed session must converge to success instead of
      // painting an error over saved credentials.
      if (generationRef.current[providerId] !== currentGen) return;
      const token = (currentState.state || '').trim();
      if (token) {
        try {
          const statusRes = await api.getOAuthStatus(token);
          if (generationRef.current[providerId] !== currentGen) return;
          if (normalizeOAuthStatus(statusRes.status) === 'ok') {
            updateProviderState(providerId, { callbackSubmitting: false, callbackStatus: 'success' });
            completeProviderAuth(providerId, currentGen);
            return;
          }
        } catch {
          // Fall through to the callback error below.
        }
        if (generationRef.current[providerId] !== currentGen) return;
      }
      const errMsg = err instanceof ApiError ? err.message : String(err);
      updateProviderState(providerId, {
        callbackSubmitting: false,
        callbackStatus: 'error',
        callbackError: errMsg,
      });
      message.error(t('oauth.callback_failed', { msg: errMsg }));
      return;
    }

    if (generationRef.current[providerId] !== currentGen) return;

    // The facade reports completed=true when CPA had already finished the
    // exchange via the automatic browser redirect: converge to success.
    if (callbackRes?.completed) {
      updateProviderState(providerId, { callbackSubmitting: false, callbackStatus: 'success' });
      completeProviderAuth(providerId, currentGen);
      return;
    }

    // Otherwise the code was accepted and CPA is still exchanging; keep
    // the card in waiting state and let the status poller confirm success.
    updateProviderState(providerId, {
      callbackSubmitting: false,
      callbackStatus: 'success',
    });
    message.success(t('oauth.callback_submitted'));

    // If startAuth never produced a pollable state (or the timer was
    // cleared), do one immediate status read so a pasted URL alone can
    // converge without waiting for the next tick.
    const token = (currentState.state || '').trim();
    if (token && statusPollTimers.current[providerId] === undefined) {
      try {
        const statusRes = await api.getOAuthStatus(token);
        if (generationRef.current[providerId] !== currentGen) return;
        if (normalizeOAuthStatus(statusRes.status) === 'ok') {
          completeProviderAuth(providerId, currentGen);
        }
      } catch {
        // The poller (or a later retry) will surface the outcome.
      }
    }
  };

  const handleCheckDeviceStatus = async (card: OAuthCardDefinition) => {
    const providerId = card.id;
    const currentState = states[providerId] || {};
    const token = currentState.state;
    if (!token) return;

    const currentGen = generationRef.current[providerId] || 0;
    updateProviderState(providerId, { checkingDevice: true });

    try {
      const res = await api.getOAuthStatus(token);
      if (generationRef.current[providerId] !== currentGen) return;

      if (normalizeOAuthStatus(res.status) === 'ok') {
        updateProviderState(providerId, { checkingDevice: false });
        completeProviderAuth(providerId, currentGen);
      } else if (normalizeOAuthStatus(res.status) === 'error') {
        const errMsg = (res.message || (res as { error?: string }).error || '').trim();
        updateProviderState(providerId, { checkingDevice: false, status: 'error', error: errMsg || undefined });
        message.error(t('oauth.status_error_badge', { msg: errMsg }));
      } else {
        updateProviderState(providerId, { checkingDevice: false });
        message.info(res.message || t('oauth.status_waiting_badge'));
      }
    } catch (err: unknown) {
      if (generationRef.current[providerId] !== currentGen) return;
      const errMsg = err instanceof ApiError ? err.message : String(err);
      updateProviderState(providerId, { checkingDevice: false });
      message.error(errMsg);
    }
  };

  const renderIcon = (card: OAuthCardDefinition) => {
    const iconId = card.kind === 'builtin'
      ? card.iconId
      : getProviderDefaultIcon(card.id, card.rawTitle);

    return (
      <div className={styles.iconBox}>
        <LobeIcon iconId={iconId} size={28} />
      </div>
    );
  };

  const renderCard = (card: OAuthCardDefinition) => {
    const state = states[card.id] || {};
    const isWaiting = state.status === 'waiting';
    const isSuccess = state.status === 'success';
    const isError = state.status === 'error';
    const isExpanded = Boolean(state.url || isWaiting || isSuccess || isError);

    const titleText = card.kind === 'builtin' ? t(card.titleKey) : card.title;
    const descText = card.kind === 'builtin' ? t(card.hintKey) : card.description;
    const loginButtonText = isSuccess
      ? t('oauth.login_another')
      : card.kind === 'builtin'
        ? t(card.loginBtnKey)
        : t('oauth.plugin_login', { name: card.rawTitle });

    return (
      <div
        key={card.id}
        className={styles.card}
        data-oauth-card={card.id}
      >
        <div className={styles.cardHeader}>
          <div className={styles.cardIdentity}>
            {renderIcon(card)}
            <div className={styles.cardMain}>
              <div className={styles.cardTitleRow}>
                <h3 className={styles.cardTitle}>{titleText}</h3>
                {card.kind === 'plugin' && (
                  <Tag color="purple" icon={<ApiOutlined />} className={styles.pluginTag}>
                    {t('oauth.plugin_tag')}
                  </Tag>
                )}
              </div>
              <Paragraph className={styles.cardDesc}>{descText}</Paragraph>
            </div>
          </div>

          <div className={styles.cardActions}>
            {isWaiting && (
              <Button
                danger
                icon={<StopOutlined />}
                loading={state.cancelling}
                onClick={() => handleCancelAuth(card)}
              >
                {t('oauth.cancel_session')}
              </Button>
            )}

            <Button
              type="default"
              className={styles.btnRegularLogin}
              loading={state.starting}
              disabled={isWaiting}
              onClick={() => handleStartAuth(card)}
              data-oauth-start={card.id}
            >
              {loginButtonText}
            </Button>
          </div>
        </div>

        {/* In-Card Active Session and Callback / Device Flow */}
        {isExpanded && (
          <div className={styles.cardExpanded}>
            {/* 1. Auth URL Container */}
            {state.url && (
              <div className={styles.authUrlBox}>
                <div className={styles.authUrlHeader}>
                  <span className={styles.authUrlLabel}>{t('oauth.auth_url_label')}</span>
                  <div className={styles.authUrlActions}>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => handleCopyLink(state.url)}
                    >
                      {t('oauth.copy_link')}
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      icon={<LinkOutlined />}
                      onClick={() => window.open(state.url, '_blank', 'noopener,noreferrer')}
                    >
                      {t('oauth.open_link')}
                    </Button>
                  </div>
                </div>
                <div className={styles.authUrlValue}>{state.url}</div>
              </div>
            )}

            {/* 2. Manual Callback Section (for manual-callback flow) */}
            {card.flowKind === 'manual-callback' && Boolean(state.url) && (
              <div className={styles.callbackBox} data-oauth-callback-box>
                <div className={styles.callbackLabel}>{t('oauth.callback_label')}</div>
                <div className={styles.callbackHint}>{t('oauth.callback_hint')}</div>
                <div className={styles.callbackInputRow}>
                  <Input
                    value={state.callbackUrl || ''}
                    placeholder={t('oauth.callback_placeholder')}
                    aria-label={t('oauth.callback_label')}
                    data-oauth-callback-input
                    onChange={(e) =>
                      updateProviderState(card.id, {
                        callbackUrl: e.target.value,
                        callbackStatus: undefined,
                        callbackError: undefined,
                      })
                    }
                    onPressEnter={() => handleSubmitCallback(card)}
                    className={styles.callbackInput}
                  />
                  <Button
                    type="primary"
                    loading={state.callbackSubmitting}
                    onClick={() => handleSubmitCallback(card)}
                    data-oauth-callback-submit
                  >
                    {t('oauth.submit_callback_btn')}
                  </Button>
                </div>

                {state.callbackStatus === 'success' && state.status !== 'success' && (
                  <div className={styles.callbackStatusArea}>
                    <Tag color="processing" icon={<CheckCircleOutlined />}>
                      {t('oauth.callback_submitted')}
                    </Tag>
                  </div>
                )}
                {state.callbackStatus === 'error' && (
                  <div className={styles.callbackStatusArea}>
                    <Tag color="error" icon={<CloseCircleOutlined />}>
                      {state.callbackError || t('oauth.callback_failed', { msg: '' })}
                    </Tag>
                  </div>
                )}
              </div>
            )}

            {/* 2b. Device Code Confirmation Section (for device flow) */}
            {card.flowKind === 'device' && Boolean(state.url) && (
              <div className={styles.callbackBox}>
                <div className={styles.callbackLabel}>{t('oauth.device_flow_label')}</div>
                <div className={styles.callbackHint}>{t('oauth.device_flow_hint')}</div>
                <div>
                  <Button
                    type="primary"
                    loading={state.checkingDevice}
                    onClick={() => handleCheckDeviceStatus(card)}
                  >
                    {t('oauth.check_auth_status')}
                  </Button>
                </div>
              </div>
            )}

            {/* 3. Session Status Display */}
            <div className={styles.statusRow}>
              <div className={styles.statusIndicator}>
                {isWaiting && (
                  <>
                    <Spin size="small" />
                    <Text type="secondary">{t('oauth.status_waiting_badge')}</Text>
                  </>
                )}
                {isSuccess && (
                  <>
                    <CheckCircleOutlined className={styles.successIcon} />
                    <Text strong className={styles.successText}>
                      {t('oauth.status_success_badge')}
                    </Text>
                  </>
                )}
                {isError && (
                  <>
                    <CloseCircleOutlined className={styles.errorIcon} />
                    <Text className={styles.errorText}>
                      {t('oauth.status_error_badge', { msg: state.error || '' })}
                    </Text>
                  </>
                )}
              </div>

              <div className={styles.statusActionRow}>
                {isSuccess && (
                  <Button
                    type="link"
                    size="small"
                    icon={<ArrowRightOutlined />}
                    onClick={() => navigate('/auth-files')}
                  >
                    {t('oauth.view_auth_files')}
                  </Button>
                )}
                {isError && (
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={() => handleStartAuth(card)}
                  >
                    {t('common.retry')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`terminal-page oauth-page ${styles.container}`}>
      {/* Header */}
      <div className={styles.pageHead}>
        <div className={styles.titleArea}>
          <h1 className={styles.pageTitle}>{t('oauth.title')}</h1>
          <p className={styles.pageSubtitle}>{t('oauth.subtitle')}</p>
        </div>

        <Button
          size="small"
          icon={<SyncOutlined spin={pluginsFetching} />}
          onClick={() => void refetchPlugins()}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {/* Cards List */}
      <div className={styles.cardsList}>
        {/* 1. Built-in Cards */}
        {BUILTIN_PROVIDERS.map((card) => renderCard(card))}

        {/* 2. CPA Plugin Dynamic OAuth Cards */}
        {pluginCards.length > 0 && (
          <>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>{t('oauth.plugin_section_title')}</h2>
            </div>
            {pluginCards.map((card) => renderCard(card))}
          </>
        )}

        {pluginsLoading && (
          <div className={styles.loadingCenter}>
            <Spin size="small" />
          </div>
        )}
      </div>
    </div>
  );
};
