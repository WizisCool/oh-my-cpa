import React from 'react';
import clsx from 'clsx';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
} from '@/components/ui/sheet';
import { useT } from '../../i18n';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { usePreference } from '../../hooks/usePreference';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import type { ElasticEdgeBounds } from './elasticEdge';

const DRAWER_WIDTHS = {
  narrow: 420,
  medium: 600,
  wide: 760,
} as const;

export type AppDrawerWidth = keyof typeof DRAWER_WIDTHS;

const DRAWER_WIDTHS_PREFERENCE = 'omc_drawer_widths';
const NO_SAVED_WIDTHS: Readonly<Record<string, number>> = Object.freeze({});
const MIN_DRAWER_WIDTH = 360;
const PAGE_LEFT_VISIBLE = 248;
const PANEL_INSET = 8;

function parseDrawerWidths(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const widths: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_DRAWER_WIDTH && value <= 8192) widths[key] = value;
  }
  return widths;
}

function drawerBounds(preset: number, viewport: number): ElasticEdgeBounds {
  const max = Math.min(viewport - 2 * PANEL_INSET, Math.max(preset, viewport - PAGE_LEFT_VISIBLE));
  return { min: Math.min(MIN_DRAWER_WIDTH, max), max };
}

function maxWidthCss(preset: number): string {
  return `min(100vw - ${2 * PANEL_INSET}px, max(${preset}px, 100vw - ${PAGE_LEFT_VISIBLE}px))`;
}

export interface AppDrawerProps {
  open?: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  extra?: React.ReactNode;
  width?: AppDrawerWidth;
  widthKey: string;
  footer?: React.ReactNode;
  footerStart?: React.ReactNode;
  destroyOnHidden?: boolean;
  afterOpenChange?: (open: boolean) => void;
  id?: string;
  className?: string;
  children?: React.ReactNode;
  'data-testid'?: string;
}

export function AppDrawer({
  open = false,
  onClose,
  width = 'medium',
  widthKey,
  extra,
  footer,
  footerStart,
  destroyOnHidden = false,
  afterOpenChange,
  className,
  children,
  title,
  id,
  'data-testid': testId,
}: AppDrawerProps) {
  const t = useT();
  const [hasOpened, setHasOpened] = React.useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const generatedId = React.useId();
  const sectionId = id ?? generatedId;
  const preset = DRAWER_WIDTHS[width];
  const isNarrow = useIsNarrowViewport();
  const savedWidths = usePreference(DRAWER_WIDTHS_PREFERENCE, NO_SAVED_WIDTHS, parseDrawerWidths);
  const savedWidth = savedWidths.value[widthKey];
  const isResizable = !isNarrow && savedWidths.loaded;
  const restingSize = !isNarrow && savedWidth !== undefined
    ? `clamp(${MIN_DRAWER_WIDTH}px, ${savedWidth}px, ${maxWidthCss(preset)})`
    : `min(${preset}px, 100vw)`;
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

  const lastOpen = React.useRef({ children, title, extra, footer, footerStart });
  if (open) lastOpen.current = { children, title, extra, footer, footerStart };
  const shown = lastOpen.current;
  const hasFooter = isRendered(shown.footer) || isRendered(shown.footerStart);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose?.();
      }}
      afterOpenChange={afterOpenChange}
    >
      <SheetContent
        id={sectionId}
        side="right"
        floatingDesktop
        surface="ground"
        hasOpened={hasOpened}
        destroyOnHidden={destroyOnHidden}
        data-testid={testId}
        style={{ width: size }}
        className={clsx('app-drawer', className)}
      >
        <SheetHeader
          title={shown.title}
          extra={shown.extra}
          closeLabel={t('common.close')}
        />
        <SheetBody className="app-drawer-body">
          {shown.children}
        </SheetBody>
        {hasFooter && (
          <SheetFooter>
            <div className="app-drawer-footer">
              {isRendered(shown.footerStart) && <div className="app-drawer-footer-start">{shown.footerStart}</div>}
              {isRendered(shown.footer) && <div className="app-drawer-footer-actions">{shown.footer}</div>}
            </div>
          </SheetFooter>
        )}
        {isResizable && (
          <DrawerResizeHandle
            controls={sectionId}
            bounds={bounds}
            defaultWidth={defaultWidth}
            onCommit={commitWidth}
            onReset={resetWidth}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function isRendered(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}
