import React from 'react';
import { useT } from '../../i18n';
import { useProgressTask } from '../../hooks/useProgressTask';
import { progressTasks } from '../../utils/progressTasks';
import { BrandArtwork } from './BrandArtwork';
import { PageLoading } from './PageLoading';
import { Placeholder } from './Placeholder';
import { ProgressBar } from './ProgressBar';

// One entry per group the rail carries, with each group's item count, so the placeholder rail is
// as long as the real one and the nav does not grow under the reader when it lands.
const NAV_GROUPS = [4, 3, 4, 4];

/**
 * The authenticated shell's stand-in: the rail, the header and a page frame, drawn at the geometry
 * `AppLayout` paints them, while the stored preferences are read and the shell's module downloads.
 *
 * Signing in lands here, so this is the frame between the sign-in card and the console: drawing the
 * console's own outline (and the real wordmark where the rail's brand will be) makes that a page
 * filling in rather than a spinner swapped for a page. The bar under the header counts that wait,
 * which is the one piece of work in flight that nothing else can see yet.
 */
export const ShellLoading: React.FC = () => {
  const t = useT();
  useProgressTask();
  return (
    <div className="shell-loading">
      <aside className="shell-loading-sider" aria-hidden="true">
        <div className="app-brand">
          <BrandArtwork shape="wordmark" height={20} className="app-brand-logo" />
        </div>
        <div className="shell-loading-nav">
          {NAV_GROUPS.map((items, group) => (
            <div key={group} className="shell-loading-nav-group">
              <Placeholder width={56} row={group} className="placeholder-line is-meta" />
              {Array.from({ length: items }, (_, item) => (
                <span key={item} className="shell-loading-nav-item">
                  <Placeholder width={16} height={16} row={group + item} />
                  <Placeholder width={`${48 + ((group * 3 + item * 7) % 5) * 8}%`} row={group + item} className="placeholder-line" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div className="shell-loading-main">
        <header className="shell-loading-header">
          <span className="shell-loading-crumbs" aria-hidden="true">
            <Placeholder width={20} height={20} />
            <Placeholder width={64} className="placeholder-line" />
            <Placeholder width={88} className="placeholder-line" />
          </span>
          <span className="shell-loading-actions" aria-hidden="true">
            <Placeholder width={28} height={28} />
            <Placeholder width={28} height={28} />
            <Placeholder width={28} height={28} />
          </span>
          <ProgressBar source={progressTasks} label={t('common.loading')} className="shell-loading-progress" />
        </header>
        <div className="shell-loading-content">
          <div className="terminal-page">
            <PageLoading />
          </div>
        </div>
      </div>
    </div>
  );
};
