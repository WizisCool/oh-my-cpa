import React from 'react';
import { Drawer, Tabs } from 'antd';
import { clsx } from 'clsx';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useResizablePanel } from './useResizablePanel';
import styles from './Workspace.module.css';

/** One tab of the side panel; the panel is where a workspace's secondary views register. */
export interface WorkspaceAsideTab {
  key: string;
  label: string;
  content: React.ReactNode;
}

export interface WorkspaceAside {
  /** Names the panel for assistive technology, and titles the Drawer it becomes on a phone. */
  title: string;
  tabs: WorkspaceAsideTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  resizeLabel: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

export interface WorkspaceLayoutProps {
  testId: string;
  title: string;
  /** The key and model the conversation runs against. */
  target: React.ReactNode;
  actions: React.ReactNode;
  notices?: React.ReactNode;
  aside: WorkspaceAside;
  children: React.ReactNode;
}

/**
 * The frame both conversation workspaces share: a head carrying the title, the target and the
 * page actions; a main column the page fills with its conversation; and a resizable, tabbed side
 * panel - the extension slot for views beside the conversation (a directory, call details,
 * parameters), each registered as a tab rather than wired into the page.
 *
 * The frame spans the whole content area rather than the 1440px page column, for the same reason
 * the configuration workbench does: the head's rule and the panel's left edge are anchored to the
 * viewport, and the conversation centres its own reading column inside what is left. Capping the
 * frame would float the panel in the middle of a wide screen with the transcript beside it.
 *
 * Below the narrow breakpoint the panel becomes a Drawer joined to the platform Back gesture, and
 * the target moves onto its own row so the model a message will reach is never hidden in a menu.
 */
export function WorkspaceLayout({ testId, title, target, actions, notices, aside, children }: WorkspaceLayoutProps) {
  const isNarrow = useIsNarrowViewport();
  const panel = useResizablePanel({
    defaultWidth: aside.defaultWidth ?? 380,
    minWidth: aside.minWidth ?? 300,
    maxWidth: aside.maxWidth ?? 640,
  });
  const { onOpenChange } = aside;
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  useOverlayHistory({ isOpen: isNarrow && aside.isOpen, onClose: close });
  // One tab needs no tab strip; several are Ant Design tabs, so the panel reads like every other
  // tabbed surface of the console.
  const content = aside.tabs.length === 1 ? aside.tabs[0].content : (
    <Tabs
      className={styles['panel-tabs']}
      activeKey={aside.activeTab}
      onChange={aside.onTabChange}
      items={aside.tabs.map(tab => ({ key: tab.key, label: tab.label, children: tab.content }))}
    />
  );

  return (
    <div className={styles['workspace']} data-testid={testId}>
      <header className={styles['head']}>
        <h1 className={clsx('terminal-title', styles['title'])}>{title}</h1>
        <div className={styles['target']}>{target}</div>
        <div className={styles['actions']}>{actions}</div>
      </header>
      <div className={clsx(styles['body'], panel.isResizing && styles['is-resizing'])}>
        <main className={styles['main']}>
          {notices && <div className={styles['notices']}>{notices}</div>}
          {children}
        </main>
        {!isNarrow && aside.isOpen && (
          <>
            <div className={styles['resizer']} aria-label={aside.resizeLabel} {...panel.separatorProps} />
            <aside
              ref={panel.panelRef as React.RefObject<HTMLElement>}
              className={styles['aside']}
              style={{ width: panel.width }}
              aria-label={aside.title}
            >
              {content}
            </aside>
          </>
        )}
      </div>
      {isNarrow && (
        <Drawer
          title={aside.title}
          placement="right"
          open={aside.isOpen}
          onClose={close}
          size="min(400px, 92vw)"
          className={styles['drawer']}
        >
          {content}
        </Drawer>
      )}
    </div>
  );
}
