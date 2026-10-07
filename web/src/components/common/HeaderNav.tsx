import React from 'react';
import { Button, Tooltip } from 'antd';
import { GithubOutlined, LogoutOutlined, ReloadOutlined } from '../icons';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useI18n, LANGUAGES } from '../../i18n';
import { useTheme } from '../../theme/ThemeContext';
import { ActionMenu } from './ActionMenu';
import { PreferenceMenus } from './PreferenceMenus';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';

interface HeaderNavProps {
  isDiscovering?: boolean;
  onDiscover?: () => void;
  onLogout?: () => void;
  isLoggingOut?: boolean;
  /** An action that leads the cluster on every width: the assistant's toggle. */
  leading?: React.ReactNode;
}

/**
 * The shell's right-hand actions: assistant, repository, refresh, theme, language, sign out.
 *
 * Phones keep the assistant and refresh direct and disclose labelled tools; desktop controls remain fixed-width.
 * Every desktop action is a fixed-width control. Sign out is an icon button rather than a
 * labelled one because its label is the only text here that changes length with the
 * language - "退出" beside "Sign out" - and a button that resizes on a language switch
 * moves the controls beside it, so the operator has to re-aim at a button they were
 * already pointing at. Its name is on the tooltip and on the accessible label instead;
 * the exit-door icon carries the meaning at a glance.
 *
 * This cluster carries actions only. Connection status and version are the side rail
 * foot's, which is their one place, and a mount path is fixed for the life of a
 * deployment - neither is an action an operator reaches for here.
 *
 * On the demonstration the marker takes the sign-out button's place. That is not a
 * security measure - the server refuses the operations a demo must not perform -
 * but sign-out cannot mean anything here: the session is issued to whoever opens the
 * page, so the button would only appear to work. The marker says what the deployment
 * is instead, which is the thing the operator actually needs to know.
 *
 * Both renderings use the existing theme/language providers. `PreferenceMenus` keeps the
 * desktop and authentication-gate controls aligned with those same stored values.
 */
export const HeaderNav: React.FC<HeaderNavProps> = ({
  isDiscovering = false,
  onDiscover,
  onLogout,
  isLoggingOut = false,
  leading,
}) => {
  const t = useT();
  const isDemo = isDemoMode();
  const isPhone = useIsPhoneViewport();
  const { lang, setLang } = useI18n();
  const { modePreference, setModePreference } = useTheme();

  if (isPhone) {
    return (
      <div className="app-header-actions">
        {isDemo && <span className="demo-chip" role="note" title={t('demo.badge_tooltip')}>{t('demo.badge')}</span>}
        {leading}
        <Button type="text" icon={<ReloadOutlined />} loading={isDiscovering} onClick={onDiscover} aria-label={t('header.refresh_all')} />
        <ActionMenu label={t('header.tools')}>
          <span className="action-menu-label">{t('header.theme')}</span>
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <Button key={mode} type="text" aria-pressed={modePreference === mode} onClick={() => setModePreference(mode)}>
              {t(`omc.theme_mode_${mode}`)}
            </Button>
          ))}
          <span className="action-menu-label">{t('header.language')}</span>
          {LANGUAGES.map((language) => (
            <Button key={language.id} type="text" aria-pressed={lang === language.id} onClick={() => setLang(language.id)}>
              {language.name}
            </Button>
          ))}
          <Button type="text" icon={<GithubOutlined />} href="https://github.com/WizisCool/oh-my-cpa" target="_blank" rel="noopener noreferrer">
            {t('header.open_repository')}
          </Button>
          {!isDemo && <Button type="text" icon={<LogoutOutlined />} loading={isLoggingOut} onClick={onLogout}>{t('header.logout')}</Button>}
        </ActionMenu>
      </div>
    );
  }

  return (
    <div className="app-header-actions">
      {isDemo && (
        <Tooltip title={t('demo.badge_tooltip')}>
          <span className="demo-chip" role="note">
            {t('demo.badge')}
          </span>
        </Tooltip>
      )}
      {leading}
      <Tooltip title={t('header.open_repository')}>
        <Button
          type="text"
          icon={<GithubOutlined />}
          href="https://github.com/WizisCool/oh-my-cpa"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('header.open_repository')}
        />
      </Tooltip>
      <Tooltip title={t('header.refresh_all')}>
        <Button type="text" icon={<ReloadOutlined />} loading={isDiscovering} onClick={onDiscover} aria-label={t('header.refresh_all')} />
      </Tooltip>
      <PreferenceMenus />
      {!isDemo && (
        <Tooltip title={t('header.logout')}>
          <Button
            className="header-logout"
            type="text"
            icon={<LogoutOutlined />}
            loading={isLoggingOut}
            onClick={onLogout}
            aria-label={t('header.logout')}
          />
        </Tooltip>
      )}
    </div>
  );
};