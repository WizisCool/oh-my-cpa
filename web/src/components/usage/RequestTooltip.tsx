import React from 'react';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { TipCardView, TooltipContent, TooltipRoot } from '@/components/ui/tooltip';
import { readTipCard, tipCardText, type TipCard } from '../common/tipCard';
import { RequestFailureDetail } from './RequestFailureDetail';
import { hoverIntentDelay, noteHintClosed, repeatsVisibleText } from '../common/tooltipIntent';
import './requestMarks.css';

const TOOLTIP_SWITCH_DELAY_MS = 100;
const POPUP_CLASS = 'request-cell-tooltip';

/** Plain cells keep the virtualized mount cheap; one list-owned popup reads their current labels. */
export function RequestTooltip({ title, children }: {
  title: string;
  children: React.ReactElement<{ 'data-request-tooltip'?: string }>;
}) {
  return React.cloneElement(children, { 'data-request-tooltip': title });
}

/**
 * Spreads a structured hint onto a request cell: the plain reading on `data-request-tooltip`
 * (which marks the cell as having a hint) and the card the list's popup draws.
 */
export function requestTipCard(card: TipCard): { 'data-request-tooltip'?: string; 'data-request-tooltip-card'?: string } {
  const text = tipCardText(card);
  return text ? { 'data-request-tooltip': text, 'data-request-tooltip-card': JSON.stringify(card) } : {};
}

interface TooltipTarget {
  element: HTMLElement;
  title: string;
  isOpen: boolean;
}

export function RequestTooltipLayer({ hostRef }: { hostRef: React.RefObject<HTMLDivElement | null> }) {
  const [target, setTarget] = React.useState<TooltipTarget | null>(null);
  const popupId = React.useId();

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let pressed: HTMLElement | null = null;
    let isShowing = false;

    const cancelPending = () => {
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
    };
    const findTarget = (node: EventTarget | null) => {
      if (!(node instanceof Element)) return null;
      const element = node.closest<HTMLElement>('[data-request-tooltip]');
      return element && host.contains(element) ? element : null;
    };
    const isInsidePopup = (node: EventTarget | null) =>
      node instanceof Element && node.closest(`.${POPUP_CLASS}`) !== null;
    const activate = (element: HTMLElement) => {
      cancelPending();
      const title = element.dataset.requestTooltip;
      const isHintless = !title || !host.contains(element)
        || (
          element.hasAttribute('data-request-tooltip-overflow') &&
          element.scrollWidth <= element.clientWidth + 1 &&
          element.scrollHeight <= element.clientHeight + 1
        )
        || (!element.dataset.requestFailure && !element.dataset.requestTooltipCard && repeatsVisibleText(element, title));
      // A target with nothing to add closes whatever hint the pointer came from.
      if (isHintless) {
        dismiss();
        return;
      }
      isShowing = true;
      setTarget({ element, title, isOpen: true });
    };
    const dismiss = () => {
      const wasShowing = isShowing;
      cancelPending();
      isShowing = false;
      if (wasShowing) {
        setTarget((current) => current?.isOpen ? { ...current, isOpen: false } : current);
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (isInsidePopup(event.target)) {
        cancelPending();
        return;
      }
      const element = findTarget(event.target);
      if (!element || element === hovered) return;
      hovered = element;
      cancelPending();
      if (element === pressed) return;
      const { clientX, clientY } = event;
      pending = setTimeout(() => {
        const current = element.isConnected ? element : findTarget(document.elementFromPoint(clientX, clientY));
        if (!current) return;
        hovered = current;
        activate(current);
      }, isShowing ? TOOLTIP_SWITCH_DELAY_MS : hoverIntentDelay());
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const next = findTarget(event.relatedTarget);
      if (next === hovered && next !== null) return;
      if (!findTarget(event.target) && !isInsidePopup(event.target)) return;
      if (pressed && !pressed.contains(event.relatedTarget as Node | null)) pressed = null;
      hovered = null;
      if (isInsidePopup(event.relatedTarget)) return;
      cancelPending();
      pending = setTimeout(() => {
        if (focused) activate(focused);
        else dismiss();
      }, TOOLTIP_SWITCH_DELAY_MS);
    };
    const handleFocusIn = (event: FocusEvent) => {
      const element = findTarget(event.target);
      focused = element && element.matches(':focus-visible') ? element : null;
      if (focused) activate(focused);
    };
    const handleFocusOut = () => {
      focused = null;
      if (!hovered || hovered === pressed) dismiss();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (isInsidePopup(event.target)) return;
      pressed = findTarget(event.target);
      dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hovered = null;
        focused = null;
        dismiss();
      }
    };
    const handleGeometryChange = (event: Event) => {
      if (!isShowing && pending === undefined && hovered === null && focused === null) return;
      if (isInsidePopup(event.target)) return;
      hovered = null;
      focused = null;
      dismiss();
    };
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerout', handlePointerOut);
    host.addEventListener('focusin', handleFocusIn);
    host.addEventListener('focusout', handleFocusOut);
    const handleTouchStart = (event: TouchEvent) => {
      if (!isShowing || isInsidePopup(event.target)) return;
      dismiss();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('scroll', handleGeometryChange, { capture: true, passive: true });
    document.addEventListener('visibilitychange', handleGeometryChange);
    window.addEventListener('blur', handleGeometryChange);
    window.addEventListener('resize', handleGeometryChange);
    return () => {
      cancelPending();
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerout', handlePointerOut);
      host.removeEventListener('focusin', handleFocusIn);
      host.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('touchstart', handleTouchStart, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('scroll', handleGeometryChange, true);
      document.removeEventListener('visibilitychange', handleGeometryChange);
      window.removeEventListener('blur', handleGeometryChange);
      window.removeEventListener('resize', handleGeometryChange);
    };
  }, [hostRef]);

  const element = target?.element;
  const isOpen = Boolean(target?.isOpen);
  const title = target?.title;
  const card = target?.element.dataset.requestTooltipCard ? readTipCard(target.element.dataset.requestTooltipCard) : null;
  const failureEventId = Number(element?.dataset.requestFailure) || null;

  React.useLayoutEffect(() => {
    if (!element || !isOpen) return;
    const previousDescription = element.getAttribute('aria-describedby');
    element.setAttribute('aria-describedby', [previousDescription, popupId].filter(Boolean).join(' '));
    const observer = new MutationObserver(() => {
      const nextTitle = element.dataset.requestTooltip;
      setTarget((current) => {
        if (current?.element !== element || !current.isOpen) return current;
        if (!hostRef.current?.contains(element) || !nextTitle) return { ...current, isOpen: false };
        return current.title === nextTitle ? current : { ...current, title: nextTitle };
      });
    });
    if (hostRef.current) observer.observe(hostRef.current, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-request-tooltip'],
    });
    return () => {
      observer.disconnect();
      if (previousDescription === null) element.removeAttribute('aria-describedby');
      else element.setAttribute('aria-describedby', previousDescription);
    };
  }, [element, isOpen, popupId, hostRef]);

  if (!target) return null;

  const afterOpenChange = (hasOpened: boolean) => {
    if (hasOpened) return;
    noteHintClosed();
    setTarget((current) => current?.isOpen ? current : null);
  };

  if (failureEventId && title) {
    return (
      <Popover
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) setTarget((current) => (current?.isOpen ? { ...current, isOpen: false } : current));
        }}
        afterOpenChange={afterOpenChange}
      >
        <PopoverContent
          anchor={target.element}
          placement="bottomLeft"
          initialFocus={false}
          finalFocus={false}
          className={`${POPUP_CLASS} request-failure-tooltip relative`}
        >
          <RequestFailureDetail id={popupId} eventId={failureEventId} statusLabel={title} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <TooltipRoot open={isOpen} onOpenChangeComplete={afterOpenChange}>
      <TooltipContent id={popupId} anchor={target.element} side="top" sideOffset={6} className={card ? `${POPUP_CLASS} px-3 py-2` : POPUP_CLASS}>
        {card ? <TipCardView card={card} /> : title}
      </TooltipContent>
    </TooltipRoot>
  );
}
