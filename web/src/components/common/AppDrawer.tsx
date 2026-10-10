import React from 'react';
import { Drawer } from 'antd';
import type { DrawerProps } from 'antd';
import clsx from 'clsx';
import { useT } from '../../i18n';

/**
 * The three widths a side panel comes in. Each is capped at the viewport, so a phone gets a
 * full-width sheet without the caller asking for one.
 */
const DRAWER_WIDTHS = {
  narrow: 'min(420px, 100vw)',
  medium: 'min(600px, 100vw)',
  wide: 'min(760px, 100vw)',
} as const;

export type AppDrawerWidth = keyof typeof DRAWER_WIDTHS;

export interface AppDrawerProps
  extends Omit<DrawerProps, 'size' | 'width' | 'placement' | 'closable' | 'footer'> {
  /**
   * `narrow` holds a filter form or a short list, `medium` an editor or one record's detail,
   * `wide` a record with tabs, a table or a document.
   */
  width?: AppDrawerWidth;
  /** The actions that finish the panel's work - Cancel, Save - at the footer's trailing edge. */
  footer?: React.ReactNode;
  /** What stands opposite the actions: a state note ("2 unsaved changes") or a reset. */
  footerStart?: React.ReactNode;
}

/**
 * A panel that slides in from the trailing edge to show or edit one thing without leaving the page.
 *
 * Twelve panels chose their own width - nine spellings between 400px and 760px - and six of them
 * laid out their own footer. The widths are three here, the close control is always at the trailing
 * end of the head and always named, and a footer is two slots rather than a `div` per panel. The
 * navigation sheet and the time-range sheet are not side panels and use antd's `Drawer` directly.
 */
export function AppDrawer({
  width = 'medium',
  footer,
  footerStart,
  className,
  children,
  ...rest
}: AppDrawerProps) {
  const t = useT();
  const hasFooter = isRendered(footer) || isRendered(footerStart);
  return (
    <Drawer
      {...rest}
      className={clsx('app-drawer', className)}
      placement="right"
      size={DRAWER_WIDTHS[width]}
      closable={{ placement: 'end', 'aria-label': t('common.close') }}
      footer={hasFooter ? (
        <div className="app-drawer-footer">
          {isRendered(footerStart) && <div className="app-drawer-footer-start">{footerStart}</div>}
          {isRendered(footer) && <div className="app-drawer-footer-actions">{footer}</div>}
        </div>
      ) : undefined}
    >
      {children}
    </Drawer>
  );
}

function isRendered(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}
