import React from 'react';
import { Drawer } from 'antd';
import type { DrawerProps } from 'antd';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { usePreference } from '../../hooks/usePreference';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import type { ElasticEdgeBounds } from './elasticEdge';

/**
 * The three widths a side panel opens at. Each is capped at the viewport, so a phone gets a
 * full-width sheet without the caller asking for one.
 */
const DRAWER_WIDTHS = {
  narrow: 420,
  medium: 600,
  wide: 760,
} as const;

export type AppDrawerWidth = keyof typeof DRAWER_WIDTHS;

/**
 * Widths an operator dragged a panel to, by panel. They live with the other console preferences,
 * on the server, so a wide monitor's arrangement survives a browser reset. What is stored is the
 * width asked for, not the width shown: a narrower window clamps it at render time without
 * overwriting it, so the panel is wide again once the window is.
 */
const DRAWER_WIDTHS_PREFERENCE = 'omc_drawer_widths';
const NO_SAVED_WIDTHS: Readonly<Record<string, number>> = Object.freeze({});
/** Narrowest a panel can be dragged: a form's label and field still sit side by side. */
const MIN_DRAWER_WIDTH = 360;
/** The panel never covers the whole page: this much stays visible, and clicking it closes the panel. */
const PAGE_LEFT_VISIBLE = 248;
/** The floating panel's inset from the window's edges (index.css, min-width: 901px). */
const PANEL_INSET = 8;

function parseDrawerWidths(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const widths: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_DRAWER_WIDTH && value <= 8192) widths[key] = value;
  }
  return widths;
}

/**
 * The bounds a drag moves within. The ceiling never falls below the preset, so a window that only
 * just fits the floating panel keeps the width it always opened at. `maxWidthCss` is the same rule
 * for the stylesheet, which keeps a saved width inside it as the window resizes.
 */
function drawerBounds(preset: number, viewport: number): ElasticEdgeBounds {
  const max = Math.min(viewport - 2 * PANEL_INSET, Math.max(preset, viewport - PAGE_LEFT_VISIBLE));
  return { min: Math.min(MIN_DRAWER_WIDTH, max), max };
}

function maxWidthCss(preset: number): string {
  return `min(100vw - ${2 * PANEL_INSET}px, max(${preset}px, 100vw - ${PAGE_LEFT_VISIBLE}px))`;
}

export interface AppDrawerProps
  extends Omit<DrawerProps, 'size' | 'width' | 'placement' | 'closable' | 'footer'> {
  /**
   * `narrow` holds a filter form or a short list, `medium` an editor or one record's detail,
   * `wide` a record with tabs, a table or a document.
   */
  width?: AppDrawerWidth;
  /**
   * Names the panel for the width an operator drags it to, which is remembered per panel. Panels
   * that show the same kind of thing share a name.
   */
  widthKey: string;
  /** The actions that finish the panel's work - Cancel, Save - at the footer's trailing edge. */
  footer?: React.ReactNode;
  /** What stands opposite the actions: a state note ("2 unsaved changes") or a reset. */
  footerStart?: React.ReactNode;
}

/**
 * A panel that slides in from the trailing edge to show or edit one thing without leaving the page.
 *
 * Twelve panels chose their own width - nine spellings between 400px and 760px - and six of them
 * laid out their own footer. The opening widths are three here, an operator can drag the leading
 * edge to widen or narrow any panel on a desktop, the close control is always at the trailing
 * end of the head and always named, and a footer is two slots rather than a `div` per panel. The
 * navigation sheet, the time-range sheet and the search-select sheet are not side panels and use
 * antd's `Drawer` directly.
 */
export function AppDrawer({
  width = 'medium',
  widthKey,
  footer,
  footerStart,
  className,
  children,
  title,
  id,
  ...rest
}: AppDrawerProps) {
  const t = useT();
  const generatedId = React.useId();
  const sectionId = id ?? generatedId;
  const preset = DRAWER_WIDTHS[width];
  // Below the shell's narrow breakpoint the panel is an edge-to-edge sheet with no page beside it
  // to give width to, so it has no edge to drag.
  const isNarrow = useIsNarrowViewport();
  const savedWidths = usePreference(DRAWER_WIDTHS_PREFERENCE, NO_SAVED_WIDTHS, parseDrawerWidths);
  const savedWidth = savedWidths.value[widthKey];
  // Writing builds on the stored document, so it waits until that document has been read.
  const isResizable = !isNarrow && savedWidths.loaded;
  const restingSize = !isNarrow && savedWidth !== undefined
    ? `clamp(${MIN_DRAWER_WIDTH}px, ${savedWidth}px, ${maxWidthCss(preset)})`
    : `min(${preset}px, 100vw)`;
  // A drag drives `--app-drawer-live` straight on the wrapper; with it unset the panel takes its
  // resting width, which a drag commits to before letting go of the live one.
  const size = isResizable ? `var(--app-drawer-live, ${restingSize})` : restingSize;
  const latestWidths = React.useRef(savedWidths);
  latestWidths.current = savedWidths;
  const commitWidth = React.useCallback((next: number) => {
    const current = latestWidths.current;
    void current.set({ ...current.value, [widthKey]: next });
  }, [widthKey]);
  const resetWidth = React.useCallback(() => {
    const current = latestWidths.current;
    if (!(widthKey in current.value)) return;
    const { [widthKey]: _forgotten, ...others } = current.value;
    void current.set(others);
  }, [widthKey]);
  const bounds = React.useCallback(() => drawerBounds(preset, window.innerWidth), [preset]);
  const defaultWidth = React.useCallback(() => Math.min(preset, window.innerWidth), [preset]);
  // Callers open a panel on a selection and close it by clearing that selection, so on the closing
  // frame their content is already gone. The panel keeps showing what it showed while open until
  // it has slid away, rather than sliding out blank.
  const lastOpen = React.useRef({ children, title, footer, footerStart });
  if (rest.open) lastOpen.current = { children, title, footer, footerStart };
  const shown = lastOpen.current;
  const hasFooter = isRendered(shown.footer) || isRendered(shown.footerStart);
  return (
    <Drawer
      {...rest}
      id={sectionId}
      title={shown.title}
      className={clsx('app-drawer', className)}
      placement="right"
      size={size}
      closable={{ placement: 'end', 'aria-label': t('common.close') }}
      // A layer opened from inside the panel - a picker's bottom sheet - covers it; antd would
      // otherwise shove the panel 180px aside, half off a phone's screen.
      push={false}
      // Always through the same fragment: switching `drawerRender` on once preferences load would
      // move the panel in the tree and remount whatever it holds, losing an editor's draft.
      drawerRender={(panel) => (
        <>
          {panel}
          {isResizable && (
            <DrawerResizeHandle
              controls={sectionId}
              bounds={bounds}
              defaultWidth={defaultWidth}
              onCommit={commitWidth}
              onReset={resetWidth}
            />
          )}
        </>
      )}
      footer={hasFooter ? (
        <div className="app-drawer-footer">
          {isRendered(shown.footerStart) && <div className="app-drawer-footer-start">{shown.footerStart}</div>}
          {isRendered(shown.footer) && <div className="app-drawer-footer-actions">{shown.footer}</div>}
        </div>
      ) : undefined}
    >
      {shown.children}
    </Drawer>
  );
}

function isRendered(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}
