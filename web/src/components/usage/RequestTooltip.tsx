import React from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from 'antd';
import type { TooltipRef } from 'antd/es/tooltip';

const TOOLTIP_INTENT_DELAY_MS = 100;

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
  const popupRef = React.useRef<TooltipRef>(null);
  const popupId = React.useId();

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;

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
      node instanceof Node && !!popupRef.current?.popupElement?.contains(node);
    const activate = (element: HTMLElement) => {
      cancelPending();
      const title = element.dataset.requestTooltip;
      if (!title || !host.contains(element)) return;
      // Geometry is needed only after intent, never while mounting all rows during navigation.
      const bounds = element.getBoundingClientRect();
      setTarget({ element, title, bounds, isOpen: true });
    };
    const dismiss = () => {
      cancelPending();
      setTarget((current) => current?.isOpen ? { ...current, isOpen: false } : current);
    };
    const handlePointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (isInsidePopup(event.target)) {
        cancelPending();
        return;
      }
      const element = findTarget(event.target);
      if (!element || element === hovered) return;
      hovered = element;
      cancelPending();
      pending = setTimeout(() => activate(element), TOOLTIP_INTENT_DELAY_MS);
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const next = findTarget(event.relatedTarget);
      if (next === hovered && next !== null) return;
      if (!findTarget(event.target) && !isInsidePopup(event.target)) return;
      hovered = null;
      if (isInsidePopup(event.relatedTarget)) return;
      cancelPending();
      pending = setTimeout(() => {
        if (focused) activate(focused);
        else dismiss();
      }, TOOLTIP_INTENT_DELAY_MS);
    };
    const handleFocusIn = (event: FocusEvent) => {
      focused = findTarget(event.target);
      if (focused) activate(focused);
    };
    const handleFocusOut = (event: FocusEvent) => {
      focused = findTarget(event.relatedTarget);
      if (focused) activate(focused);
      else if (hovered) activate(hovered);
      else dismiss();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!findTarget(event.target) && !isInsidePopup(event.target)) dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hovered = null;
        focused = null;
        dismiss();
      }
    };
    // Virtualized rows can disappear without pointerout; scroll and resize invalidate their anchors.
    const handleGeometryChange = () => {
      hovered = null;
      focused = null;
      dismiss();
    };
    document.addEventListener('pointerover', handlePointerOver);
    document.addEventListener('pointerout', handlePointerOut);
    host.addEventListener('focusin', handleFocusIn);
    host.addEventListener('focusout', handleFocusOut);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('scroll', handleGeometryChange, true);
    window.addEventListener('resize', handleGeometryChange);
    return () => {
      cancelPending();
      document.removeEventListener('pointerover', handlePointerOver);
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
  return createPortal(
    <Tooltip
      ref={popupRef}
      id={popupId}
      title={title}
      open={isOpen}
      trigger={[]}
      placement="top"
      classNames={{ root: 'request-cell-tooltip' }}
      destroyOnHidden
      afterOpenChange={(hasOpened) => {
        if (!hasOpened) setTarget((current) => current?.isOpen ? current : null);
      }}
    >
      <span
        aria-hidden="true"
        data-request-tooltip-anchor
        style={{
          position: 'fixed', pointerEvents: 'none',
          left: target.bounds.left, top: target.bounds.top,
          width: target.bounds.width, height: target.bounds.height,
        }}
      />
    </Tooltip>,
    document.body,
  );
}
