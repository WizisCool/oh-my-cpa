import React from 'react';
import { createPortal } from 'react-dom';
import { Popover, Tooltip } from 'antd';
import { RequestFailureDetail } from './RequestFailureDetail';
import { hoverIntentDelay, noteHintClosed } from '../common/tooltipIntent';
import './requestMarks.css';

/** The grace for moving between cells, or from a cell into its popup, without the popup closing. */
const TOOLTIP_SWITCH_DELAY_MS = 100;
/** The class both popups carry on their root; the page has one of them at a time. */
const POPUP_CLASS = 'request-cell-tooltip';

/** Plain cells keep the virtualized mount cheap; one list-owned popup reads their current labels. */
export function RequestTooltip({ title, children }: {
  title: string;
  children: React.ReactElement<{ 'data-request-tooltip'?: string }>;
}) {
  return React.cloneElement(children, { 'data-request-tooltip': title });
}

interface TooltipTarget {
  element: HTMLElement;
  title: string;
  bounds: DOMRect;
  isOpen: boolean;
}

export function RequestTooltipLayer({ hostRef }: { hostRef: React.RefObject<HTMLDivElement> }) {
  const [target, setTarget] = React.useState<TooltipTarget | null>(null);
  const popupId = React.useId();

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    // A pressed cell keeps its popup down until the pointer leaves it: the press was the reader
    // acting on the cell, not asking what it is.
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
    // Asked of the document rather than of the popup's ref: antd builds that
    // handle when the anchor mounts, before the popup exists, so its
    // `popupElement` stays undefined until some later render and a pointer
    // entering the popup in the meantime read as one leaving the cell.
    const isInsidePopup = (node: EventTarget | null) =>
      node instanceof Element && node.closest(`.${POPUP_CLASS}`) !== null;
    const activate = (element: HTMLElement) => {
      cancelPending();
      const title = element.dataset.requestTooltip;
      if (!title || !host.contains(element)) return;
      // Geometry is needed only after intent, never while mounting all rows during navigation.
      const bounds = element.getBoundingClientRect();
      isShowing = true;
      setTarget({ element, title, bounds, isOpen: true });
    };
    const dismiss = () => {
      cancelPending();
      isShowing = false;
      setTarget((current) => current?.isOpen ? { ...current, isOpen: false } : current);
    };
    // Movement, not `pointerover`: rows scrolled or refreshed under a still pointer report it over a
    // new cell, and a popup rising there answers nobody.
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
        // A refresh may have redrawn the cell during the wait; the pointer resting where it was is
        // still asking about whatever cell is under it now.
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
    // Keyboard focus only: a click focuses what it pressed too, and that is not a request to read it.
    const handleFocusIn = (event: FocusEvent) => {
      const element = findTarget(event.target);
      focused = element && element.matches(':focus-visible') ? element : null;
      if (focused) activate(focused);
    };
    // Where focus goes next answers for itself in `focusin`; a popup a resting pointer opened stays.
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
    // Virtualized rows can disappear without pointerout; scroll and resize invalidate their anchors.
    const handleGeometryChange = (event: Event) => {
      // The popup's own content scrolls: reading a long error body is not the list moving.
      if (isInsidePopup(event.target)) return;
      hovered = null;
      focused = null;
      dismiss();
    };
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerout', handlePointerOut);
    host.addEventListener('focusin', handleFocusIn);
    host.addEventListener('focusout', handleFocusOut);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('scroll', handleGeometryChange, true);
    window.addEventListener('resize', handleGeometryChange);
    return () => {
      cancelPending();
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerout', handlePointerOut);
      host.removeEventListener('focusin', handleFocusIn);
      host.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('scroll', handleGeometryChange, true);
      window.removeEventListener('resize', handleGeometryChange);
    };
  }, [hostRef]);

  const element = target?.element;
  const isOpen = target?.isOpen;
  const title = target?.title;
  // A failed pill names its record: the popup then explains the failure instead
  // of repeating the label, and stays plain text for every other cell.
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
        return current.title === nextTitle ? current : { ...current, title: nextTitle, bounds: element.getBoundingClientRect() };
      });
    });
    // A refresh may recycle the same cell or remove it, without moving the pointer or focus.
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
  const anchor = (
    <span
      aria-hidden="true"
      data-request-tooltip-anchor
      style={{
        position: 'fixed', pointerEvents: 'none',
        left: target.bounds.left, top: target.bounds.top,
        width: target.bounds.width, height: target.bounds.height,
      }}
    />
  );
  const afterOpenChange = (hasOpened: boolean) => {
    if (hasOpened) return;
    noteHintClosed();
    setTarget((current) => current?.isOpen ? current : null);
  };
  // A failure is read and copied from, so it is a floating panel on the console's
  // own surface; a label stays the compact tooltip every other cell uses.
  return createPortal(
    failureEventId && title ? (
      <Popover
        content={<RequestFailureDetail id={popupId} eventId={failureEventId} statusLabel={title} />}
        open={isOpen}
        trigger={[]}
        placement="bottomLeft"
        arrow={false}
        classNames={{ root: `${POPUP_CLASS} request-failure-tooltip` }}
        destroyOnHidden
        afterOpenChange={afterOpenChange}
      >
        {anchor}
      </Popover>
    ) : (
      <Tooltip
        id={popupId}
        title={title}
        open={isOpen}
        trigger={[]}
        placement="top"
        classNames={{ root: POPUP_CLASS }}
        destroyOnHidden
        afterOpenChange={afterOpenChange}
      >
        {anchor}
      </Tooltip>
    ),
    document.body,
  );
}
