import React from 'react';
import { Button, Tooltip } from 'antd';

import { useT } from '../../i18n';
import { FullscreenExitOutlined, FullscreenOutlined, VerticalAlignTopOutlined } from '../icons';
import { useViewFlag, type ViewFlag } from './viewFlag';

/**
 * The request page's elements that show a scroll-driven flag. Each subscribes to
 * its flag itself, so a fold or a return to the top re-renders these few nodes
 * and not the page around them; see `viewFlag.ts`.
 */

/** The page header and filter toolbar, folded away while the reader scrolls. */
export function RequestCollapsibleHeader({ collapse, children }: { collapse: ViewFlag; children: React.ReactNode }) {
  const isCollapsed = useViewFlag(collapse);
  return <div className={`request-collapsible-header ${isCollapsed ? 'is-collapsed' : ''}`}>{children}</div>;
}

export function RequestFoldToggle({ collapse, onToggle }: { collapse: ViewFlag; onToggle: () => void }) {
  const t = useT();
  const isCollapsed = useViewFlag(collapse);
  const label = t(isCollapsed ? 'events.collapse_view' : 'events.expand_view');
  return (
    <Tooltip title={label}>
      <Button
        size="small"
        type="text"
        className="req-expand-toggle-btn"
        aria-label={label}
        icon={isCollapsed ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
        onClick={onToggle}
      />
    </Tooltip>
  );
}

/** Shown once the reader has left the top, or while records wait above them. */
export function RequestBackToTop({
  scrolledDown,
  pendingCount,
  onBackToTop,
}: {
  scrolledDown: ViewFlag;
  pendingCount: number;
  onBackToTop: () => void;
}) {
  const t = useT();
  const isScrolledDown = useViewFlag(scrolledDown);
  if (!isScrolledDown && pendingCount <= 0) return null;
  const label = pendingCount > 0 ? t('events.new_records', { n: pendingCount }) : t('events.back_to_top');
  return (
    <button
      type="button"
      className={`req-back-to-top-btn${pendingCount > 0 ? ' is-live' : ''}`}
      onClick={onBackToTop}
      aria-label={label}
    >
      <VerticalAlignTopOutlined className="req-back-to-top-icon" />
      <span className="req-back-to-top-text">{label}</span>
    </button>
  );
}
