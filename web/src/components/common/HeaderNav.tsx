import React from 'react';
import { Button, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LogoutOutlined,
  MoonOutlined,
  ReloadOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { getAppConfig } from '../../types/config';
import { HealthStatus } from '../../types/resource';
import type { ThemeMode } from '../../theme/themeConfig';
import { useI18n, useT } from '../../i18n';

interface HeaderNavProps {
  health?: HealthStatus;
  isDiscovering?: boolean;
  onDiscover?: () => void;
  onLogout?: () => void;
  isLoggingOut?: boolean;
  themeMode: ThemeMode;
  onToggleTheme: () => void;
  isMobile?: boolean;
}

// Right-hand header actions (connection pill, refresh, theme, language, sign out).
// HeaderNav is not self-contained: the breadcrumb and collapse toggle belong to
// AppLayout, which owns the shell grid these actions sit in.
export const HeaderNav: React.FC<HeaderNavProps> = ({
  health,
  isDiscovering = false,
  onDiscover,
  onLogout,
  isLoggingOut = false,
  themeMode,
  onToggleTheme,
  isMobile = false,
}) => {
  const t = useT();
  const { lang, toggleLang } = useI18n();
  const config = getAppConfig();
  // This pill describes CPA itself, not Oh My CPA's aggregate health. The Go
  // service can remain available in a degraded state while CPA is fully offline.
  const isOnline = health?.cpa_connected === true;

  return (
    <div className="app-header-actions">
      {!isMobile && (
        <Tooltip title={t('header.base_path', { path: config.basePath || '/' })}>
          <Tag className="base-path-tag">{config.basePath || '/'}</Tag>
        </Tooltip>
      )}
      <Tooltip title={
        isOnline
          ? t('header.online', { version: health?.version ? ` · ${health.version}` : '' })
          : t('header.offline')
      }>
        <span className={`connection-pill ${isOnline ? 'is-online' : 'is-offline'}`}>
          {isOnline ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          <span>{isOnline ? 'CPA ONLINE' : 'CPA OFFLINE'}</span>
        </span>
      </Tooltip>
      <Tooltip title={t('header.refresh_all')}>
        <Button type="text" icon={<ReloadOutlined />} loading={isDiscovering} onClick={onDiscover} aria-label={t('header.refresh_all')} />
      </Tooltip>
      <Tooltip title={t('header.theme')}>
        <Button type="text" icon={themeMode === 'dark' ? <SunOutlined /> : <MoonOutlined />} onClick={onToggleTheme} aria-label={t('header.theme')} />
      </Tooltip>
      <Tooltip title={t('header.language')}>
        <Button type="text" onClick={toggleLang} aria-label={t('header.language')}>
          <span className="terminal-mono">{lang === 'zh' ? 'EN' : '中'}</span>
        </Button>
      </Tooltip>
      <Button className="header-logout" type="text" icon={<LogoutOutlined />} loading={isLoggingOut} onClick={onLogout}>{t('header.logout')}</Button>
    </div>
  );
};
