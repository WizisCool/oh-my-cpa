import React from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useProgressTask } from '../../hooks/useProgressTask';
import { progressTasks } from '../../utils/progressTasks';
import { isDemoMode } from '../../types/demoMode';
import {
  NAV_HIDDEN_PREFERENCE,
  NAV_ORDER_PREFERENCE,
  buildNavGroupSpecs,
  parseHiddenNavKeys,
  parseNavOrder,
  type NavGroupSpec,
} from '../../types/sidebarNav';
import { consoleRouteRegistry, currentConsolePathname } from '../../routePreload';
import { RightOutlined } from '../icons';
import { BrandArtwork } from './BrandArtwork';
import { AuthorizeCardSkeleton, RouteSkeleton } from './PageLoading';
import { Placeholder } from './Placeholder';
import { ProgressBar } from './ProgressBar';

function readCachedNavLayout(
  queryClient: React.ContextType<typeof QueryClientContext>,
): readonly NavGroupSpec[] {
  const baseGroups = buildNavGroupSpecs();
  const prefs = queryClient?.getQueryData<Record<string, unknown>>(['preferences']);
  if (!prefs) return baseGroups;
  const hidden = new Set(parseHiddenNavKeys(prefs[NAV_HIDDEN_PREFERENCE]) ?? []);
  const order = parseNavOrder(prefs[NAV_ORDER_PREFERENCE]) ?? {};
  const projected: NavGroupSpec[] = [];
  for (const group of baseGroups) {
    const visibleItems = hidden.size > 0
      ? group.items.filter((item) => !hidden.has(item.key))
      : [...group.items];
    if (visibleItems.length === 0) continue;
    const stored = order[group.key];
    if (stored && stored.length > 0) {
      const rank = new Map(stored.map((key, idx) => [key, idx]));
      visibleItems.sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
    }
    projected.push({ ...group, items: visibleItems });
  }
  return projected;
}

function resolveSelectedNavItem(
  groups: readonly NavGroupSpec[],
  pathname: string,
): { groupKey: string; itemKey: string } {
  const entries = groups.flatMap((group) =>
    group.items.map((item) => ({ groupKey: group.key, itemKey: item.key })),
  );
  const match = entries
    .filter((entry) => pathname === entry.itemKey || pathname.startsWith(`${entry.itemKey}/`))
    .sort((a, b) => b.itemKey.length - a.itemKey.length)[0];
  return match ?? { groupKey: 'operate', itemKey: '/dashboard' };
}

function readCachedCollapsedState(queryClient: React.ContextType<typeof QueryClientContext>): boolean {
  const stored = queryClient?.getQueryData<Record<string, unknown>>(['preferences'])?.omc_sidebar_collapsed;
  if (typeof stored === 'boolean') return stored;
  if (typeof document !== 'undefined') {
    return document.documentElement.style.getPropertyValue('--app-sider-width') === '58px';
  }
  return false;
}

/**
 * The authenticated shell's stand-in: the canvas rail, the inset rounded panel, the borderless
 * header and the active route's body geometry, drawn 1:1 with `AppLayout` while stored preferences
 * are read and the shell module downloads.
 */
export const ShellLoading: React.FC = () => {
  const t = useT();
  useProgressTask();
  const queryClient = React.useContext(QueryClientContext);
  const pathname = currentConsolePathname();

  // Standalone authorization pages mount outside the console shell.
  if (pathname.startsWith('/authorize/')) {
    return (
      <div className="auth-shell">
        <ProgressBar source={progressTasks} label={t('common.loading')} className="auth-progress" />
        <header className="auth-header">
          <BrandArtwork shape="wordmark" height={22} className="app-brand-logo" />
          <span className="auth-header-menus" aria-hidden="true">
            <span className="shell-loading-icon-slot">
              <Placeholder width={16} height={16} />
            </span>
            <span className="shell-loading-lang-slot">
              <Placeholder width={16} height={16} className="is-circle" />
              <Placeholder width={20} height={10} />
            </span>
          </span>
        </header>
        <main className="auth-main">
          <AuthorizeCardSkeleton isFullCard isImmediate />
        </main>
      </div>
    );
  }

  const isCollapsed = readCachedCollapsedState(queryClient);
  const isDemo = isDemoMode();
  const navGroups = readCachedNavLayout(queryClient);
  const { itemKey: selectedKey } = resolveSelectedNavItem(navGroups, pathname);
  const loadingBody = consoleRouteRegistry.resolve(pathname)?.loadingBody ?? 'list';
  let rowIndex = 0;

  return (
    <div
      className="app-shell shell-loading"
      style={{ '--sider-width': isCollapsed ? '58px' : '236px' } as React.CSSProperties}
    >
      <aside
        className={clsx('app-sider shell-loading-sider', isCollapsed && 'app-sider-collapsed')}
        aria-hidden="true"
      >
        {isCollapsed ? (
          <div className="app-brand app-brand-collapsed">
            <BrandArtwork shape="mark" height={20} />
          </div>
        ) : (
          <div className="app-brand">
            <BrandArtwork shape="wordmark" height={20} className="app-brand-logo" />
          </div>
        )}
        <div className="app-sider-scroll">
          <div className="app-sider-viewport">
            <div className="app-menu">
              {isCollapsed
                ? navGroups.flatMap((group) => group.items).map((item) => {
                    const row = rowIndex++;
                    const isSelected = item.key === selectedKey;
                    return (
                      <span
                        key={item.key}
                        className={clsx('shell-loading-nav-item', isSelected && 'is-selected')}
                      >
                        <Placeholder width={16} height={16} row={row} />
                      </span>
                    );
                  })
                : navGroups.map((group, groupIndex) => (
                    <div key={group.key} className="app-menu-group">
                      <div className="app-menu-group-title">
                        <span className="shell-loading-nav-group-label">
                          <Placeholder width={28} row={groupIndex} className="placeholder-line is-meta" />
                        </span>
                      </div>
                      <div className="app-menu-group-list">
                        {group.items.map((item) => {
                          const row = rowIndex++;
                          const isSelected = item.key === selectedKey;
                          const labelWidth = item.skeletonWidth ?? (48 + ((row * 7) % 18));
                          return (
                            <span
                              key={item.key}
                              className={clsx('shell-loading-nav-item', isSelected && 'is-selected')}
                            >
                              <Placeholder width={16} height={16} row={row} />
                              <Placeholder width={`${labelWidth}%`} row={row} className="placeholder-line" />
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
            </div>
          </div>
        </div>
      </aside>
      <div className="app-body shell-loading-main">
        <header className="app-header shell-loading-header">
          <div className="app-header-left">
            <span className="shell-loading-icon-slot" aria-hidden="true">
              <Placeholder width={16} height={16} />
            </span>
            <div className="app-breadcrumb" aria-hidden="true">
              <ol className="app-breadcrumb-list">
                <li className="app-breadcrumb-group">
                  <Placeholder width={30} className="placeholder-line is-meta" />
                </li>
                <li className="app-breadcrumb-sep" aria-hidden="true">
                  <RightOutlined />
                </li>
                <li className="app-breadcrumb-item">
                  <Placeholder width={64} className="placeholder-line" />
                </li>
              </ol>
            </div>
          </div>
          <div className="app-header-actions" aria-hidden="true">
            {isDemo && (
              <span className="shell-loading-desktop-only">
                <Placeholder width={48} height={18} />
              </span>
            )}
            <span className="shell-loading-icon-slot shell-loading-desktop-only">
              <Placeholder width={16} height={16} className="is-circle" />
            </span>
            <span className="app-header-divider shell-loading-desktop-only" />
            <span className="shell-loading-icon-slot shell-loading-desktop-only">
              <Placeholder width={16} height={16} />
            </span>
            <span className="shell-loading-icon-slot shell-loading-desktop-only">
              <Placeholder width={16} height={16} />
            </span>
            <span className="shell-loading-lang-slot shell-loading-desktop-only">
              <Placeholder width={16} height={16} className="is-circle" />
              <Placeholder width={18} height={10} />
            </span>
            {!isDemo && (
              <span className="shell-loading-icon-slot shell-loading-desktop-only">
                <Placeholder width={16} height={16} />
              </span>
            )}
            <span className="shell-loading-icon-slot shell-loading-phone-only">
              <Placeholder width={16} height={16} />
            </span>
            <span className="shell-loading-icon-slot shell-loading-phone-only">
              <Placeholder width={16} height={16} />
            </span>
          </div>
        </header>
        <div className="app-content shell-loading-content">
          <ProgressBar source={progressTasks} label={t('common.loading')} className="data-progress" />
          <RouteSkeleton body={loadingBody} isImmediate />
        </div>
      </div>
    </div>
  );
};
