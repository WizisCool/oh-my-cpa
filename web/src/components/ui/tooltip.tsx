import * as React from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { hoverIntentDelay, noteHintClosed } from '@/components/common/tooltipIntent';
import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const TooltipRoot = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipContentProps extends Omit<TooltipPrimitive.Popup.Props, 'className'> {
  side?: TooltipPrimitive.Positioner.Props['side'];
  align?: TooltipPrimitive.Positioner.Props['align'];
  sideOffset?: number;
  anchor?: TooltipPrimitive.Positioner.Props['anchor'];
  interactive?: boolean;
  className?: string;
}

function TooltipContent({
  side = 'top',
  align = 'center',
  sideOffset = 6,
  anchor,
  interactive = false,
  className,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn('z-[1070]', !interactive && 'pointer-events-none')}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip"
          className={cn(
            'omc-float-surface max-w-[min(340px,calc(100vw-24px))] rounded-md bg-popover px-2.5 py-1.5 text-sm leading-snug text-popover-foreground shadow-float break-words',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export interface TooltipReadoutRow {
  key?: string;
  name?: React.ReactNode;
  color?: string;
  indicator?: 'dot' | 'line' | 'dashed';
  value: React.ReactNode;
  share?: React.ReactNode;
  note?: React.ReactNode;
  isTotal?: boolean;
}

export interface TooltipReadoutProps {
  heading?: React.ReactNode;
  rows: readonly TooltipReadoutRow[];
  footer?: React.ReactNode;
  className?: string;
}

/**
 * Shared structured telemetry readout used across ChartTooltipContent, heatmap cells,
 * rhythm/matrix grids, and exact-token popups.
 */
function TooltipReadout({ heading, rows, footer, className }: TooltipReadoutProps) {
  const hasNames = rows.some((row) => row.name !== undefined && row.name !== '');
  const hasMeta = rows.some((row) => row.share !== undefined || row.note !== undefined);

  return (
    <div data-slot="tooltip-readout" className={cn('flex flex-col gap-1 min-w-[112px]', className)}>
      {heading !== undefined && heading !== '' && (
        <div className="text-sm font-medium text-muted-foreground tabular-nums pb-0.5">
          {heading}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {rows.map((row, index) => {
          const indicator = row.indicator ?? 'dot';
          return (
            <div
              key={row.key ?? index}
              className={cn(
                'flex items-center justify-between gap-3 tabular-nums text-sm leading-snug',
                row.isTotal && index > 0 && 'mt-0.5 pt-1 border-t-[length:var(--hairline)] border-t-border-soft',
              )}
            >
              {(hasNames || row.color) && (
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  {row.color ? (
                    indicator === 'dashed' ? (
                      <span
                        aria-hidden="true"
                        className="w-2.5 shrink-0 border-t-[1.5px] border-dashed"
                        style={{ borderColor: row.color }}
                      />
                    ) : indicator === 'line' ? (
                      <span
                        aria-hidden="true"
                        className="w-1 h-3 shrink-0 rounded-xs"
                        style={{ backgroundColor: row.color }}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-xs"
                        style={{ backgroundColor: row.color }}
                      />
                    )
                  ) : hasNames ? (
                    <span aria-hidden="true" className="size-2 shrink-0 opacity-0" />
                  ) : null}
                  {row.name !== undefined && (
                    <span className={cn('max-w-[196px] truncate', row.isTotal ? 'text-muted-foreground font-medium' : 'text-foreground')}>
                      {row.name}
                    </span>
                  )}
                </span>
              )}
              <span className={cn('inline-flex items-baseline gap-1.5 shrink-0', hasNames && 'ml-auto')}>
                <span className="font-medium text-foreground whitespace-nowrap">{row.value}</span>
                {hasMeta && (row.share !== undefined || row.note !== undefined) && (
                  <span className="text-muted-foreground whitespace-nowrap">
                    {row.share ?? row.note}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {footer && (
        <div className="mt-0.5 pt-1 border-t-[length:var(--hairline)] border-t-border-soft">
          {footer}
        </div>
      )}
    </div>
  );
}

interface DelegatedTipState {
  element: HTMLElement;
  text: string;
  side: TooltipPrimitive.Positioner.Props['side'];
  isOpen: boolean;
}

const DELEGATED_SWITCH_DELAY_MS = 80;

function isOverflowing(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

/**
 * Single document-level delegated tooltip layer for `data-tip` and `data-tip-overflow` elements.
 * Replaces native browser `title` attributes across dense tables, badges, grids, and truncated labels
 * with zero per-cell React wrapper overhead.
 */
function DelegatedTooltipLayer() {
  const [target, setTarget] = React.useState<DelegatedTipState | null>(null);
  const popupId = React.useId();

  React.useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let isShowing = false;

    const cancel = () => {
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
    };

    const findTipElement = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      return node.closest<HTMLElement>('[data-tip]');
    };

    const canShow = (element: HTMLElement): string | null => {
      const text = element.dataset.tip?.trim();
      if (!text || !element.isConnected) return null;
      if (element.hasAttribute('data-tip-overflow') && !isOverflowing(element)) return null;
      return text;
    };

    const resolveSide = (element: HTMLElement): TooltipPrimitive.Positioner.Props['side'] => {
      const raw = element.dataset.tipSide;
      if (raw === 'bottom' || raw === 'left' || raw === 'right' || raw === 'top') return raw;
      return 'top';
    };

    const show = (element: HTMLElement) => {
      cancel();
      const text = canShow(element);
      if (!text) return;
      isShowing = true;
      setTarget({ element, text, side: resolveSide(element), isOpen: true });
    };

    const hide = () => {
      const wasShowing = isShowing;
      cancel();
      isShowing = false;
      if (wasShowing) {
        noteHintClosed();
        setTarget((prev) => (prev?.isOpen ? { ...prev, isOpen: false } : prev));
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const element = findTipElement(event.target);
      if (element === hovered) return;
      hovered = element;
      cancel();
      if (!element) {
        if (isShowing && !focused) {
          pending = setTimeout(hide, DELEGATED_SWITCH_DELAY_MS);
        }
        return;
      }
      pending = setTimeout(() => {
        if (hovered === element) show(element);
      }, isShowing ? DELEGATED_SWITCH_DELAY_MS : hoverIntentDelay());
    };

    const onFocusIn = (event: FocusEvent) => {
      const element = findTipElement(event.target);
      focused = element && element.matches(':focus-visible') ? element : null;
      if (focused) show(focused);
    };

    const onFocusOut = () => {
      focused = null;
      if (!hovered) hide();
    };

    let activeTouchElement: HTMLElement | null = null;
    let touchStartPos: { x: number; y: number } | null = null;

    const isInteractiveTarget = (element: HTMLElement): boolean =>
      element.closest(
        'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"], [role="switch"]',
      ) !== null;

    const onPointerDown = (event: PointerEvent) => {
      hovered = null;
      if (event.pointerType === 'touch') {
        const element = findTipElement(event.target);
        touchStartPos = { x: event.clientX, y: event.clientY };
        if (!element || isInteractiveTarget(element) || element === activeTouchElement) {
          activeTouchElement = null;
          hide();
        }
        return;
      }
      activeTouchElement = null;
      hide();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !touchStartPos) return;
      const moved =
        Math.abs(event.clientX - touchStartPos.x) > 8 ||
        Math.abs(event.clientY - touchStartPos.y) > 8;
      touchStartPos = null;
      if (moved) return;
      const element = findTipElement(event.target);
      if (element && !isInteractiveTarget(element) && element !== activeTouchElement) {
        activeTouchElement = element;
        show(element);
      }
    };

    const onTouchStartOutside = (event: TouchEvent) => {
      if (!isShowing) return;
      const element = findTipElement(event.target);
      if (!element || element !== activeTouchElement) {
        activeTouchElement = null;
        hide();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isShowing) {
        hovered = null;
        focused = null;
        hide();
      }
    };

    const onViewportChange = () => {
      if (!isShowing && pending === undefined) return;
      hovered = null;
      focused = null;
      activeTouchElement = null;
      hide();
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('touchstart', onTouchStartOutside, { capture: true, passive: true });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onViewportChange);
    window.addEventListener('blur', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    return () => {
      cancel();
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('touchstart', onTouchStartOutside, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onViewportChange, true);
      document.removeEventListener('visibilitychange', onViewportChange);
      window.removeEventListener('blur', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
    };
  }, []);

  React.useLayoutEffect(() => {
    if (!target?.isOpen || !target.element.isConnected) return;
    const el = target.element;
    const prev = el.getAttribute('aria-describedby');
    const tokens = prev ? prev.split(/\s+/).filter(Boolean) : [];
    if (!tokens.includes(popupId)) el.setAttribute('aria-describedby', [...tokens, popupId].join(' '));
    return () => {
      const current = el.getAttribute('aria-describedby');
      if (!current) return;
      const next = current.split(/\s+/).filter((id) => id && id !== popupId);
      if (next.length > 0) el.setAttribute('aria-describedby', next.join(' '));
      else el.removeAttribute('aria-describedby');
    };
  }, [popupId, target]);

  if (!target || !target.element.isConnected) return null;

  return (
    <TooltipRoot
      open={target.isOpen}
      onOpenChangeComplete={(open) => {
        if (!open) setTarget((current) => (current && !current.isOpen ? null : current));
      }}
    >
      <TooltipContent
        id={popupId}
        anchor={target.element}
        side={target.side}
        sideOffset={6}
        className="whitespace-pre-line"
      >
        {target.text}
      </TooltipContent>
    </TooltipRoot>
  );
}

export {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
  TooltipReadout,
  DelegatedTooltipLayer,
  TooltipPrimitive,
};
