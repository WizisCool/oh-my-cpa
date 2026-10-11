import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Tooltip } from 'antd';
import { api } from '../../api/client';
import { GithubOutlined, LogoutOutlined, ReloadOutlined, Star } from '../icons';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useI18n, LANGUAGES } from '../../i18n';
import { useTheme } from '../../theme/ThemeContext';
import { ActionMenu } from './ActionMenu';
import { HeaderAction } from './HeaderAction';
import { PreferenceMenus } from './PreferenceMenus';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { formatStarCount } from '../../utils/format';

const REPOSITORY_URL = 'https://github.com/WizisCool/oh-my-cpa';
/** The server reads the count at most hourly, so asking more often learns nothing. */
const STAR_COUNT_STALE_MS = 60 * 60 * 1000;

interface HeaderNavProps {
  isDiscovering?: boolean;
  onDiscover?: () => void;
  onLogout?: () => void;
  isLoggingOut?: boolean;
}

/**
 * The shell's right-hand actions: repository, refresh, theme, language, sign out.
 *
 * Phones keep refresh direct and disclose labelled tools; desktop controls remain fixed-width.
 * Every desktop action is a fixed-width control. Sign out is an icon button rather than a
 * labelled one because its label is the only text here that changes length with the
 * language - "退出" beside "Sign out" - and a button that resizes on a language switch
 * moves the controls beside it, so the operator has to re-aim at a button they were
 * already pointing at. Its name is on the tooltip and on the accessible label instead;
 * the exit-door icon carries the meaning at a glance.
 *
 * Every desktop control is a `HeaderAction`, which is what gives the row one height, one
 * weight and one hover. The repository link is the exception to fixed width, and only
 * while it is pointed at or focused: at rest it is the GitHub mark alone, and it unfolds
 * the project's star count once the server has read one. It sits first in a
 * right-aligned cluster, so unfolding widens it away from the other controls and none of
 * them moves. The count comes from the server, never from the browser asking GitHub,
 * which keeps the console free of third-party requests. It has no tooltip: the mark is
 * its own name, and the unfolding count is already its answer to a hover. A hairline separates the link from the
 * console's own actions: it leaves the console, they act on it.
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
}) => {
  const t = useT();
  const isDemo = isDemoMode();
  const isPhone = useIsPhoneViewport();
  const { lang, setLang } = useI18n();
  const { modePreference, setModePreference } = useTheme();
  // A failed read is not retried or reported: the count is decoration on a link that
  // works without it.
  const { data: repository } = useQuery({
    queryKey: ['system-repository'],
    queryFn: api.getSystemRepository,
    staleTime: STAR_COUNT_STALE_MS,
    retry: false,
  });
  const starCount = repository?.stargazers_count ?? null;
  const stars = starCount === null ? null : (
    <>
      <Star className="header-star-icon" size="1em" fill="currentColor" aria-hidden="true" />
      {formatStarCount(starCount)}
    </>
  );

  if (isPhone) {
    return (
      <div className="app-header-actions">
        {isDemo && <span className="demo-chip" role="note" title={t('demo.badge_tooltip')}>{t('demo.badge')}</span>}
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
          <Button type="text" icon={<GithubOutlined />} href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
            {t('header.open_repository')}
            {stars === null ? null : <span className="header-star-count">{stars}</span>}
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
      <HeaderAction
        label={t('header.open_repository')}
        tooltip={false}
        icon={<GithubOutlined />}
        href={REPOSITORY_URL}
        target="_blank"
        rel="noopener noreferrer"
        isLabelFolded
      >
        {stars}
      </HeaderAction>
      <span className="app-header-divider" aria-hidden="true" />
      <HeaderAction label={t('header.refresh_all')} icon={<ReloadOutlined />} loading={isDiscovering} onClick={onDiscover} />
      <PreferenceMenus />
      {!isDemo && (
        <HeaderAction
          className="header-logout"
          tone="muted"
          label={t('header.logout')}
          icon={<LogoutOutlined />}
          loading={isLoggingOut}
          onClick={onLogout}
        />
      )}
    </div>
  );
};