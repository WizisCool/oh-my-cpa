import React from 'react';
import { TooltipPrimitive } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { hasOpenPopup, hoverIntentDelay, isControl, noteHintClosed } from './tooltipIntent';

export type TooltipPlacement =
  | 'top'
  | 'topLeft'
  | 'topRight'
  | 'bottom'
  | 'bottomLeft'
  | 'bottomRight'
  | 'left'
  | 'leftTop'
  | 'leftBottom'
  | 'right'
  | 'rightTop'
  | 'rightBottom';

export type TooltipHandle = HTMLElement;

type TriggerEvents = Pick<
  React.DOMAttributes<HTMLElement>,
  | 'onClick'
  | 'onKeyDown'
  | 'onKeyUp'
  | 'onMouseDown'
  | 'onMouseUp'
  | 'onTouchStart'
  | 'onFocus'
  | 'onBlur'
  | 'onMouseEnter'
  | 'onMouseLeave'
  | 'onPointerEnter'
  | 'onPointerLeave'
  | 'onPointerMove'
  | 'onPointerDown'
  | 'onPointerUp'
  | 'onContextMenu'
>;

export interface TooltipProps extends TriggerEvents, Omit<React.AriaAttributes, 'aria-describedby'> {
  children: React.ReactNode;
  title?: React.ReactNode | (() => React.ReactNode);
  overlay?: React.ReactNode | (() => React.ReactNode);
  placement?: TooltipPlacement;
  open?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  openClassName?: string;
  classNames?: { root?: string; container?: string };
  styles?: { root?: React.CSSProperties; container?: React.CSSProperties };
  style?: React.CSSProperties;
  afterOpenChange?: (open: boolean) => void;
  /**
   * A tap on the trigger reads the hint even though the trigger is a control: an info button whose
   * only job is the hint. Plain text and marks answer a tap without this.
   */
  isTapReadable?: boolean;
  /**
   * Only a visible keyboard focus opens the hint. For a trigger whose children carry hints of their
   * own: the pointer reads those, and a hover on the gaps between them must not open this one too.
   */
  isFocusOnly?: boolean;
}

type TriggerHandle = HTMLElement | { nativeElement?: HTMLElement };
type ChildProps = React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<TriggerHandle> };

function resolvePlacement(placement: TooltipPlacement = 'top'): {
  side: 'top' | 'bottom' | 'left' | 'right';
  align: 'start' | 'center' | 'end';
} {
  switch (placement) {
    case 'topLeft': return { side: 'top', align: 'start' };
    case 'topRight': return { side: 'top', align: 'end' };
    case 'bottom': return { side: 'bottom', align: 'center' };
    case 'bottomLeft': return { side: 'bottom', align: 'start' };
    case 'bottomRight': return { side: 'bottom', align: 'end' };
    case 'left': return { side: 'left', align: 'center' };
    case 'leftTop': return { side: 'left', align: 'start' };
    case 'leftBottom': return { side: 'left', align: 'end' };
    case 'right': return { side: 'right', align: 'center' };
    case 'rightTop': return { side: 'right', align: 'start' };
    case 'rightBottom': return { side: 'right', align: 'end' };
    case 'top':
    default:
      return { side: 'top', align: 'center' };
  }
}

function compose<E>(own: ((event: E) => void) | undefined, theirs: ((event: E) => void) | undefined) {
  return (event: E) => {
    own?.(event);
    theirs?.(event);
  };
}

function evaluateContent(source: React.ReactNode | (() => React.ReactNode)): React.ReactNode {
  return typeof source === 'function' ? source() : source;
}

export const Tooltip = React.forwardRef<TooltipHandle, TooltipProps>(
  (
    {
      children,
      open: heldOpen,
      disabled = false,
      isTapReadable = false,
      isFocusOnly = false,
      title,
      overlay,
      placement = 'top',
      id,
      className,
      openClassName,
      classNames,
      styles,
      style,
      afterOpenChange,
      onClick,
      onMouseDown,
      onTouchStart,
      onFocus,
      onBlur,
      onMouseEnter,
      onMouseLeave,
      onPointerEnter,
      onPointerLeave,
      onPointerMove,
      onPointerDown,
      onPointerUp,
      onMouseUp,
      onKeyDown,
      onKeyUp,
      onContextMenu,
      ...forwardedProps
    },
    ref,
  ) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [popupTarget, setPopupTarget] = React.useState<HTMLElement | null>(null);
    const popupId = React.useId();
    const triggerRef = React.useRef<HTMLElement | null>(null);

    const timerRef = React.useRef<number | undefined>(undefined);
    const isPressedRef = React.useRef(false);
    const lastPointerRef = React.useRef<string>('mouse');
    const hasContent =
      (title !== undefined && title !== null && title !== '' && title !== false) ||
      (overlay !== undefined && overlay !== null && overlay !== false);

    const cancelPending = React.useCallback(() => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }, []);
    const close = React.useCallback(() => {
      cancelPending();
      setIsOpen(false);
    }, [cancelPending]);

    React.useEffect(() => cancelPending, [cancelPending]);

    React.useEffect(() => {
      if (!isOpen) return;
      const handleOutsidePress = (event: Event) => {
        const trigger = triggerRef.current;
        if (!trigger || !(event.target instanceof Node) || !trigger.contains(event.target)) close();
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') close();
      };
      document.addEventListener('pointerdown', handleOutsidePress, true);
      document.addEventListener('touchstart', handleOutsidePress, { capture: true, passive: true });
      document.addEventListener('keydown', handleKeyDown, true);
      document.addEventListener('scroll', close, { capture: true, passive: true });
      document.addEventListener('visibilitychange', close);
      window.addEventListener('blur', close);
      return () => {
        document.removeEventListener('pointerdown', handleOutsidePress, true);
        document.removeEventListener('touchstart', handleOutsidePress, true);
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('scroll', close, true);
        document.removeEventListener('visibilitychange', close);
        window.removeEventListener('blur', close);
      };
    }, [isOpen, close]);

    const child = React.isValidElement<ChildProps>(children) ? children : <span>{children}</span>;
    const childProps = child.props;
    const childRef = childProps.ref;
    const attachTrigger = React.useCallback(
      (handle: TriggerHandle | null) => {
        const element = handle instanceof HTMLElement ? handle : handle?.nativeElement ?? null;
        triggerRef.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref) (ref as React.MutableRefObject<HTMLElement | null>).current = element;
        if (typeof childRef === 'function') childRef(handle);
        else if (childRef) (childRef as React.MutableRefObject<TriggerHandle | null>).current = handle;
      },
      [ref, childRef],
    );

    const isShown = hasContent && !disabled && (heldOpen ?? isOpen);
    const wasShownRef = React.useRef(false);

    React.useLayoutEffect(() => {
      if (isShown && triggerRef.current) {
        setPopupTarget(triggerRef.current);
      }
      if (wasShownRef.current && !isShown) {
        noteHintClosed();
        setPopupTarget(null);
        afterOpenChange?.(false);
      } else if (!wasShownRef.current && isShown) {
        afterOpenChange?.(true);
      }
      wasShownRef.current = isShown;
    }, [isShown, afterOpenChange]);

    const resolvedId = id ?? popupId;
    const trigger = React.cloneElement(child, {
      ...forwardedProps,
      ref: attachTrigger,
      'aria-describedby': isShown
        ? [childProps['aria-describedby'], resolvedId].filter(Boolean).join(' ')
        : childProps['aria-describedby'],
      className: [childProps.className, className, isShown && (openClassName ?? 'omc-tooltip-open')]
        .filter(Boolean)
        .join(' ') || undefined,
      style: style ? { ...childProps.style, ...style } : childProps.style,
      onKeyDown: compose(childProps.onKeyDown, onKeyDown),
      onKeyUp: compose(childProps.onKeyUp, onKeyUp),
      onMouseDown: compose(childProps.onMouseDown, onMouseDown),
      onMouseUp: compose(childProps.onMouseUp, onMouseUp),
      onPointerUp: compose(childProps.onPointerUp, onPointerUp),
      onTouchStart: compose(childProps.onTouchStart, onTouchStart),
      onMouseEnter: compose(childProps.onMouseEnter, onMouseEnter),
      onMouseLeave: compose(childProps.onMouseLeave, onMouseLeave),
      onPointerEnter: compose(childProps.onPointerEnter, onPointerEnter),
      onContextMenu: compose(childProps.onContextMenu, onContextMenu),
      onPointerMove: compose(compose(childProps.onPointerMove, onPointerMove), (event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'touch' || isFocusOnly || heldOpen !== undefined) return;
        triggerRef.current = event.currentTarget;
        if (!hasContent || isPressedRef.current || isOpen || timerRef.current !== undefined) return;
        const element = event.currentTarget;
        if (hasOpenPopup(element)) return;
        timerRef.current = window.setTimeout(() => {
          timerRef.current = undefined;
          if (element.isConnected && !isPressedRef.current && !hasOpenPopup(element)) setIsOpen(true);
        }, hoverIntentDelay());
      }),
      onPointerLeave: compose(compose(childProps.onPointerLeave, onPointerLeave), (event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'touch') return;
        isPressedRef.current = false;
        close();
      }),
      onPointerDown: compose(compose(childProps.onPointerDown, onPointerDown), (event: React.PointerEvent<HTMLElement>) => {
        lastPointerRef.current = event.pointerType;
        triggerRef.current = event.currentTarget;
        if (event.pointerType === 'touch') return;
        isPressedRef.current = true;
        close();
      }),
      onClick: compose(compose(childProps.onClick, onClick), (event: React.MouseEvent<HTMLElement>) => {
        const isTap = lastPointerRef.current === 'touch';
        lastPointerRef.current = 'mouse';
        if (!isTap || !hasContent || isFocusOnly || heldOpen !== undefined) return;
        if (!isTapReadable && isControl(event.currentTarget)) return;
        setIsOpen((current) => !current);
      }),
      onFocus: compose(compose(childProps.onFocus, onFocus), (event: React.FocusEvent<HTMLElement>) => {
        const element = event.currentTarget;
        if (!hasContent || heldOpen !== undefined || !element.matches(':focus-visible') || hasOpenPopup(element)) return;
        triggerRef.current = element;
        setIsOpen(true);
      }),
      onBlur: compose(compose(childProps.onBlur, onBlur), () => close()),
    });

    const { side, align } = resolvePlacement(placement);
    const renderedContent = isShown ? evaluateContent(title ?? overlay) : null;

    return (
      <>
        {trigger}
        {isShown && popupTarget && renderedContent !== null && renderedContent !== undefined && renderedContent !== '' && (
          <TooltipPrimitive.Provider delay={0}>
            <TooltipPrimitive.Root open>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Positioner
                  anchor={popupTarget}
                  side={side}
                  align={align}
                  sideOffset={6}
                  collisionPadding={12}
                  style={styles?.root}
                  className={cn('z-[1070] pointer-events-none', classNames?.root)}
                >
                  <TooltipPrimitive.Popup
                    id={resolvedId}
                    role="tooltip"
                    data-slot="tooltip"
                    style={styles?.container}
                    className={cn(
                      'omc-float-surface max-w-[min(320px,calc(100vw-24px))] rounded-md bg-popover px-2.5 py-1.5 text-sm leading-snug text-popover-foreground shadow-float break-words',
                      classNames?.container,
                    )}
                  >
                    {renderedContent}
                  </TooltipPrimitive.Popup>
                </TooltipPrimitive.Positioner>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
          </TooltipPrimitive.Provider>
        )}
      </>
    );
  },
);
Tooltip.displayName = 'Tooltip';
