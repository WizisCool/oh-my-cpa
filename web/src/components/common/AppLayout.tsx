import React from 'react';
import { Layout, Menu, Drawer, Tooltip, Button, Breadcrumb } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '../icons';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { HeaderNav } from './HeaderNav';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { DataProgress } from './DataProgress';
import { RouteLoading } from './PageLoading';
import { CpaUpgradeRequired } from './CpaUpgradeRequired';
import { CpaManagementDisabled } from './CpaManagementDisabled';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { BrandArtwork } from './BrandArtwork';
import { OverlayScrollArea } from './OverlayScrollArea';
import { useT, type TFunc } from '../../i18n';
import { PricingEditorProvider } from '../pricing/PricingEditorContext';
import { useToast } from '../feedback';
import { preloadRoute } from '../../routePreload';
import { collectPluginPages, PLUGIN_PAGE_ROUTE_PREFIX } from '../plugins/pluginPages';
import { buildNavGroups } from './navigation';
import { navEntryLabel, retainVisibleGroups, type NavEntry, type NavGroup } from '../../types/sidebarNav';
import { useNavVisibility } from '../../hooks/useNavVisibility';
import { usePendingUpdates } from '../../hooks/useUpdateNotice';

const { Sider, Content } = Layout;

type NavItem = Required<MenuProps>['items'][number];

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

/** The page that answers "is there a newer version", and so the entry an available update marks. */
const UPDATE_NOTICE_ROUTE = '/system';

/**
 * The entry's icon with the update dot on its corner.
 *
 * The dot rides the icon rather than the label because the icon is the one part of an entry
 * all three renderings keep: the expanded rail, the collapsed rail and the phone sheet.
 */
function flagIcon(icon: React.ReactNode): React.ReactNode {
  return (
    <span className="app-menu-flagged-icon" data-testid="nav-update-dot">
      {icon}
      <span className="app-menu-update-dot" aria-hidden="true" />
    </span>
  );
}

function buildMenuItems(navGroups: readonly NavGroup[], t: TFunc, isCollapsed: boolean, hasPendingUpdate: boolean): NavItem[] {
  const isFlagged = (entry: NavEntry) => hasPendingUpdate && entry.key === UPDATE_NOTICE_ROUTE;
  const iconFor = (entry: NavEntry) => (isFlagged(entry) ? flagIcon(entry.icon) : entry.icon);
  if (isCollapsed) {
    return navGroups.flatMap((group) => group.items).map((entry) => {
      // The collapsed row's name is its `title`, so the notice is spoken from there.
      const title = isFlagged(entry) ? `${navEntryLabel(entry, t)} · ${t('nav.update_available')}` : navEntryLabel(entry, t);
      return { key: entry.key, icon: iconFor(entry), label: navEntryLabel(entry, t), title, 'data-route-path': entry.key };
    });
  }
  return navGroups.map((group) => ({
    key: `group:${group.key}`,
    type: 'group' as const,
    label: t(group.labelKey),
    children: group.items.map((entry): NavItem => ({
      key: entry.key,
      icon: iconFor(entry),
      label: isFlagged(entry)
        ? <>{navEntryLabel(entry, t)}<span className="sr-only"> · {t('nav.update_available')}</span></>
        : navEntryLabel(entry, t),
      title: entry.isLiteralLabel ? entry.labelKey : undefined,
      'data-route-path': entry.key,
    })),
  }));
}

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

export const AppLayout: React.FC = () => {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(isNarrowViewport);
  const [isMobileNavOpen, setIsMobileNavOpen] = React.useState(false);

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
  // The rail draws the entries the operator has not hidden. Everything else on this shell reads the
  // full model, so a page reached by a URL - or by a link into it - still names itself in the
  // breadcrumb, the document title and the group it belongs to.
  const { hiddenSet } = useNavVisibility();
  const visibleNavGroups = React.useMemo(() => retainVisibleGroups(navGroups, hiddenSet), [navGroups, hiddenSet]);

  const currentEntry = navEntries
    .filter((entry) => location.pathname === entry.key || location.pathname.startsWith(`${entry.key}/`))
    .sort((a, b) => b.key.length - a.key.length)[0];
  const selectedKey = currentEntry?.key ?? '/dashboard';
  const currentGroup = navGroups.find((group) => group.items.some((entry) => entry.key === selectedKey));
  const currentLabel = currentEntry ? navEntryLabel(currentEntry, t) : t('common.management');
  useDocumentTitle(currentLabel);
  const hasPendingUpdate = usePendingUpdates().length > 0;
  const menuItems = React.useMemo(() => buildMenuItems(visibleNavGroups, t, isCollapsed, hasPendingUpdate), [visibleNavGroups, t, isCollapsed, hasPendingUpdate]);

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
                  shows the square mark. */}
              <BrandArtwork shape="mark" height={20} />
            </div>
          ) : brand}
          <OverlayScrollArea className="app-sider-scroll" viewportClassName="app-sider-viewport">{menu}</OverlayScrollArea>
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
      {isMobile && (
        /* The sheet carries the same parts as the rail - brand and nav - because it is the
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
          <OverlayScrollArea className="app-sider-scroll" viewportClassName="app-sider-viewport">{menu}</OverlayScrollArea>
        </Drawer>
      )}
    </Layout>
  );
};




