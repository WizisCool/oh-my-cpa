import React from 'react';
import { Button, Tooltip } from 'antd';
import { LogoutOutlined, ReloadOutlined } from '@ant-design/icons';
import { PreferenceMenus } from './PreferenceMenus';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';

interface HeaderNavProps {
  isDiscovering?: boolean;
  onDiscover?: () => void;
  onLogout?: () => void;
  isLoggingOut?: boolean;
}

/**
 * The shell's right-hand actions: refresh, theme, language, sign out.
 *
 * Every one of them is a fixed-width control. Sign out is an icon button rather than a
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
 * The preferences are not implemented here: `PreferenceMenus` owns them, because the
 * authentication gate shows the same two menus over the same stored values.
 */
export const HeaderNav: React.FC<HeaderNavProps> = ({
  isDiscovering = false,
  onDiscover,
  onLogout,
  isLoggingOut = false,
}) => {
  const t = useT();
  const isDemo = isDemoMode();

  return (
    <div className="app-header-actions">
      {isDemo && (
        <Tooltip title={t('demo.badge_tooltip')}>
          <span className="demo-chip" role="note">
            {t('demo.badge')}
          </span>
        </Tooltip>
      )}
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