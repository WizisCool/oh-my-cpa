import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { useT, type TFunc } from '../i18n';
import { LobeIcon, getProviderDefaultIcon } from '../components/LobeIcon';
import {
  BUILTIN_OAUTH_IDS,
  BUILTIN_OAUTH_PROVIDERS,
  OAUTH_PROVIDER_PATTERN,
  normalizeOAuthFlow,
  normalizeOAuthStatus,
  type OAuthCallbackRules,
  type OAuthFlowKind,
  type OAuthProviderDefinition,
} from './oauthProviderLogic';
import styles from './OAuthPage.module.css';

const { Text, Paragraph } = Typography;

interface ProviderState {
  url?: string;
  state?: string;
  /** CPA's own label for the started flow; decides which sub-box is rendered. */
  flow?: OAuthFlowKind;
  /** Device grants issue a short code the operator types on the vendor page. */
  userCode?: string;
  status?: 'idle' | 'waiting' | 'success' | 'error';
  error?: string;
  starting?: boolean;
  cancelling?: boolean;
  checkingDevice?: boolean;
  polling?: boolean;
  cancelError?: string;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
}

/**
 * One renderable OAuth card. Built-in and plugin providers differ only in where
 * their copy comes from, so they share a shape instead of a discriminated union
 * that every render branch has to narrow.
 */
interface OAuthCard {
  id: string;
  flow: OAuthFlowKind;
  iconId: string;
  title: string;
  description: string;
  loginLabel: string;
  /** Set only for CPA plugin providers. */
  pluginId?: string;
  pluginLogo?: string;
  pluginRawTitle?: string;
  requiresExplicitCancel?: boolean;
  callback?: OAuthCallbackRules;
}

const SUCCESS_RESET_DELAY_MS = 10000;
const OAUTH_STATUS_POLL_INTERVAL_MS = 3000;

function builtinCard(provider: OAuthProviderDefinition, t: TFunc): OAuthCard {
  return {
    id: provider.id,
    flow: provider.flow,
    iconId: provider.iconId,
    title: t(`oauth.${provider.keyBase}_title`),
    description: t(`oauth.${provider.keyBase}_hint`),
    loginLabel: t(`oauth.${provider.keyBase}_login`),
    requiresExplicitCancel: provider.requiresExplicitCancel,
    callback: provider.callback,
  };
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

  // 2. Built-in cards come from the provider registry
  const builtinCards = useMemo<OAuthCard[]>(
    () => BUILTIN_OAUTH_PROVIDERS.map((provider) => builtinCard(provider, t)),
    [t],
  );

  // 3. Build dynamic plugin OAuth card definitions
  const pluginCards = useMemo<OAuthCard[]>(() => {
    if (!pluginsData?.plugins) return [];
    const seen = new Set<string>(BUILTIN_OAUTH_IDS);
    const list: OAuthCard[] = [];

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
        id: providerKey,
        flow: 'manual-callback',
        iconId: getProviderDefaultIcon(providerKey, title),
        title: t('oauth.plugin_title', { name: title }),
        description: plugin.description?.trim() || t('oauth.plugin_hint', { name: title }),
        loginLabel: t('oauth.plugin_login', { name: title }),
        pluginId: plugin.id,
        pluginLogo: (plugin.logo || plugin.metadata?.logo || '').trim() || undefined,
        pluginRawTitle: title,
        // A plugin declares its own callback route, so the console cannot know
        // its state binding rules; CPA's callback endpoint still validates the
        // state it issued.
        callback: {
          errorKeys: {
            invalid: 'oauth.callback_invalid_url',
            missingState: 'oauth.missing_state',
          },
        },
      });
    }
    return list;
  }, [pluginsData, t]);

  const [searchParams] = useSearchParams();
  const targetProviderParam = searchParams.get('provider');

  useEffect(() => {
    if (!targetProviderParam) return;
    const norm = targetProviderParam.toLowerCase().trim();
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-oauth-card="${norm}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add(styles['card-target-highlight']);
        setTimeout(() => {
          el.classList.remove(styles['card-target-highlight']);
        }, 2500);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [targetProviderParam, builtinCards, pluginCards]);

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
      flow: undefined,
      userCode: undefined,
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
  const pollOAuthStatusUntilSettled = useCallback((card: OAuthCard, token: string, generation: number) => {
    const provider = card.id;
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
          updateProviderState(provider, {
            status: 'error',
            polling: false,
            error: errMsg,
            // An expired, denied or cancelled session cannot accept another
            // callback, so the card must stop offering the paste box. Providers
            // that allow a restart keep the session so the operator can retry
            // the same URL; the ones that require an explicit cancel release it,
            // because nothing can complete it any more.
            ...(card.requiresExplicitCancel
              ? { url: undefined, state: undefined, flow: undefined, userCode: undefined, callbackUrl: '' }
              : {}),
          });
          message.error(t('oauth.status_error_badge', { msg: errMsg }));
        }
        // "wait" keeps the spinner; no message spam on every tick.
      })();
    }, OAUTH_STATUS_POLL_INTERVAL_MS);
  }, [clearStatusPollTimer, completeProviderAuth, message, t, updateProviderState]);

  const handleStartAuth = async (card: OAuthCard) => {
    const providerId = card.id;
    clearProviderTimers(providerId);

    const startGen = (generationRef.current[providerId] || 0) + 1;
    generationRef.current[providerId] = startGen;

    updateProviderState(providerId, {
      url: undefined,
      state: undefined,
      flow: undefined,
      userCode: undefined,
      status: 'idle',
      starting: true,
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

    try {
      const res = await api.startOAuthFlow(providerId);
      if (generationRef.current[providerId] !== startGen) return;

      const token = (res.state || res.session_id || '').trim();
      const flow = normalizeOAuthFlow(res.flow) ?? card.flow;
      const userCode = (res.user_code || '').trim() || undefined;
      if (!token) {
        // CPA variants without a state (device flows answered elsewhere)
        // cannot be polled; surface the URL and let the explicit check
        // button drive completion.
        updateProviderState(providerId, {
          url: res.url,
          state: undefined,
          flow,
          userCode,
          status: 'waiting',
          starting: false,
        });
        return;
      }
      updateProviderState(providerId, {
        url: res.url,
        state: token,
        flow,
        userCode,
        status: 'waiting',
        polling: true,
        starting: false,
      });
      pollOAuthStatusUntilSettled(card, token, startGen);
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

  const handleCancelAuth = async (card: OAuthCard) => {
    const providerId = card.id;
    const currentState = states[providerId] || {};
    const token = currentState.state;

    const cancelGen = (generationRef.current[providerId] || 0) + 1;
    generationRef.current[providerId] = cancelGen;

    updateProviderState(providerId, {
      cancelling: true,
      cancelError: undefined,
    });

    const resetSession = () => {
      updateProviderState(providerId, {
        url: undefined,
        state: undefined,
        flow: undefined,
        userCode: undefined,
        status: 'idle',
        starting: false,
        polling: false,
        cancelling: false,
        checkingDevice: false,
        error: undefined,
        cancelError: undefined,
        callbackUrl: '',
        callbackSubmitting: false,
        callbackStatus: undefined,
        callbackError: undefined,
      });
    };

    try {
      const res = token ? await api.cancelOAuthSession(token) : { status: 'ok', cancelled: true };
      clearProviderTimers(providerId);
      if (generationRef.current[providerId] !== cancelGen) return;

      if (res.cancelled) {
        resetSession();
        message.info(t('oauth.session_cancelled'));
        return;
      }

      // CPA could not cancel because the session already finished or expired.
      // Claiming cancellation would hide a credential that may just have been
      // saved, so the card keeps the session and re-reads its real outcome.
      updateProviderState(providerId, { cancelling: false, status: 'waiting' });
      if (token) {
        pollOAuthStatusUntilSettled(card, token, cancelGen);
      } else {
        resetSession();
      }
    } catch (err: unknown) {
      const errMsg = err instanceof ApiError ? err.message : String(err);
      if (generationRef.current[providerId] === cancelGen) {
        updateProviderState(providerId, {
          cancelling: false,
          cancelError: errMsg,
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

  const handleSubmitCallback = async (card: OAuthCard) => {
    const providerId = card.id;
    const rules = card.callback;
    if (!rules) return;
    const currentState = states[providerId] || {};
    const rawInput = (currentState.callbackUrl || '').trim();

    if (!rawInput) {
      message.warning(t('oauth.callback_required'));
      return;
    }
    const callbackError = rules.validate?.(rawInput, currentState.state);
    if (callbackError) {
      const key = callbackError === 'state_mismatch'
        ? rules.errorKeys.stateMismatch
        : rules.errorKeys.invalid;
      message.warning(t(key ?? rules.errorKeys.invalid));
      return;
    }
    // A provider that needs no rewriting submits the pasted URL verbatim.
    const redirectUrl = rules.resolve ? rules.resolve(rawInput, currentState.state) : rawInput;
    if (!redirectUrl) {
      message.warning(t(rules.errorKeys.missingState));
      return;
    }
    if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
      message.warning(t(rules.errorKeys.invalid));
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

  const handleCheckDeviceStatus = async (card: OAuthCard) => {
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

  // Plugin logos come straight from the plugin manifest (store logos are
  // absolute/data URLs). A logo that fails to load degrades to the
  // name-matched lobe icon, mirroring CPAMC's plug fallback.
  const PluginLogo: React.FC<{ logo?: string; fallbackIconId: string }> = ({ logo, fallbackIconId }) => {
    const [failed, setFailed] = React.useState(false);
    if (logo && !failed) {
      return (
        <img
          src={logo}
          alt=""
          width={28}
          height={28}
          style={{ borderRadius: 4, objectFit: 'contain', display: 'block' }}
          onError={() => setFailed(true)}
        />
      );
    }
    return <LobeIcon iconId={fallbackIconId} size={28} />;
  };

  const renderIcon = (card: OAuthCard) => (
    <div className={styles['icon-box']}>
      {card.pluginId ? (
        <PluginLogo key={card.pluginLogo || 'none'} logo={card.pluginLogo} fallbackIconId={card.iconId} />
      ) : (
        <LobeIcon iconId={card.iconId} size={28} />
      )}
    </div>
  );

  const renderCard = (card: OAuthCard) => {
    const state = states[card.id] || {};
    const isWaiting = state.status === 'waiting';
    const isSuccess = state.status === 'success';
    const isError = state.status === 'error';
    const isExpanded = Boolean(state.url || isWaiting || isSuccess || isError);
    // What CPA started decides which sub-box is real; the declared flow is the
    // fallback for CPA variants that do not report it.
    const flow = state.flow ?? card.flow;

    const loginButtonText = isSuccess ? t('oauth.login_another') : card.loginLabel;

    return (
      <div
        key={card.id}
        className={styles.card}
        data-oauth-card={card.id}
      >
        <div className={styles['card-header']}>
          <div className={styles['card-identity']}>
            {renderIcon(card)}
            <div className={styles['card-main']}>
              <div className={styles['card-title-row']}>
                <h3 className={styles['card-title']}>{card.title}</h3>
                {card.pluginId && (
                  <Tag color="purple" icon={<ApiOutlined />} className={styles['plugin-tag']}>
                    {t('oauth.plugin_tag')}
                  </Tag>
                )}
              </div>
              <Paragraph className={styles['card-desc']}>{card.description}</Paragraph>
            </div>
          </div>

          <div className={styles['card-actions']}>
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
              className={styles['btn-regular-login']}
              loading={state.starting}
              // One attempt per provider at a time: a second session would
              // leave the first one open on CPA while the operator still holds
              // its authorization URL.
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
          <div className={styles['card-expanded']}>
            {/* 1. Auth URL Container */}
            {state.url && (
              <div className={styles['auth-url-box']}>
                <div className={styles['auth-url-header']}>
                  <span className={styles['auth-url-label']}>{t('oauth.auth_url_label')}</span>
                  <div className={styles['auth-url-actions']}>
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
                <div className={styles['auth-url-value']}>{state.url}</div>
              </div>
            )}

            {/* 2. Manual Callback Section (for manual-callback flow) */}
            {flow === 'manual-callback' && card.callback && Boolean(state.url) && (
              <div className={styles['callback-box']} data-oauth-callback-box>
                <div className={styles['callback-label']}>{t('oauth.callback_label')}</div>
                <div className={styles['callback-hint']}>
                  {t(card.callback.errorKeys.hintKey ?? 'oauth.callback_hint')}
                </div>
                <div className={styles['callback-input-row']}>
                  <Input
                    value={state.callbackUrl || ''}
                    placeholder={t(card.callback.errorKeys.placeholderKey ?? 'oauth.callback_placeholder')}
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
                    className={styles['callback-input']}
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
                  <div className={styles['callback-status-area']}>
                    <Tag color="processing" icon={<CheckCircleOutlined />}>
                      {t('oauth.callback_submitted')}
                    </Tag>
                  </div>
                )}
                {state.callbackStatus === 'error' && (
                  <div className={styles['callback-status-area']}>
                    <Tag color="error" icon={<CloseCircleOutlined />}>
                      {state.callbackError || t('oauth.callback_failed', { msg: '' })}
                    </Tag>
                  </div>
                )}
              </div>
            )}

            {/* 2b. Device Code Confirmation Section (for device flow) */}
            {flow === 'device' && Boolean(state.url) && (
              <div className={styles['callback-box']}>
                <div className={styles['callback-label']}>{t('oauth.device_flow_label')}</div>
                <div className={styles['callback-hint']}>{t('oauth.device_flow_hint')}</div>
                {state.userCode && (
                  <div className={styles['callback-input-row']}>
                    <Text className={styles['device-code-value']} data-oauth-user-code>
                      {state.userCode}
                    </Text>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => handleCopyLink(state.userCode)}
                    >
                      {t('oauth.copy_code')}
                    </Button>
                  </div>
                )}
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
            <div className={styles['status-row']}>
              <div className={styles['status-indicator']}>
                {isWaiting && (
                  <>
                    <Spin size="small" />
                    <Text type="secondary">{t('oauth.status_waiting_badge')}</Text>
                  </>
                )}
                {isSuccess && (
                  <>
                    <CheckCircleOutlined className={styles['success-icon']} />
                    <Text strong className={styles['success-text']}>
                      {t('oauth.status_success_badge')}
                    </Text>
                  </>
                )}
                {isError && (
                  <>
                    <CloseCircleOutlined className={styles['error-icon']} />
                    <Text className={styles['error-text']}>
                      {t('oauth.status_error_badge', { msg: state.error || '' })}
                    </Text>
                  </>
                )}
              </div>

              <div className={styles['status-action-row']}>
                {state.cancelError && (
                  <Text type="danger" className={styles['cancel-error-text']}>
                    {t('oauth.cancel_failed', { msg: state.cancelError })}
                  </Text>
                )}
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
      <div className={styles['page-head']}>
        <div className={styles['title-area']}>
          <h1 className={styles['page-title']}>{t('oauth.title')}</h1>
          <p className={styles['page-subtitle']}>{t('oauth.subtitle')}</p>
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
      <div className={styles['cards-list']}>
        {/* 1. Built-in Cards */}
        {builtinCards.map((card) => renderCard(card))}

        {/* 2. CPA Plugin Dynamic OAuth Cards */}
        {pluginCards.length > 0 && (
          <>
            <div className={styles['section-header']}>
              <h2 className={styles['section-title']}>{t('oauth.plugin_section_title')}</h2>
            </div>
            {pluginCards.map((card) => renderCard(card))}
          </>
        )}

        {pluginsLoading && (
          <div className={styles['loading-center']}>
            <Spin size="small" />
          </div>
        )}
      </div>
    </div>
  );
};
