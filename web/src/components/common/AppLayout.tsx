import React from 'react';
import { clsx } from 'clsx';
import { Sheet, SheetBody, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '../icons';
import { Outlet, useLocation, useMatches, useNavigate } from 'react-router-dom';
import { HeaderNav } from './HeaderNav';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { DataProgress } from './DataProgress';
import { PageSkeleton, SuspenseFallback, type RouteLoadingHandle } from './PageLoading';
import { DashboardSkeleton } from '../dashboard/DashboardSkeleton';
import { CpaUpgradeRequired } from './CpaUpgradeRequired';
import { CpaManagementDisabled } from './CpaManagementDisabled';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { BrandArtwork } from './BrandArtwork';
import { OverlayScrollArea } from './OverlayScrollArea';
import { useT } from '../../i18n';
import { PricingEditorProvider } from '../pricing/PricingEditorContext';
import { useToast } from '../feedback';
import { consoleRouteRegistry, warmRouteIntent } from '../../routePreload';
import { useTransitionNavigate } from '../../performance/routeContract';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { collectPluginPages, PLUGIN_PAGE_ROUTE_PREFIX } from '../plugins/pluginPages';
import { clearMirroredCPAMCCredential } from '../plugins/pluginHostCredential';
import { buildNavGroups } from './navigation';
import { navEntryLabel, type NavEntry } from '../../types/sidebarNav';
import { usePreference } from '../../hooks/usePreference';
import { useNavLayout } from '../../hooks/useNavLayout';
import { usePendingUpdates } from '../../hooks/useUpdateNotice';
import { Tooltip } from './Tooltip';
import { NavSelectionHighlight } from './NavSelectionHighlight';

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

/** The frame the matched route declared for its module download (`loadingAs` in `App.tsx`). */
function RouteLoading() {
  const matches = useMatches();
  const loading = (matches.at(-1)?.handle as RouteLoadingHandle | undefined)?.loading ?? 'list';
  return (
    <SuspenseFallback>
      {loading === 'dashboard' ? <DashboardSkeleton /> : <PageSkeleton body={loading} />}
    </SuspenseFallback>
  );
}

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

function parseSidebarCollapsed(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

export const AppLayout: React.FC = () => {
  const t = useT();
  const toast = useToast();
  const rawNavigate = useNavigate();
  const { navigateTo, isPending: isNavigationPending } = useTransitionNavigate(rawNavigate, consoleRouteRegistry);
  const location = useLocation();
  const queryClient = useQueryClient();
  const timeZone = useTimeZone();
  const sidebarPreference = usePreference('omc_sidebar_collapsed', false, parseSidebarCollapsed);
  const isCollapsed = sidebarPreference.value;
  const setIsCollapsed = (next: boolean) => {
    // A toggle derived from the fallback must not overwrite a stored choice still being read.
    if (sidebarPreference.loaded) void sidebarPreference.set(next);
  };
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
    onSuccess: () => {
      clearMirroredCPAMCCredential();
      window.location.reload();
    },
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
  // The rail draws the entries the operator has not hidden, in the order they arranged them.
  // Everything else on this shell reads the full model, so a page reached by a URL - or by a link
  // into it - still names itself in the breadcrumb, the document title and the group it belongs to.
  const { visibleGroups: visibleNavGroups } = useNavLayout(navGroups);

  const currentEntry = navEntries
    .filter((entry) => location.pathname === entry.key || location.pathname.startsWith(`${entry.key}/`))
    .sort((a, b) => b.key.length - a.key.length)[0];
  const selectedKey = currentEntry?.key ?? '/dashboard';
  const currentGroup = navGroups.find((group) => group.items.some((entry) => entry.key === selectedKey));
  const currentLabel = currentEntry ? navEntryLabel(currentEntry, t) : t('common.management');
  useDocumentTitle(currentLabel);
  const { products: pendingProducts, hasPluginUpdate } = usePendingUpdates();
  const hasSystemUpdate = pendingProducts.length > 0;
  const isCollapsedRail = !isMobile && isCollapsed;
  const pendingUpdateRoutes = React.useMemo(() => {
    const routes = new Set<string>();
    if (hasSystemUpdate) routes.add('/system');
    if (hasPluginUpdate) routes.add('/plugins');
    return routes;
  }, [hasSystemUpdate, hasPluginUpdate]);

  // A page change runs as a transition, so `location` - and the selection derived from it - waits
  // for the target page to load. The rail answers the click at once instead: it marks the entry the
  // hand chose until the transition settles, whether it committed or was overtaken.
  const [intendedKey, setIntendedKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!isNavigationPending) setIntendedKey(null);
  }, [isNavigationPending, location.pathname, location.search]);
  const menuSelectedKey = intendedKey ?? selectedKey;

  const navigateToKey = (key: string) => {
    setIsMobileNavOpen(false);
    const currentAddress = `${location.pathname}${location.search}`;
    if (key !== currentAddress || intendedKey !== null) {
      setIntendedKey(key === currentAddress ? null : key);
      navigateTo(key);
    }
  };

  const goToDashboard = () => navigateToKey('/dashboard');

  React.useEffect(() => {
    return consoleRouteRegistry.scheduleIdlePrewarm(location.pathname);
  }, [location.pathname]);

  const preloadMenuTarget = (event: React.SyntheticEvent) => {
    const target = event.target;
    const path = target instanceof Element ? target.closest('[data-route-path]')?.getAttribute('data-route-path') : null;
    if (path) warmRouteIntent(path, { queryClient, pathname: path, timeZone });
  };

  const selectedGroupKey = visibleNavGroups.find((group) => group.items.some((entry) => entry.key === menuSelectedKey))?.key ?? null;
  const navLayoutKey = [
    isCollapsedRail ? 'collapsed' : 'expanded',
    ...visibleNavGroups.map((group) => `${group.key}:${group.items.map((entry) => entry.key).join(',')}`),
  ].join('|');

  const renderNavItem = (entry: NavEntry) => {
    const isSelected = entry.key === menuSelectedKey;
    const isFlagged = pendingUpdateRoutes.has(entry.key);
    const label = navEntryLabel(entry, t);
    const accessibleLabel = isFlagged ? `${label} (${t('nav.update_available')})` : label;
    const button = (
      <button
        key={entry.key}
        type="button"
        data-route-path={entry.key}
        data-selected={isSelected ? '' : undefined}
        aria-current={isSelected ? 'page' : undefined}
        aria-label={isCollapsedRail ? accessibleLabel : undefined}
        className={clsx('app-menu-item', isSelected && 'app-menu-item-selected')}
        onClick={() => navigateToKey(entry.key)}
      >
        <span className="app-menu-item-icon" aria-hidden="true">
          {isFlagged ? flagIcon(entry.icon) : entry.icon}
        </span>
        {!isCollapsedRail && (
          <span className="app-menu-item-label" data-tip={label} data-tip-overflow="">
            {label}
            {isFlagged && <span className="sr-only"> ({t('nav.update_available')})</span>}
          </span>
        )}
      </button>
    );
    if (!isCollapsedRail) return button;
    return (
      <Tooltip key={entry.key} placement="right" title={accessibleLabel}>
        {button}
      </Tooltip>
    );
  };

  const menu = (
    <NavSelectionHighlight selectedKey={menuSelectedKey} groupKey={selectedGroupKey} layoutKey={navLayoutKey}>
      <nav
        aria-label={t('header.nav_sheet')}
        className="app-menu"
        onMouseOver={preloadMenuTarget}
        onFocus={preloadMenuTarget}
        onTouchStart={preloadMenuTarget}
      >
        {isCollapsedRail
          ? visibleNavGroups.flatMap((group) => group.items).map(renderNavItem)
          : visibleNavGroups.map((group) => (
              <div key={group.key} className="app-menu-group" role="group" aria-labelledby={`nav-group-${group.key}`}>
                <div id={`nav-group-${group.key}`} className="app-menu-group-title">
                  {t(group.labelKey)}
                </div>
                <div className="app-menu-group-list">
                  {group.items.map(renderNavItem)}
                </div>
              </div>
            ))}
      </nav>
    </NavSelectionHighlight>
  );

  const brand = (
    <button
      type="button"
      className="app-brand"
      onClick={goToDashboard}
      aria-label="Dashboard"
    >
      {/* The wordmark spells the product name, so the text that used to sit beside the
          mark is gone: it would say the same thing twice. 20px keeps its cap height in
          step with the navigation text rather than dominating it. */}
      <BrandArtwork shape="wordmark" height={20} className="app-brand-logo" />
    </button>
  );

  React.useLayoutEffect(() => {
    const width = isMobile ? 0 : isCollapsed ? 58 : 236;
    document.documentElement.style.setProperty('--app-sider-width', `${width}px`);
  }, [isMobile, isCollapsed]);

  const isCpaUnsupported = health?.cpa_management_api === 'unsupported';
  const isCpaManagementDisabled = health?.cpa_management_api === 'disabled';
  return (
    <div
      className="app-shell"
      style={{ '--sider-width': isMobile ? '0px' : isCollapsed ? '58px' : '236px' } as React.CSSProperties}
    >
      {!isMobile && (
        <aside className={clsx('app-sider', isCollapsed && 'app-sider-collapsed')}>
          {isCollapsed ? (
            <button
              type="button"
              className="app-brand app-brand-collapsed"
              onClick={() => setIsCollapsed(false)}
              aria-label="Expand Sider"
            >
              {/* 58px cannot hold the wordmark at a legible size, so the collapsed rail
                  shows the square mark. */}
              <BrandArtwork shape="mark" height={20} />
            </button>
          ) : brand}
          <OverlayScrollArea className="app-sider-scroll" viewportClassName="app-sider-viewport">{menu}</OverlayScrollArea>
        </aside>
      )}
      <div className="app-body">
        <header className="app-header">
          <div className="app-header-left">
            {isMobile ? (
              <Button variant="ghost" icon={<MenuUnfoldOutlined />} onClick={() => setIsMobileNavOpen(true)} aria-label={t('header.open_nav')} />
            ) : (
              <Tooltip title={isCollapsed ? t('header.expand_sidebar') : t('header.collapse_sidebar')}>
                <Button variant="ghost" icon={isCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setIsCollapsed(!isCollapsed)} disabled={!sidebarPreference.loaded} aria-label={t(isCollapsed ? 'header.expand_sidebar' : 'header.collapse_sidebar')} />
              </Tooltip>
            )}
            <nav aria-label="Breadcrumb" className="app-breadcrumb">
              <ol className="app-breadcrumb-list">
                {currentGroup && (
                  <>
                    <li className="app-breadcrumb-group">{t(currentGroup.labelKey)}</li>
                    <li className="app-breadcrumb-sep" aria-hidden="true">/</li>
                  </>
                )}
                <li className="app-breadcrumb-item" aria-current="page">
                  <span className="app-breadcrumb-current" data-tip={currentLabel} data-tip-overflow="">{currentLabel}</span>
                </li>
              </ol>
            </nav>
          </div>
          <HeaderNav
            isDiscovering={false}
            onDiscover={() => { void queryClient.invalidateQueries(); toast.success(t('common.refresh')); }}
            onLogout={() => logoutMutation.mutate()}
            isLoggingOut={logoutMutation.isPending}
          />
        </header>
        <main
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
        </main>
      </div>
      {isMobile && (
        /* The sheet carries the same parts as the rail - brand and nav - because it is the
           rail at a phone width, not a menu of links. The width is bounded in both `px` and
           `vw`: at a 320px viewport a fixed 320px sheet leaves no page visible behind the mask,
           and the reader loses the sense that this is a layer over where they were. The
           safe-area inset keeps the rail's labels clear of a landscape notch. */
        <Sheet
          open={isMobileNavOpen}
          onOpenChange={(next) => {
            if (!next) setIsMobileNavOpen(false);
          }}
        >
          <SheetContent
            side="left"
            surface="ground"
            aria-label={t('header.nav_sheet')}
            style={{ width: 'min(320px, 86vw)' }}
            className="mobile-nav-drawer"
          >
            <SheetBody className="flex flex-col p-0">
              {brand}
              <OverlayScrollArea className="app-sider-scroll" viewportClassName="app-sider-viewport">{menu}</OverlayScrollArea>
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
};
