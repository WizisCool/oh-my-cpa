import React from 'react';
import { Tooltip as AntTooltip, type TooltipProps as AntTooltipProps, type TooltipRef } from 'antd';
import { hasOpenPopup, hoverIntentDelay, isControl, noteHintClosed } from './tooltipIntent';

export type TooltipProps = Omit<AntTooltipProps, 'trigger' | 'mouseEnterDelay' | 'mouseLeaveDelay'> & {
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

type ChildProps = React.HTMLAttributes<HTMLElement>;

function compose<E>(own: ((event: E) => void) | undefined, theirs: (event: E) => void) {
  return (event: E) => {
    own?.(event);
    theirs(event);
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
  ({ children, open: heldOpen, isTapReadable = false, isFocusOnly = false, title, overlay, afterOpenChange, ...rest }, ref) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLElement | null>(null);
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
    const trigger = React.cloneElement(child, {
      onPointerMove: compose(childProps.onPointerMove, (event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'touch' || isFocusOnly) return;
        triggerRef.current = event.currentTarget;
        if (!hasContent || isPressedRef.current || isOpen || timerRef.current !== undefined) return;
        const element = event.currentTarget;
        if (hasOpenPopup(element)) return;
        timerRef.current = window.setTimeout(() => {
          timerRef.current = undefined;
          if (element.isConnected && !isPressedRef.current && !hasOpenPopup(element)) setIsOpen(true);
        }, hoverIntentDelay());
      }),
      onPointerLeave: compose(childProps.onPointerLeave, (event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'touch') return;
        isPressedRef.current = false;
        close();
      }),
      onPointerDown: compose(childProps.onPointerDown, (event: React.PointerEvent<HTMLElement>) => {
        lastPointerRef.current = event.pointerType;
        triggerRef.current = event.currentTarget;
        if (event.pointerType === 'touch') return;
        isPressedRef.current = true;
        close();
      }),
      onClick: compose(childProps.onClick, (event: React.MouseEvent<HTMLElement>) => {
        const isTap = lastPointerRef.current === 'touch';
        lastPointerRef.current = 'mouse';
        if (!isTap || !hasContent || isFocusOnly) return;
        if (!isTapReadable && isControl(event.currentTarget)) return;
        setIsOpen((current) => !current);
      }),
      // Keyboard focus only: a click focuses what it pressed too, and that is not a request to read it.
      onFocus: compose(childProps.onFocus, (event: React.FocusEvent<HTMLElement>) => {
        const element = event.currentTarget;
        if (!hasContent || !element.matches(':focus-visible') || hasOpenPopup(element)) return;
        triggerRef.current = element;
        setIsOpen(true);
      }),
      onBlur: compose(childProps.onBlur, () => close()),
    });

    const isShown = heldOpen ?? isOpen;
    return (
      <AntTooltip
        {...rest}
        ref={ref}
        title={title}
        overlay={overlay}
        open={hasContent && isShown}
        trigger={[]}
        afterOpenChange={(hasOpened) => {
          if (!hasOpened) noteHintClosed();
          afterOpenChange?.(hasOpened);
        }}
      >
        {trigger}
      </AntTooltip>
    );
  },
);
Tooltip.displayName = 'Tooltip';
