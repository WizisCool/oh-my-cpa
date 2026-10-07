import React from 'react';
import { Layout, Menu, Drawer, Tooltip, Button, Breadcrumb } from 'antd';
import {
  PuzzleOutlined,
  ShopOutlined,
  AuditOutlined,
  CloudServerOutlined,
  CodeSandboxOutlined,
  ControlOutlined,
  DashboardOutlined,
  DollarOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LoginOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProfileOutlined,
  RobotOutlined,
  SettingOutlined,
  BlockOutlined,
} from '../icons';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { HeaderNav } from './HeaderNav';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { DataProgress } from './DataProgress';
import { RouteLoading } from './PageLoading';
import { AssistantDockFrame } from '../assistant/AssistantDockFrame';
import { CpaUpgradeRequired } from './CpaUpgradeRequired';
import { CpaManagementDisabled } from './CpaManagementDisabled';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { BrandArtwork } from './BrandArtwork';
import { useT, type TFunc } from '../../i18n';
import { PricingEditorProvider } from '../pricing/PricingEditorContext';
import { useToast } from '../feedback';
import { preloadRoute } from '../../routePreload';
import { collectPluginPages, PLUGIN_PAGE_ROUTE_PREFIX, type PluginPageEntry } from '../plugins/pluginPages';
import { isRenderableLogoURL } from '../../types/pluginOAuthProviders';

const { Sider, Content } = Layout;

type NavItem = Required<MenuProps>['items'][number];

interface NavEntry {
  key: string;
  /** A translation key, or for a plugin's own page the label the plugin registered. */
  labelKey: string;
  isLiteralLabel?: boolean;
  icon: React.ReactNode;
}

interface NavGroup {
  key: string;
  labelKey: string;
  items: NavEntry[];
}

// Groups mirror the navigation model: Operate / Gateway / Observe / Control,
// plus the Oh My CPA layer.
/**
 * Routes that own their scroll columns rather than scrolling the content area.
 *
 * A conversation workspace pins its composer to the bottom of the viewport and scrolls the
 * transcript and the side panel independently, which only works when the route fills the
 * content area's height instead of growing it.
 */
const WORKSPACE_ROUTES = new Set(['/playground', '/agent']);

/** A plugin page is a frame that fills the content area and scrolls inside itself. */
function isWorkspaceRoute(pathname: string): boolean {
  return WORKSPACE_ROUTES.has(pathname) || pathname.startsWith(`${PLUGIN_PAGE_ROUTE_PREFIX}/`);
}

/**
 * The key a route's view is mounted under. Plugin management's tabs are addresses of one
 * page, so moving between them must not remount it: the store listing it has read and the
 * settings drawer it has open belong to the page, not to the tab.
 */
function routeViewKey(pathname: string): string {
  return pathname === '/plugins' || pathname.startsWith('/plugins/') ? '/plugins' : pathname;
}

const staticNavGroups: NavGroup[] = [
  {
    key: 'operate',
    labelKey: 'nav.group.operate',
    items: [
      { key: '/dashboard', labelKey: 'nav.dashboard', icon: <DashboardOutlined /> },
      { key: '/agent', labelKey: 'nav.agent', icon: <RobotOutlined /> },
      { key: '/playground', labelKey: 'nav.playground', icon: <CodeSandboxOutlined /> },
      { key: '/model-square', labelKey: 'nav.model_square', icon: <BlockOutlined /> },
    ],
  },
  {
    key: 'gateway',
    labelKey: 'nav.group.gateway',
    items: [
      // Upstream credentials first (provider keys, then OAuth accounts), then the keys
      // clients use to reach this gateway: the group reads in the direction a request
      // is authorised, rather than interleaving the two sides.
      { key: '/ai-providers', labelKey: 'nav.providers', icon: <CloudServerOutlined /> },
      // Authentication, credential management and quota are one credential-centred workspace.
      { key: '/oauth-management', labelKey: 'nav.auth_files', icon: <LoginOutlined /> },
      { key: '/api-keys', labelKey: 'nav.api_keys', icon: <KeyOutlined /> },
    ],
  },
  {
    key: 'observe',
    labelKey: 'nav.group.observe',
    items: [
      { key: '/usage/events', labelKey: 'nav.usage_events', icon: <HistoryOutlined /> },
      { key: '/pricing', labelKey: 'nav.pricing', icon: <DollarOutlined /> },
      { key: '/logs', labelKey: 'nav.logs', icon: <ProfileOutlined /> },
      { key: '/audit', labelKey: 'nav.audit', icon: <AuditOutlined /> },
    ],
  },
  {
    key: 'control',
    labelKey: 'nav.group.control',
    items: [
      { key: '/config', labelKey: 'nav.config', icon: <ControlOutlined /> },
      { key: '/omc-settings', labelKey: 'nav.omc_settings', icon: <SettingOutlined /> },
      { key: '/system', labelKey: 'nav.system', icon: <InfoCircleOutlined /> },
    ],
  },
];

/**
 * Plugins are a group of their own: what is installed, the store, and then every page a
 * running plugin registered. A plugin's page is a destination in its own right, so it sits
 * in the navigation beside the console's pages rather than behind the plugin's row.
 */
function buildNavGroups(pluginPages: readonly PluginPageEntry[]): NavGroup[] {
  const pluginGroup: NavGroup = {
    key: 'plugins',
    labelKey: 'nav.group.plugins',
    items: [
      { key: '/plugins', labelKey: 'nav.plugins', icon: <PuzzleOutlined /> },
      { key: '/plugins/store', labelKey: 'nav.plugin_store', icon: <ShopOutlined /> },
      ...pluginPages.map((page): NavEntry => ({
        key: page.route,
        labelKey: page.navLabel,
        isLiteralLabel: true,
        icon: isRenderableLogoURL(page.logo)
          ? <img className="app-menu-plugin-logo" src={page.logo} alt="" />
          : <PuzzleOutlined />,
      })),
    ],
  };
  const controlIndex = staticNavGroups.findIndex((group) => group.key === 'control');
  return [...staticNavGroups.slice(0, controlIndex), pluginGroup, ...staticNavGroups.slice(controlIndex)];
}

function navLabel(entry: NavEntry, t: TFunc): string {
  return entry.isLiteralLabel ? entry.labelKey : t(entry.labelKey);
}

function buildMenuItems(navGroups: readonly NavGroup[], t: TFunc, isCollapsed: boolean): NavItem[] {
  if (isCollapsed) {
    return navGroups.flatMap((group) => group.items).map((entry) => ({ key: entry.key, icon: entry.icon, label: navLabel(entry, t), title: navLabel(entry, t), 'data-route-path': entry.key }));
  }
  return navGroups.map((group) => ({
    key: `group:${group.key}`,
    type: 'group' as const,
    label: t(group.labelKey),
    children: group.items.map((entry): NavItem => ({
      key: entry.key,
      icon: entry.icon,
      label: navLabel(entry, t),
      title: entry.isLiteralLabel ? entry.labelKey : undefined,
      'data-route-path': entry.key,
    })),
  }));
}

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

const ASSISTANT_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘J' : 'Ctrl+J';

export const AppLayout: React.FC = () => {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(isNarrowViewport);
  const [isMobileNavOpen, setIsMobileNavOpen] = React.useState(false);

  // The assistant is the Agent beside another page, so on the Agent's own page there is nothing
  // to dock. Its open state outlives route changes: a run in progress keeps streaming into it.
  const [isAssistantOpen, setIsAssistantOpen] = React.useState(false);
  const hasAssistant = location.pathname !== '/agent';
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'j' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setIsAssistantOpen(isOpen => !isOpen);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // The sheet is an overlay like any other: Back puts it away rather than leaving the route,
  // which on a phone is what the hardware button is expected to do. Gated on `isMobile`
  // because the sheet only exists there, so a rotation that closes it must not leave a
  // sentinel behind.
  useOverlayHistory({ isOpen: isMobile && isMobileNavOpen, onClose: () => setIsMobileNavOpen(false) });

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
  const hasContentScroll = React.useRef(false);
  React.useEffect(() => {
    const node = contentRef.current;
    // Even a no-op scrollTo flushes pending layout on navigation. Scroll events already
    // tell us whether a reset is needed, without measuring the newly mounted page.
    if (node && hasContentScroll.current) node.scrollTo({ top: 0, behavior: 'auto' });
    hasContentScroll.current = false;
  }, [location.pathname]);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: api.getHealth,
    refetchInterval: 15000,
  });

  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: () => window.location.reload(),
    onError: (err: Error) => toast.error(t('shell.logout_failed', { msg: err.message })),
  });

  // The title names only a page the path really is; the menu still highlights the dashboard
  // for a path no entry owns, but the tab then reads as the console rather than as a page.
  // The navigation needs the plugin list on every route, to offer the pages plugins
  // registered; it is read once the gateway is known to answer management requests.
  const isCpaManageable = health !== undefined && health.cpa_management_api !== 'unsupported' && health.cpa_management_api !== 'disabled';
  const { data: pluginList } = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    enabled: isCpaManageable,
    staleTime: 60_000,
  });
  const navGroups = React.useMemo(() => buildNavGroups(collectPluginPages(pluginList?.plugins)), [pluginList]);
  const navEntries = React.useMemo(() => navGroups.flatMap((group) => group.items), [navGroups]);

  const currentEntry = navEntries
    .filter((entry) => location.pathname === entry.key || location.pathname.startsWith(`${entry.key}/`))
    .sort((a, b) => b.key.length - a.key.length)[0];
  const selectedKey = currentEntry?.key ?? '/dashboard';
  const currentGroup = navGroups.find((group) => group.items.some((entry) => entry.key === selectedKey));
  const currentLabel = currentEntry ? navLabel(currentEntry, t) : t('common.management');
  useDocumentTitle(currentLabel);
  const menuItems = React.useMemo(() => buildMenuItems(navGroups, t, isCollapsed), [navGroups, t, isCollapsed]);

  const selectPage = ({ key }: { key: string }) => {
    navigate(key);
    setIsMobileNavOpen(false);
  };

  const preloadMenuTarget = (event: React.SyntheticEvent) => {
    const target = event.target;
    const path = target instanceof Element ? target.closest('[data-route-path]')?.getAttribute('data-route-path') : null;
    if (path) preloadRoute(path);
  };

  const menu = (
    <Menu
      mode="inline"
      theme="dark"
      items={menuItems}
      selectedKeys={[selectedKey]}
      onClick={selectPage}
      onMouseOver={preloadMenuTarget}
      onFocus={preloadMenuTarget}
      onTouchStart={preloadMenuTarget}
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
      {/* The wordmark spells the product name, so the text that used to sit beside the
          mark is gone: it would say the same thing twice. 20px keeps its cap height in
          step with the navigation text rather than dominating it. */}
      <BrandArtwork shape="wordmark" height={20} className="app-brand-logo" />
    </div>
  );

  React.useLayoutEffect(() => {
    const width = isMobile ? 0 : isCollapsed ? 58 : 236;
    document.documentElement.style.setProperty('--app-sider-width', `${width}px`);
  }, [isMobile, isCollapsed]);

  const isCpaUnsupported = health?.cpa_management_api === 'unsupported';
  const isCpaManagementDisabled = health?.cpa_management_api === 'disabled';
  const cpaState = health
    ? (isCpaUnsupported ? t('shell.cpa_unsupported')
      : isCpaManagementDisabled ? t('shell.cpa_management_disabled')
        : health.cpa_connected ? t('shell.connected') : t('shell.offline'))
    : '—';

  /**
   * The rail's foot: live CPA connection and version.
   *
   * It is one component because both navigations show it. The sheet used to omit it, which meant
   * the surface a phone actually navigates from was the one surface that could not answer "is the
   * gateway up" - and that answer is the reason an operator opens this console at all.
   */
  const siderFoot = (
    <div className="app-sider-foot">
      <div className="app-sider-foot-row">
        <span>{t('shell.cpa')}</span>
        <span className="terminal-mono">{cpaState}</span>
      </div>
      {health?.version && (
        <div className="app-sider-foot-row">
          <span>{t('shell.version')}</span>
          <span className="terminal-mono">{health.version}</span>
        </div>
      )}
    </div>
  );

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
              {/* 58px cannot hold the wordmark at a legible size, so the collapsed rail
                  shows the same artwork's leading O. */}
              <BrandArtwork shape="o" height={20} />
            </div>
          ) : brand}
          <div className="app-sider-scroll">{menu}</div>
          {isCollapsed ? (
            <Tooltip
              title={`${t('shell.cpa')} · ${cpaState}`}
              placement="right"
            >
              <div className="app-sider-foot is-collapsed">
                <span className={`legend-dot ${health ? (isCpaUnsupported || isCpaManagementDisabled ? 'warning' : health.cpa_connected ? 'success' : 'danger') : 'neutral'}`} />
              </div>
            </Tooltip>
          ) : (
            siderFoot
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
                { title: <span className="app-breadcrumb-current">{currentLabel}</span> },
              ]}
            />
          </div>
          <HeaderNav
            leading={hasAssistant && (
              <Tooltip title={`${t('assistant.title')} (${ASSISTANT_SHORTCUT})`}>
                <Button
                  type="text"
                  icon={<RobotOutlined />}
                  aria-label={t('assistant.title')}
                  aria-pressed={isAssistantOpen}
                  aria-keyshortcuts="Control+J Meta+J"
                  data-testid="assistant-toggle"
                  onClick={() => setIsAssistantOpen(isOpen => !isOpen)}
                />
              </Tooltip>
            )}
            isDiscovering={false}
            onDiscover={() => { void queryClient.invalidateQueries(); toast.success(t('common.refresh')); }}
            onLogout={() => logoutMutation.mutate()}
            isLoggingOut={logoutMutation.isPending}
          />
        </header>
        <Content
          className="app-content"
          ref={contentRef}
          data-scroll-root
          onScroll={(event) => {
            if (event.target === event.currentTarget) hasContentScroll.current = event.currentTarget.scrollTop !== 0;
          }}
        >
          {/* App-wide in-flight indicator, so no page needs its own spinner swap. */}
          <DataProgress />
          {/* Keyed by pathname so each view cross-fades in instead of hard
              swapping, and the scroll position resets with the new page. */}
          <div key={routeViewKey(location.pathname)} className={`route-transition${isWorkspaceRoute(location.pathname) ? ' workspace-route' : ''}`}>
            <React.Suspense fallback={<RouteLoading />}>
              {isCpaUnsupported ? (
                <CpaUpgradeRequired />
              ) : isCpaManagementDisabled ? (
                <CpaManagementDisabled />
              ) : (
                <PricingEditorProvider>
                  <Outlet />
                </PricingEditorProvider>
              )}
            </React.Suspense>
          </div>
        </Content>
      </Layout>
      {hasAssistant && <AssistantDockFrame isOpen={isAssistantOpen} onClose={() => setIsAssistantOpen(false)} />}
      {isMobile && (
        /* The sheet carries the same three parts as the rail - brand, nav, foot - because it is the
           rail at a phone width, not a menu of links. Its width is bounded in `vw` as well as `px:`
           at a 320px viewport a fixed 320px sheet leaves no page visible behind the mask, and the
           reader loses the sense that this is a layer over where they were. The safe-area inset
           keeps the rail's labels clear of a landscape notch. */
        <Drawer
          placement="left"
          open={isMobileNavOpen}
          onClose={() => setIsMobileNavOpen(false)}
          size="min(320px, 86vw)"
          closable={false}
          className="mobile-nav-drawer"
          styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
        >
          {brand}
          <div className="app-sider-scroll">{menu}</div>
          {siderFoot}
        </Drawer>
      )}
    </Layout>
  );
};




