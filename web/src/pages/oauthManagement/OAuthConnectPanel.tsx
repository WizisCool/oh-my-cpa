import type { OAuthRecoveryTarget } from '../../types/oauth';
import { Notice } from '../../components/feedback';
import type { MessageKey } from '../../i18n/catalog';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  LinkOutlined,
  ReloadOutlined,
  StopOutlined,
} from '../../components/icons';
import { useT } from '../../i18n';
import { copyText } from '../../utils/clipboard';
import { isDemoMode } from '../../types/demoMode';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { oauthProviderGroups, type OAuthProviderChoice, type OAuthProviderGroup } from '../oauthProviderLogic';
import type { OAuthSessionsController } from './useOAuthSessions';
import styles from './OAuthConnectPanel.module.css';
import { useToast } from '../../components/feedback';
import { AppDrawer } from '../../components/common/AppDrawer';
import { SearchSelect } from '../../components/common/SearchSelect';
import { SectionHeading } from '../../components/common/SectionHeading';
import { SecretInput } from '../../components/common/SecretInput';
import { Tag } from '../../components/common/Tag';
import { PluginOriginBadge } from '../../components/plugins/PluginParts';

const GROUP_TITLES: Record<OAuthProviderGroup, MessageKey> = {
  builtin: 'oauth.group_builtin',
  plugin: 'oauth.group_plugin',
};

/**
 * What kind of publisher a sign-in belongs to, on the card itself.
 *
 * A portal an OMC plugin declares is badged exactly as the plugin management page badges
 * the plugin, so the same provider reads the same on both surfaces; another plugin's portal
 * is plainly a plugin portal. The console's own sign-ins carry no tag: they are the section
 * they sit in.
 */
function ProviderKindTag({ choice }: { choice: OAuthProviderChoice }) {
  const t = useT();
  if (choice.isOmcPlugin) return <PluginOriginBadge origin="omc" />;
  if (choice.group === 'plugin') return <Tag>{t('oauth.plugin_tag')}</Tag>;
  return null;
}

interface OAuthConnectPanelProps {
  recoveryTarget?: OAuthRecoveryTarget;
  isRecoverySupported?: boolean;
  open: boolean;
  choices: OAuthProviderChoice[];
  selectedProviderId?: string;
  onSelectProvider: (providerId: string) => void;
  onClose: () => void;
  onViewCredentials: (providerId: string) => void;
  sessions: OAuthSessionsController;
}

export const OAuthConnectPanel: React.FC<OAuthConnectPanelProps> = ({
  open,
  choices,
  selectedProviderId,
  onSelectProvider,
  onClose,
  onViewCredentials,
  sessions,
  recoveryTarget,
  isRecoverySupported = false,
}) => {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const isDemo = isDemoMode();
  const choice = choices.find((candidate) => candidate.id === selectedProviderId);
  const groups = React.useMemo(() => oauthProviderGroups(choices), [choices]);
  const session = selectedProviderId ? sessions.states[selectedProviderId] : undefined;
  const flow = session?.flow ?? choice?.flow;
  const isWaiting = session?.status === 'waiting';
  const isSuccess = session?.status === 'success';
  const isError = session?.status === 'error';
  const hasStarted = Boolean(session?.url || isWaiting || isSuccess || isError);

  const target = session?.recoveryTarget ?? recoveryTarget;
  const [shouldVerify, setShouldVerify] = React.useState(false);
  React.useEffect(() => {
    setShouldVerify((session?.status === 'starting' || session?.status === 'waiting') && target?.verify === true);
  }, [open, selectedProviderId, target?.name, target?.auth_index, target?.verify, session?.status]);
  const [proxyUrl, setProxyUrl] = React.useState('');
  React.useEffect(() => { setProxyUrl(''); }, [open, selectedProviderId]);

  // This boolean records route intent across drawer remounts, never the secret itself.
  const requiresProxyReentry = Boolean(session?.requiresProxyReentry);
  const isStartBlocked = requiresProxyReentry
    && !proxyUrl.trim()
    && !session?.starting
    && !session?.polling
    && !isWaiting;

  const startAuthorization = () => {
    if (!choice || isStartBlocked || (target && !isRecoverySupported)) return;
    const selectedProxy = proxyUrl.trim();
    setProxyUrl('');
    void sessions.start(choice.id, selectedProxy || undefined, target ? { ...target, verify: shouldVerify } : undefined);
  };

  const useDefaultRoute = () => {
    if (!choice || (target && !isRecoverySupported)) return;
    setProxyUrl('');
    void sessions.startDefaultRoute(choice.id, target ? { ...target, verify: shouldVerify } : undefined);
  };

  const openPluginPage = () => {
    if (!choice?.pluginPageRoute) return;
    onClose();
    navigate(choice.pluginPageRoute);
  };

  const copyValue = async (value?: string, successKey: MessageKey = 'oauth.link_copied') => {
    if (!value) return;
    if (await copyText(value)) {
      toast.success(t(successKey));
    } else {
      toast.error(t('oauth.copy_failed'));
    }
  };

  const providerOptions = choices.map((candidate) => ({
    value: candidate.id,
    title: candidate.title,
    label: (
      <span className="inline-flex items-center gap-2">
        <ProviderBrandIcon mark={candidate} size={18} />
        <span>{candidate.title}</span>
        <ProviderKindTag choice={candidate} />
      </span>
    ),
  }));

  return (
    <AppDrawer
      widthKey="oauth_connect"
      title={t(target ? 'recovery.recover' : 'omc.connect_account')}
      width="wide"
      open={open}
      onClose={onClose}
      className={styles['connect-drawer']}
    >
      <div
        className={styles['connect-panel']}
        data-testid="oauth-connect-panel"
        data-oauth-card={selectedProviderId}
      >
        {!choice ? (
          <>
            <div className={styles['selector-wrap']}>
              <label className={styles['field-label']} htmlFor="oauth-connect-provider">
                {t('omc.connect_provider')}
              </label>
              <SearchSelect
                label={t('omc.connect_provider')}
                id="oauth-connect-provider"
                disabled={Boolean(target)}
                value={selectedProviderId}
                placeholder={t('omc.connect_provider_placeholder')}
                showSearch={{ optionFilterProp: 'title' }}
                allowClear
                options={providerOptions}
                onChange={(value) => onSelectProvider((value ?? '').trim())}
                style={{ width: '100%' }}
              />
            </div>

            <div className={styles['provider-grid-section']}>
              <SectionHeading title={t('oauth.providers_title')} count={choices.length} />
              {groups.map((section) => (
                <section key={section.group} className={styles['provider-group']} aria-labelledby={`oauth-group-${section.group}`}>
                  <SectionHeading
                    as="h4"
                    level="label"
                    id={`oauth-group-${section.group}`}
                    title={t(GROUP_TITLES[section.group])}
                    count={section.choices.length}
                  />
                  <div className={styles['provider-grid']}>
                    {section.choices.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        className={styles['provider-tile']}
                        data-oauth-card={candidate.id}
                        onClick={() => onSelectProvider(candidate.id)}
                      >
                        <div className={styles['tile-icon']}>
                          <ProviderBrandIcon mark={candidate} size={22} />
                        </div>
                        <div className={styles['tile-copy']}>
                          <div className={styles['tile-title-row']}>
                            <span className={styles['tile-title']}>{candidate.title}</span>
                            <ProviderKindTag choice={candidate} />
                          </div>
                          <span className={styles['tile-desc']} data-tip={candidate.description} data-tip-overflow="">
                            {candidate.description}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className={styles['selector-wrap']}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label className={styles['field-label']} htmlFor="oauth-connect-provider">
                  {t('omc.connect_provider')}
                </label>
                {!target && <Button
                  size="sm"
                  variant="link"
                  onClick={() => onSelectProvider('')}
                  style={{ padding: 0 }}
                >
                  {t('omc.change_provider')}
                </Button>}
              </div>
              <SearchSelect
                label={t('omc.connect_provider')}
                id="oauth-connect-provider"
                disabled={Boolean(target)}
                value={selectedProviderId}
                placeholder={t('omc.connect_provider_placeholder')}
                showSearch={{ optionFilterProp: 'title' }}
                allowClear
                options={providerOptions}
                onChange={(value) => onSelectProvider((value ?? '').trim())}
                style={{ width: '100%' }}
              />
            </div>

            <div className={styles['connect-identity']}>
              <div className={styles['connect-icon']}>
                <ProviderBrandIcon mark={choice} size={28} />
              </div>
              <div className={styles['connect-copy']}>
                <div className={styles['connect-title-row']}>
                  <h3 className={styles['connect-title']}>{choice.title}</h3>
                  <ProviderKindTag choice={choice} />
                </div>
                <p className={styles['connect-desc']}>{choice.description}</p>
              </div>
            </div>

            {target && <>
              <Notice tone="info" title={t('recovery.target', { name: target.name })} description={t('recovery.target_hint')} />
              {!isRecoverySupported && <Notice tone="warning" title={t('recovery.upgrade_required')} />}
              <Checkbox checked={shouldVerify} disabled={isWaiting || session?.starting || isDemo || !isRecoverySupported} onCheckedChange={(checked) => setShouldVerify(checked)}>
                {t('recovery.verify_opt_in')}
              </Checkbox>
            </>}
            {!isWaiting && !session?.starting && (
              <div>
                <label className={styles['field-label']} htmlFor="oauth-connect-proxy">{t('oauth.session_proxy')}</label>
                <SecretInput
                  key={choice.id}
                  id="oauth-connect-proxy"
                  maxLength={4096}
                  value={proxyUrl}
                  disabled={isDemo}
                  aria-describedby="oauth-connect-proxy-hint"
                  onChange={(event) => setProxyUrl(event.target.value)}
                />
                <p id="oauth-connect-proxy-hint" className={styles['step-hint']}>{t('oauth.session_proxy_hint')}</p>
              </div>
            )}
            <div className={styles['connect-actions']}>
              {isWaiting && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={session?.cancelling}
                  onClick={() => void sessions.cancel(choice.id)}
                >
                  {t('oauth.cancel_session')}
                </Button>
              )}
              <Button
                variant="primary"
                loading={session?.starting}
                disabled={isWaiting || isStartBlocked || (Boolean(target) && !isRecoverySupported) || isDemo}
                onClick={startAuthorization}
                data-oauth-start={choice.id}
              >
                {target ? t('recovery.recover') : isSuccess ? t('oauth.login_another') : choice.loginLabel}
              </Button>
              {choice.pluginPageRoute && (
                <Button
                  disabled={sessions.activeProviders.length > 0}
                  onClick={openPluginPage}
                  data-plugin-connect={choice.id}
                >
                  {t('oauth.plugin_open_page')}
                </Button>
              )}
              {isStartBlocked && (
                <Button variant="link" data-oauth-default-route onClick={useDefaultRoute}>
                  {t('oauth.use_default_route')}
                </Button>
              )}
            </div>

            {hasStarted && (
              <div className={styles['session-panel']}>
                {session?.url && (
                  <div className={styles['step-card']}>
                    <div className={styles['step-header']}>
                      <span className={styles['step-number']}>1</span>
                      <span className={styles['step-title']}>{t('oauth.open_auth_url')}</span>
                    </div>
                    <div className={styles['step-body']}>
                      <div className={styles['auth-url-actions']}>
                        <Button
                          variant="primary"
                          icon={<LinkOutlined />}
                          onClick={() => window.open(session.url, '_blank', 'noopener,noreferrer')}
                        >
                          {t('oauth.open_link')}
                        </Button>
                        <Button icon={<CopyOutlined />} onClick={() => void copyValue(session.url)}>
                          {t('oauth.copy_link')}
                        </Button>
                      </div>
                      <div className={styles['auth-url-box']}>
                        <Textarea
                          value={session.url}
                          autoSize={{ minRows: 1, maxRows: 3 }}
                          readOnly
                          className={styles['url-textarea']}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {flow === 'manual-callback' && choice.callback && (isWaiting || (isError && (!choice.requiresExplicitCancel || Boolean(session?.url)))) && (
                  <div className={styles['step-card']}>
                    <div className={styles['step-header']}>
                      <span className={styles['step-number']}>2</span>
                      <span className={styles['step-title']}>{t('oauth.callback_label')}</span>
                    </div>
                    <div className={styles['step-body']}>
                      <p className={styles['step-hint']}>
                        {choice.callback.errorKeys.hintKey ? t(choice.callback.errorKeys.hintKey) : t('oauth.callback_hint')}
                      </p>
                      <Textarea
                        id="oauth-callback-url"
                        data-oauth-callback-input
                        value={session?.callbackUrl ?? ''}
                        onChange={(event) => sessions.setCallbackUrl(choice.id, event.target.value)}
                        placeholder={choice.callback.errorKeys.placeholderKey
                          ? t(choice.callback.errorKeys.placeholderKey)
                          : t('oauth.callback_placeholder')}
                        autoSize={{ minRows: 2, maxRows: 4 }}
                      />
                      <div className={styles['callback-actions']}>
                        <Button
                          variant="primary"
                          data-oauth-callback-submit
                          loading={session?.callbackSubmitting}
                          onClick={() => void sessions.submitCallback(choice.id)}
                        >
                          {t('oauth.submit_callback_btn')}
                        </Button>
                        {session?.callbackStatus === 'success' && (
                          <Tag tone="success" icon={<CheckCircleOutlined />}>{t('oauth.callback_submitted')}</Tag>
                        )}
                        {session?.callbackStatus === 'error' && (
                          <Tag tone="danger" icon={<CloseCircleOutlined />}>
                            {session.callbackError || t('oauth.callback_failed', { msg: '' })}
                          </Tag>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {flow === 'device' && session?.url && (
                  <div className={styles['step-card']}>
                    <div className={styles['step-header']}>
                      <span className={styles['step-number']}>2</span>
                      <span className={styles['step-title']}>{t('oauth.device_flow_label')}</span>
                    </div>
                    <div className={styles['step-body']}>
                      <p className={styles['step-hint']}>{t('oauth.device_flow_hint')}</p>
                      {session.userCode && (
                        <div className={styles['device-code-row']}>
                          <span className={styles['device-code']} data-oauth-user-code>{session.userCode}</span>
                          <Button icon={<CopyOutlined />} onClick={() => void copyValue(session.userCode, 'common.copied')}>
                            {t('oauth.copy_code')}
                          </Button>
                        </div>
                      )}
                      <div className={styles['device-actions']}>
                        <Button
                          loading={session.checkingDevice}
                          onClick={() => void sessions.check(choice.id)}
                        >
                          {t('oauth.check_auth_status')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                <div className={styles['session-status-card']} aria-live="polite">
                  {isWaiting && (
                    <div className={styles['status-waiting-box']}>
                      <Spinner size="small" />
                      <div className={styles['waiting-copy']}>
                        <span className={styles['waiting-title']}>{t('oauth.status_waiting_badge')}</span>
                        <span className={styles['waiting-desc']}>{t('oauth.status_waiting')}</span>
                        {session?.error && (
                          <span className={styles['waiting-note']} data-oauth-status-read-failure>
                            {session.url ? t('oauth.status_unread', { msg: session.error }) : session.error}
                          </span>
                        )}
                        {/* A cancelled attempt stays waiting, so this is the only state that can
                            show why the cancellation did not take effect. */}
                        {session?.cancelError && (
                          <span className={styles['waiting-note']} data-oauth-cancel-failure>
                            {t('oauth.cancel_failed', { msg: session.cancelError })}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {isSuccess && (
                    <div className={styles['status-success-box']}>
                      <CheckCircleOutlined className={styles['success-icon']} />
                      <div className={styles['success-copy']}>
                        <span className={styles['success-title']}>{t('oauth.status_success_badge')}</span>
                        <span className={styles['success-desc']}>{t(target ? 'recovery.complete' : 'oauth.status_success')}</span>
                      </div>
                      <div className={styles['success-actions']}>
                        <Button
                          variant="primary"
                          icon={<ArrowRightOutlined />}
                          onClick={() => onViewCredentials(choice.id)}
                        >
                          {t('oauth.view_auth_files')}
                        </Button>
                      </div>
                    </div>
                  )}
                  {isError && (
                    <div className={styles['status-error-box']}>
                      <div className={styles['error-title-row']}>
                        <CloseCircleOutlined className={styles['error-icon']} />
                        <div className={styles['error-copy']}>
                          <span className={styles['error-title']}>{t('oauth.status_failed')}</span>
                          <span className={styles['error-desc']}>
                            {t('oauth.status_error_badge', { msg: session?.error || '' })}
                          </span>
                        </div>
                      </div>
                      <div>
                        <Button icon={<ReloadOutlined />} disabled={isStartBlocked} data-oauth-retry onClick={startAuthorization}>
                          {t('common.retry')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppDrawer>
  );
};
