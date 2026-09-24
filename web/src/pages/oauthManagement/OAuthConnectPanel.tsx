import React from 'react';
import {
  App as AntdApp,
  Button,
  Drawer,
  Input,
  Select,
  Space,
  Spin,
  Tag,
} from 'antd';
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  LinkOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import { copyText } from '../../utils/clipboard';
import { isDemoMode } from '../../types/demoMode';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import type { OAuthProviderChoice } from '../oauthProviderLogic';
import type { OAuthSessionsController } from './useOAuthSessions';
import styles from './OAuthConnectPanel.module.css';

interface OAuthConnectPanelProps {
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
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const isDemo = isDemoMode();
  const choice = choices.find((candidate) => candidate.id === selectedProviderId);
  const session = selectedProviderId ? sessions.states[selectedProviderId] : undefined;
  const flow = session?.flow ?? choice?.flow;
  const isWaiting = session?.status === 'waiting';
  const isSuccess = session?.status === 'success';
  const isError = session?.status === 'error';
  const hasStarted = Boolean(session?.url || isWaiting || isSuccess || isError);

  useOverlayHistory({ isOpen: open, onClose });

  const copyValue = async (value?: string, successKey = 'oauth.link_copied') => {
    if (!value) return;
    if (await copyText(value)) {
      message.success(t(successKey));
    } else {
      message.error(t('oauth.copy_failed'));
    }
  };

  const providerOptions = choices.map((candidate) => ({
    value: candidate.id,
    title: candidate.title,
    label: (
      <Space size={8}>
        <ProviderBrandIcon iconId={candidate.iconId} logo={candidate.pluginLogo} size={18} />
        <span>{candidate.title}</span>
        {candidate.pluginId && <Tag className={styles['plugin-tag']}>{t('oauth.plugin_tag')}</Tag>}
      </Space>
    ),
  }));

  return (
    <Drawer
      title={t('omc.connect_account')}
      size="large"
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
              <Select
                id="oauth-connect-provider"
                value={selectedProviderId}
                placeholder={t('omc.connect_provider_placeholder')}
                showSearch={{ optionFilterProp: 'title' }}
                allowClear
                options={providerOptions}
                onChange={(value) => onSelectProvider((value ?? '').trim())}
                style={{ width: '100%' }}
                getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
              />
            </div>

            <div className={styles['provider-grid-section']}>
              <div className={styles['grid-header']}>
                <span className={styles['grid-title']}>{t('oauth.providers_title')}</span>
                <span className={styles['grid-count']}>{choices.length}</span>
              </div>
              <div className={styles['provider-grid']}>
                {choices.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={styles['provider-tile']}
                    data-oauth-card={candidate.id}
                    onClick={() => onSelectProvider(candidate.id)}
                  >
                    <div className={styles['tile-icon']}>
                      <ProviderBrandIcon iconId={candidate.iconId} logo={candidate.pluginLogo} size={22} />
                    </div>
                    <div className={styles['tile-copy']}>
                      <div className={styles['tile-title-row']}>
                        <span className={styles['tile-title']}>{candidate.title}</span>
                        <Tag style={{ margin: 0 }}>
                          {candidate.flow === 'device' ? t('omc.flow_device') : t('omc.flow_redirect')}
                        </Tag>
                        {candidate.pluginId && (
                          <Tag className={styles['plugin-tag']} style={{ margin: 0 }}>{t('oauth.plugin_tag')}</Tag>
                        )}
                      </div>
                      <span className={styles['tile-desc']} title={candidate.description}>
                        {candidate.description}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={styles['selector-wrap']}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label className={styles['field-label']} htmlFor="oauth-connect-provider">
                  {t('omc.connect_provider')}
                </label>
                <Button
                  size="small"
                  type="link"
                  onClick={() => onSelectProvider('')}
                  style={{ padding: 0 }}
                >
                  {t('omc.change_provider')}
                </Button>
              </div>
              <Select
                id="oauth-connect-provider"
                value={selectedProviderId}
                placeholder={t('omc.connect_provider_placeholder')}
                showSearch={{ optionFilterProp: 'title' }}
                allowClear
                options={providerOptions}
                onChange={(value) => onSelectProvider((value ?? '').trim())}
                style={{ width: '100%' }}
                getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
              />
            </div>

            <div className={styles['connect-identity']}>
              <div className={styles['connect-icon']}>
                <ProviderBrandIcon iconId={choice.iconId} logo={choice.pluginLogo} size={28} />
              </div>
              <div className={styles['connect-copy']}>
                <div className={styles['connect-title-row']}>
                  <h3 className={styles['connect-title']}>{choice.title}</h3>
                  <Tag>{flow === 'device' ? t('omc.flow_device') : t('omc.flow_redirect')}</Tag>
                  {choice.pluginId && <Tag className={styles['plugin-tag']}>{t('oauth.plugin_tag')}</Tag>}
                </div>
                <p className={styles['connect-desc']}>{choice.description}</p>
              </div>
            </div>

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
                type="primary"
                loading={session?.starting}
                disabled={isWaiting || isDemo}
                onClick={() => void sessions.start(choice.id)}
                data-oauth-start={choice.id}
              >
                {isSuccess ? t('oauth.login_another') : choice.loginLabel}
              </Button>
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
                          type="primary"
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
                        <Input.TextArea
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
                      <Input.TextArea
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
                          type="primary"
                          data-oauth-callback-submit
                          loading={session?.callbackSubmitting}
                          onClick={() => void sessions.submitCallback(choice.id)}
                        >
                          {t('oauth.submit_callback_btn')}
                        </Button>
                        {session?.callbackStatus === 'success' && (
                          <Tag color="success" icon={<CheckCircleOutlined />}>{t('oauth.callback_submitted')}</Tag>
                        )}
                        {session?.callbackStatus === 'error' && (
                          <Tag color="error" icon={<CloseCircleOutlined />}>
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
                          <Button size="middle" icon={<CopyOutlined />} onClick={() => void copyValue(session.userCode, 'common.copied')}>
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
                      <Spin size="small" />
                      <div className={styles['waiting-copy']}>
                        <span className={styles['waiting-title']}>{t('oauth.status_waiting_badge')}</span>
                        <span className={styles['waiting-desc']}>{t('oauth.status_waiting')}</span>
                        {session?.error && (
                          <span className={styles['waiting-note']} data-oauth-status-read-failure>
                            {t('oauth.status_unread', { msg: session.error })}
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
                        <span className={styles['success-desc']}>{t('oauth.status_success')}</span>
                      </div>
                      <div className={styles['success-actions']}>
                        <Button
                          type="primary"
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
                        <Button icon={<ReloadOutlined />} onClick={() => void sessions.start(choice.id)}>
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
    </Drawer>
  );
};
