import React from 'react';
import { createPortal } from 'react-dom';
import { Tooltip as AntTooltip, type TooltipProps as AntTooltipProps, type TooltipRef } from 'antd';
import { hasOpenPopup, hoverIntentDelay, isControl, noteHintClosed } from './tooltipIntent';

type TriggerEvents = Pick<React.DOMAttributes<HTMLElement>,
  'onClick' | 'onMouseDown' | 'onTouchStart' | 'onFocus' | 'onBlur' | 'onMouseEnter' | 'onMouseLeave' |
  'onPointerEnter' | 'onPointerLeave' | 'onPointerMove' | 'onPointerDown' | 'onContextMenu'>;

export type TooltipProps = TriggerEvents & Omit<AntTooltipProps, 'trigger' | 'mouseEnterDelay' | 'mouseLeaveDelay'> & {
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
};

type TriggerHandle = HTMLElement | { nativeElement?: HTMLElement };
type ChildProps = React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<TriggerHandle> };

/** The real trigger stays mounted; only a reader's intent allocates popup and alignment machinery. */
const TooltipPopup = React.forwardRef<TooltipRef, AntTooltipProps & { element: HTMLElement }>(
  ({ element, open, children: _children, ...props }, ref) => {
    const [bounds, setBounds] = React.useState(() => element.getBoundingClientRect());
    React.useLayoutEffect(() => {
      if (!open) return;
      const updateBounds = () => setBounds(element.getBoundingClientRect());
      updateBounds();
      const observer = new ResizeObserver(updateBounds);
      observer.observe(element);
      window.addEventListener('resize', updateBounds);
      document.addEventListener('scroll', updateBounds, true);
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', updateBounds);
        document.removeEventListener('scroll', updateBounds, true);
      };
    }, [element, open]);
    return createPortal(
      <AntTooltip {...props} ref={ref} open={open} trigger={[]}>
        <span aria-hidden="true" style={{
          position: 'fixed', pointerEvents: 'none',
          left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
        }} />
      </AntTooltip>,
      document.body,
    );
  },
);
TooltipPopup.displayName = 'TooltipPopup';

function compose<E>(own: ((event: E) => void) | undefined, theirs: ((event: E) => void) | undefined) {
  return (event: E) => {
    own?.(event);
    theirs?.(event);
  };
}

/**
 * The console's tooltip: Ant Design's popup, opened only when the reader is asking for it.
 *
 * A mouse or pen asks by resting on the trigger after moving onto it (`tooltipIntent.ts` says why
 * entering is not enough). Pressing the trigger puts the hint away until the pointer leaves, and it
 * stays down while the trigger has a menu or panel open. A finger asks by tapping a trigger that does
 * nothing else - text, a mark, an info glyph - and the hint then stays until the next touch elsewhere
 * or a scroll; a tap on a control only operates it. A keyboard asks by moving a visible focus onto the
 * trigger, and the hint leaves with the focus. Callers that hold `open` can still force the
 * hint down (`open={false}`) or up.
 */
export const Tooltip = React.forwardRef<TooltipRef, TooltipProps>(
  ({ children, open: heldOpen, isTapReadable = false, isFocusOnly = false, title, overlay, afterOpenChange,
    onClick, onMouseDown, onTouchStart, onFocus, onBlur, onMouseEnter, onMouseLeave, onPointerEnter,
    onPointerLeave, onPointerMove, onPointerDown, onContextMenu, ...rest }, ref) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [popupTarget, setPopupTarget] = React.useState<HTMLElement | null>(null);
    const popupId = React.useId();
    const triggerRef = React.useRef<HTMLElement | null>(null);
    const popupRef = React.useRef<TooltipRef>(null);
    // A parent popup (for example Popconfirm) still anchors to the original control before
    // this hint has ever opened. Exposing the portal's synthetic anchor would move its target.
    React.useImperativeHandle(ref, () => ({
      get nativeElement() { return triggerRef.current!; },
      get popupElement() { return popupRef.current?.popupElement!; },
      forceAlign: () => popupRef.current?.forceAlign(),
    }), []);
    const timerRef = React.useRef<number | undefined>(undefined);
    // A press holds the hint down until the pointer leaves the trigger.
    const isPressedRef = React.useRef(false);
    const lastPointerRef = React.useRef<string>('mouse');
    const hasContent = title !== undefined && title !== null && title !== '' && title !== false
      || overlay !== undefined && overlay !== null;

    const cancelPending = React.useCallback(() => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }, []);
    const close = React.useCallback(() => {
      cancelPending();
      setIsOpen(false);
    }, [cancelPending]);

    React.useEffect(() => cancelPending, [cancelPending]);

    // An open hint belongs to the moment it answered: a scroll moves its trigger, a touch elsewhere is
    // the reader moving on, and Escape or leaving the window dismisses it outright.
    React.useEffect(() => {
      if (!isOpen) return;
      const onPointerDown = (event: PointerEvent) => {
        const trigger = triggerRef.current;
        if (!trigger || !(event.target instanceof Node) || !trigger.contains(event.target)) close();
      };
      const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('scroll', close, true);
      window.addEventListener('blur', close);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('scroll', close, true);
        window.removeEventListener('blur', close);
      };
    }, [isOpen, close]);

    const child = React.isValidElement<ChildProps>(children) ? children : <span>{children}</span>;
    const childProps = child.props;
    const childRef = (child as React.ReactElement & { ref?: React.Ref<TriggerHandle> }).ref;
    const attachTrigger = React.useCallback((handle: TriggerHandle | null) => {
      triggerRef.current = handle instanceof HTMLElement ? handle : handle?.nativeElement ?? null;
      if (typeof childRef === 'function') childRef(handle);
      else if (childRef) (childRef as React.MutableRefObject<TriggerHandle | null>).current = handle;
    }, [childRef]);
    const isShown = hasContent && !rest.disabled && (heldOpen ?? isOpen);
    React.useLayoutEffect(() => {
      if (isShown && triggerRef.current) setPopupTarget(triggerRef.current);
    }, [isShown]);
    const trigger = React.cloneElement(child, {
      ref: attachTrigger,
      'aria-describedby': isShown ? [childProps['aria-describedby'], rest.id ?? popupId].filter(Boolean).join(' ') : childProps['aria-describedby'],
      className: [childProps.className, rest.className, isShown && (rest.openClassName ?? 'ant-tooltip-open')].filter(Boolean).join(' ') || undefined,
      style: rest.style ? { ...childProps.style, ...rest.style } : childProps.style,
      onMouseDown: compose(childProps.onMouseDown, onMouseDown),
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
      // Keyboard focus only: a click focuses what it pressed too, and that is not a request to read it.
      onFocus: compose(compose(childProps.onFocus, onFocus), (event: React.FocusEvent<HTMLElement>) => {
        const element = event.currentTarget;
        if (!hasContent || heldOpen !== undefined || !element.matches(':focus-visible') || hasOpenPopup(element)) return;
        triggerRef.current = element;
        setIsOpen(true);
      }),
      onBlur: compose(compose(childProps.onBlur, onBlur), () => close()),
    });

    return (
      <>
        {trigger}
        {popupTarget && (
          <TooltipPopup
            {...rest}
            ref={popupRef}
            id={rest.id ?? popupId}
            element={popupTarget}
            title={title}
            overlay={overlay}
            open={isShown}
            afterOpenChange={(hasOpened) => {
              if (!hasOpened) {
                noteHintClosed();
                if (!isShown) setPopupTarget(null);
              }
              afterOpenChange?.(hasOpened);
            }}
          />
        )}
      </>
    );
  },
);
Tooltip.displayName = 'Tooltip';
