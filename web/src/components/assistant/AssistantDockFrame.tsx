import React from 'react';
import { Drawer } from 'antd';
import { clsx } from 'clsx';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useT } from '../../i18n';
import { RouteLoading } from '../common/PageLoading';
import { useResizablePanel } from '../workspace/useResizablePanel';

// The workspace, the chat framework and everything they pull in load when the dock first opens,
// so a console that never opens it never downloads them.
const AssistantDock = React.lazy(() => import('./AssistantDock'));

export interface AssistantDockFrameProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Where the assistant sits beside a page (ADR 0073): a resizable panel that pushes the page aside
 * when there is room, lies over it when there is not, and is a Back-aware sheet on a phone. The
 * frame stays mounted while closed once it has been opened, so reopening it is instant and a
 * half-typed message is still there.
 */
export function AssistantDockFrame({ isOpen, onClose }: AssistantDockFrameProps) {
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const [hasOpened, setHasOpened] = React.useState(isOpen);
  if (isOpen && !hasOpened) setHasOpened(true);
  const panel = useResizablePanel({ defaultWidth: 420, minWidth: 340, maxWidth: 640 });
  useOverlayHistory({ isOpen: isPhone && isOpen, onClose });
  if (!hasOpened) return null;
  const dock = (
    <React.Suspense fallback={<RouteLoading />}>
      <AssistantDock isOpen={isOpen} onClose={onClose} />
    </React.Suspense>
  );
  if (isPhone) {
    return (
      <Drawer
        placement="right"
        open={isOpen}
        onClose={onClose}
        size="100vw"
        closable={false}
        className="assistant-drawer"
        styles={{ body: { padding: 0 } }}
      >
        {dock}
      </Drawer>
    );
  }
  return (
    <div className={clsx('assistant-dock', panel.isResizing && 'is-resizing')} hidden={!isOpen} data-testid="assistant-dock">
      <div className="assistant-dock-resizer" aria-label={t('assistant.resize')} {...panel.separatorProps} />
      <aside
        ref={panel.panelRef as React.RefObject<HTMLElement>}
        className="assistant-dock-panel"
        style={{ width: panel.width }}
        aria-label={t('assistant.title')}
      >
        {dock}
      </aside>
    </div>
  );
}
