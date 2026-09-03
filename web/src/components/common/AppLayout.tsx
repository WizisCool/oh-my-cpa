import React from 'react';
import { App as AntdApp, Layout, Menu, Drawer, Tooltip, Button, Breadcrumb } from 'antd';
import {
  ApiOutlined,
  CloudServerOutlined,
  ControlOutlined,
  DashboardOutlined,
  FieldTimeOutlined,
  FileProtectOutlined,
  FileSearchOutlined,
  InfoCircleOutlined,
  LoginOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NodeIndexOutlined,
  PartitionOutlined,
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

// Groups mirror the prototype: 运行 / 网关 / 观测 / 控制 (+ Oh My CPA layer).
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
      { key: '/auth-files', labelKey: 'nav.auth_files', icon: <FileProtectOutlined /> },
      { key: '/oauth', labelKey: 'nav.oauth', icon: <LoginOutlined /> },
      { key: '/quota', labelKey: 'nav.quota', icon: <FieldTimeOutlined /> },
    ],
  },
  {
    key: 'observe',
    labelKey: 'nav.group.observe',
    items: [
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
  {
    key: 'ohmycpa',
    labelKey: 'nav.group.ohmycpa',
    items: [
      { key: '/resources/triage', labelKey: 'nav.triage', icon: <FileSearchOutlined /> },
      { key: '/resources/all', labelKey: 'nav.all_resources', icon: <PartitionOutlined /> },
      { key: '/instances', labelKey: 'nav.instances', icon: <NodeIndexOutlined /> },
    ],
  },
];

const navEntries: NavEntry[] = navGroups.flatMap((group) => group.items);

function buildMenuItems(t: TFunc, collapsed: boolean, unclaimedCount: number): NavItem[] {
  if (collapsed) {
    return navEntries.map((entry) => ({ key: entry.key, icon: entry.icon, label: t(entry.labelKey), title: t(entry.labelKey) }));
  }
  return navGroups.map((group) => ({
    key: `group:${group.key}`,
    type: 'group' as const,
    label: t(group.labelKey),
    children: group.items.map((entry): NavItem => ({
      key: entry.key,
      icon: entry.icon,
      label: entry.key === '/resources/triage' && unclaimedCount > 0 ? (
        <span className="nav-label-with-count">
          <span>{t(entry.labelKey)}</span>
          <span className="nav-count">{unclaimedCount > 99 ? '99+' : unclaimedCount}</span>
        </span>
      ) : t(entry.labelKey),
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
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobile, setMobile] = React.useState(isNarrowViewport);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  React.useEffect(() => {
    const onResize = () => {
      const narrow = isNarrowViewport();
      setMobile(narrow);
      if (!narrow) setMobileNavOpen(false);
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

  const { data: unclaimedData } = useQuery({
    queryKey: ['resources', 'unclaimed'],
    queryFn: () => api.getResources({ status: 'unclaimed' }),
    staleTime: 10000,
  });

  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: () => window.location.reload(),
    onError: (err: Error) => message.error(t('shell.logout_failed', { msg: err.message })),
  });

  const discoverMutation = useMutation({
    mutationFn: api.discoverDefaultInstance,
    onSuccess: (result) => {
      message.success(t('shell.discover_done', { n: result.discovered_count }));
      queryClient.invalidateQueries({ queryKey: ['resources'] });
      queryClient.invalidateQueries({ queryKey: ['management-overview'] });
    },
    onError: (err: Error) => message.error(t('shell.discover_failed', { msg: err.message })),
  });

  const selectedKey = navEntries
    .map((entry) => entry.key)
    .filter((key) => location.pathname === key || location.pathname.startsWith(`${key}/`))
    .sort((a, b) => b.length - a.length)[0] ?? '/dashboard';
  const currentEntry = navEntries.find((entry) => entry.key === selectedKey);
  const currentGroup = navGroups.find((group) => group.items.some((entry) => entry.key === selectedKey));
  const menuItems = React.useMemo(
    () => buildMenuItems(t, collapsed, unclaimedData?.total ?? 0),
    [t, collapsed, unclaimedData?.total]
  );

  const selectPage = ({ key }: { key: string }) => {
    navigate(key);
    setMobileNavOpen(false);
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
    const width = mobile ? 0 : collapsed ? 58 : 236;
    document.documentElement.style.setProperty('--app-sider-width', `${width}px`);
  }, [mobile, collapsed]);

  return (
    <Layout
      className="app-shell"
      style={{ '--sider-width': mobile ? '0px' : collapsed ? '58px' : '236px' } as React.CSSProperties}
    >
      {!mobile && (
        <Sider
          width={236}
          collapsedWidth={58}
          collapsible
          collapsed={collapsed}
          trigger={null}
          className="app-sider"
          theme="dark"
        >
          {collapsed ? (
            <div
              className="app-brand app-brand-collapsed"
              onClick={() => setCollapsed(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setCollapsed(false);
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
          {collapsed ? (
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
            {mobile ? (
              <Button type="text" icon={<MenuUnfoldOutlined />} onClick={() => setMobileNavOpen(true)} aria-label={t('header.open_nav')} />
            ) : (
              <Tooltip title={collapsed ? t('header.expand_sidebar') : t('header.collapse_sidebar')}>
                <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} aria-label={t('header.collapse_sidebar')} />
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
            isDiscovering={discoverMutation.isPending}
            onDiscover={() => discoverMutation.mutate()}
            onLogout={() => logoutMutation.mutate()}
            isLoggingOut={logoutMutation.isPending}
            themeMode={themeMode}
            onToggleTheme={toggleTheme}
            mobile={mobile}
          />
        </header>
        <Content className="app-content" ref={contentRef}>
          {/* App-wide in-flight indicator, so no page needs its own spinner swap. */}
          <DataProgress />
          {/* Keyed by pathname so each view cross-fades in instead of hard
              swapping, and the scroll position resets with the new page. */}
          <div key={location.pathname} className="route-transition">
            <Outlet context={{ triggerDiscovery: () => discoverMutation.mutate(), isDiscovering: discoverMutation.isPending }} />
          </div>
        </Content>
      </Layout>
      {mobile && (
        <Drawer
          placement="left"
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
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
