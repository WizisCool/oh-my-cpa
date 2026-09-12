import React from 'react';
import { App as AntdApp, Layout, Menu, Drawer, Tooltip, Button, Breadcrumb, Spin } from 'antd';
import {
  ApiOutlined,
  CloudServerOutlined,
  ControlOutlined,
  DashboardOutlined,
  DollarOutlined,
  FieldTimeOutlined,
  FileProtectOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  LoginOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProfileOutlined,
  ShopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { HeaderNav } from './HeaderNav';
import { DataProgress } from './DataProgress';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useThemeMode } from '../../theme/ThemeContext';
import { useT, type TFunc } from '../../i18n';

const { Sider, Content } = Layout;

type NavItem = Required<MenuProps>['items'][number];

interface NavEntry {
  key: string;
  labelKey: string;
  icon: React.ReactNode;
}

interface NavGroup {
  key: string;
  labelKey: string;
  items: NavEntry[];
}

// Groups mirror the navigation model: Operate / Gateway / Observe / Control,
// plus the Oh My CPA layer.
const navGroups: NavGroup[] = [
  {
    key: 'operate',
    labelKey: 'nav.group.operate',
    items: [
      { key: '/dashboard', labelKey: 'nav.dashboard', icon: <DashboardOutlined /> },
      { key: '/quick-start', labelKey: 'nav.quick_start', icon: <ThunderboltOutlined /> },
    ],
  },
  {
    key: 'gateway',
    labelKey: 'nav.group.gateway',
    items: [
      { key: '/ai-providers', labelKey: 'nav.providers', icon: <CloudServerOutlined /> },
      // The three OAuth surfaces read as one flow: authenticate, then manage the
      // credentials it produced, then watch what they are allowed to consume.
      { key: '/oauth', labelKey: 'nav.oauth', icon: <LoginOutlined /> },
      { key: '/auth-files', labelKey: 'nav.auth_files', icon: <FileProtectOutlined /> },
      { key: '/quota', labelKey: 'nav.quota', icon: <FieldTimeOutlined /> },
    ],
  },
  {
    key: 'observe',
    labelKey: 'nav.group.observe',
    items: [
      { key: '/usage/events', labelKey: 'nav.usage_events', icon: <HistoryOutlined /> },
      { key: '/pricing', labelKey: 'nav.pricing', icon: <DollarOutlined /> },
      { key: '/logs', labelKey: 'nav.logs', icon: <ProfileOutlined /> },
    ],
  },
  {
    key: 'control',
    labelKey: 'nav.group.control',
    items: [
      { key: '/config', labelKey: 'nav.config', icon: <ControlOutlined /> },
      { key: '/plugins', labelKey: 'nav.plugins', icon: <ApiOutlined /> },
      { key: '/plugin-store', labelKey: 'nav.plugin_store', icon: <ShopOutlined /> },
      { key: '/system', labelKey: 'nav.system', icon: <InfoCircleOutlined /> },
    ],
  },
];

const navEntries: NavEntry[] = navGroups.flatMap((group) => group.items);

function buildMenuItems(t: TFunc, isCollapsed: boolean): NavItem[] {
  if (isCollapsed) {
    return navEntries.map((entry) => ({ key: entry.key, icon: entry.icon, label: t(entry.labelKey), title: t(entry.labelKey) }));
  }
  return navGroups.map((group) => ({
    key: `group:${group.key}`,
    type: 'group' as const,
    label: t(group.labelKey),
    children: group.items.map((entry): NavItem => ({
      key: entry.key,
      icon: entry.icon,
      label: t(entry.labelKey),
    })),
  }));
}

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}

export const AppLayout: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const { themeMode, toggleTheme } = useThemeMode();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(isNarrowViewport);
  const [isMobileNavOpen, setIsMobileNavOpen] = React.useState(false);

  React.useEffect(() => {
    const onResize = () => {
      const narrow = isNarrowViewport();
      setIsMobile(narrow);
      if (!narrow) setIsMobileNavOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The content column owns the scroll position, so reset it on navigation.
  // Without this a short page inherits the previous page's scroll offset and
  // appears blank below the fold.
  const contentRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const node = contentRef.current;
    if (node) node.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: api.getHealth,
    refetchInterval: 15000,
  });

  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: () => window.location.reload(),
    onError: (err: Error) => message.error(t('shell.logout_failed', { msg: err.message })),
  });

  const selectedKey = navEntries
    .map((entry) => entry.key)
    .filter((key) => location.pathname === key || location.pathname.startsWith(`${key}/`))
    .sort((a, b) => b.length - a.length)[0] ?? '/dashboard';
  const currentEntry = navEntries.find((entry) => entry.key === selectedKey);
  const currentGroup = navGroups.find((group) => group.items.some((entry) => entry.key === selectedKey));
  const menuItems = React.useMemo(() => buildMenuItems(t, isCollapsed), [t, isCollapsed]);

  const selectPage = ({ key }: { key: string }) => {
    navigate(key);
    setIsMobileNavOpen(false);
  };

  const menu = (
    <Menu
      mode="inline"
      theme="dark"
      items={menuItems}
      selectedKeys={[selectedKey]}
      onClick={selectPage}
      className="app-menu"
      inlineCollapsed={false}
    />
  );

  const handleBrandKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate('/dashboard');
    }
  };

  const brand = (
    <div
      className="app-brand"
      onClick={() => navigate('/dashboard')}
      onKeyDown={handleBrandKeyDown}
      role="button"
      tabIndex={0}
      aria-label="Dashboard"
    >
      <div className="app-brand-mark">›_</div>
      <div className="app-brand-copy">
        <strong>oh-my-cpa</strong>
        <span>{t('app.sub')}</span>
      </div>
    </div>
  );

  React.useLayoutEffect(() => {
    const width = isMobile ? 0 : isCollapsed ? 58 : 236;
    document.documentElement.style.setProperty('--app-sider-width', `${width}px`);
  }, [isMobile, isCollapsed]);

  return (
    <Layout
      className="app-shell"
      style={{ '--sider-width': isMobile ? '0px' : isCollapsed ? '58px' : '236px' } as React.CSSProperties}
    >
      {!isMobile && (
        <Sider
          width={236}
          collapsedWidth={58}
          collapsible
          collapsed={isCollapsed}
          trigger={null}
          className="app-sider"
          theme="dark"
        >
          {isCollapsed ? (
            <div
              className="app-brand app-brand-collapsed"
              onClick={() => setIsCollapsed(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setIsCollapsed(false);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="Expand Sider"
            >
              <div className="app-brand-mark">OM</div>
            </div>
          ) : brand}
          <div className="app-sider-scroll">{menu}</div>
          {isCollapsed ? (
            <Tooltip
              title={`${t('shell.cpa')} · ${health ? (health.cpa_connected ? t('shell.connected') : t('shell.offline')) : '—'}`}
              placement="right"
            >
              <div className="app-sider-foot is-collapsed">
                <span className={`legend-dot ${health ? (health.cpa_connected ? 'success' : 'danger') : 'neutral'}`} />
              </div>
            </Tooltip>
          ) : (
          <div className="app-sider-foot">
            <div className="app-sider-foot-row">
              <span>{t('shell.cpa')}</span>
              <span className="terminal-mono">{health ? (health.cpa_connected ? t('shell.connected') : t('shell.offline')) : '—'}</span>
            </div>
            {health?.version && (
              <div className="app-sider-foot-row">
                <span>{t('shell.version')}</span>
                <span className="terminal-mono">{health.version}</span>
              </div>
            )}
          </div>
          )}
        </Sider>
      )}
      <Layout className="app-body">
        <header className="app-header">
          <div className="app-header-left">
            {isMobile ? (
              <Button type="text" icon={<MenuUnfoldOutlined />} onClick={() => setIsMobileNavOpen(true)} aria-label={t('header.open_nav')} />
            ) : (
              <Tooltip title={isCollapsed ? t('header.expand_sidebar') : t('header.collapse_sidebar')}>
                <Button type="text" icon={isCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setIsCollapsed(!isCollapsed)} aria-label={t('header.collapse_sidebar')} />
              </Tooltip>
            )}
            <Breadcrumb
              className="app-breadcrumb"
              items={[
                { title: currentGroup ? t(currentGroup.labelKey) : '' },
                { title: <span className="app-breadcrumb-current">{currentEntry ? t(currentEntry.labelKey) : t('common.management')}</span> },
              ]}
            />
          </div>
          <HeaderNav
            health={health}
            isDiscovering={false}
            onDiscover={() => { void queryClient.invalidateQueries(); message.success(t('common.refresh')); }}
            onLogout={() => logoutMutation.mutate()}
            isLoggingOut={logoutMutation.isPending}
            themeMode={themeMode}
            onToggleTheme={toggleTheme}
            isMobile={isMobile}
          />
        </header>
        <Content className="app-content" ref={contentRef}>
          {/* App-wide in-flight indicator, so no page needs its own spinner swap. */}
          <DataProgress />
          {/* Keyed by pathname so each view cross-fades in instead of hard
              swapping, and the scroll position resets with the new page. */}
          <div key={location.pathname} className="route-transition">
            <React.Suspense fallback={<div style={{ padding: 60, textAlign: 'center' }}><Spin size="large" /></div>}>
              <Outlet />
            </React.Suspense>
          </div>
        </Content>
      </Layout>
      {isMobile && (
        <Drawer
          placement="left"
          open={isMobileNavOpen}
          onClose={() => setIsMobileNavOpen(false)}
          width={280}
          closable={false}
          className="mobile-nav-drawer"
          styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
        >
          {brand}
          <div className="app-sider-scroll">{menu}</div>
        </Drawer>
      )}
    </Layout>
  );
};




