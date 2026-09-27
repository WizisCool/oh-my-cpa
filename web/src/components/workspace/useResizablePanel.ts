import React from 'react';

export interface ResizablePanelOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

export interface ResizablePanel {
  width: number;
  /** Attach to the panel whose width is being dragged, so a drag can write it without a render. */
  panelRef: React.RefObject<HTMLElement>;
  separatorProps: React.HTMLAttributes<HTMLDivElement> & {
    role: 'separator';
    tabIndex: number;
    'aria-orientation': 'vertical';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
  };
  isResizing: boolean;
}

const KEYBOARD_STEP = 16;
/**
 * The panel never takes more than half the viewport.
 *
 * The conversation is the page's subject; a panel dragged past this point leaves a transcript
 * column narrower than a code block, and the reader has to drag it back before they can read.
 */
const MAX_VIEWPORT_SHARE = 0.5;

/**
 * A right-hand panel the reader can resize with a pointer or the keyboard.
 *
 * A drag writes the width straight onto the panel element and commits it to state once, when the
 * pointer is released. Committing on every `pointermove` would re-render the whole workspace - the
 * transcript included - up to 120 times a second for a gesture that changes one number. Pointer
 * events with capture, rather than mouse events on `window`, so a pen or a touch drag works and a
 * release outside the window still ends the drag.
 *
 * The separator is a focusable ARIA window splitter: arrows step it, Home and End jump to the
 * bounds, and a double click restores the default.
 */
export function useResizablePanel({ defaultWidth, minWidth, maxWidth }: ResizablePanelOptions): ResizablePanel {
  const [width, setWidth] = React.useState(defaultWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const panelRef = React.useRef<HTMLElement>(null);

  const clamp = React.useCallback((value: number) => {
    const ceiling = Math.max(minWidth, Math.min(maxWidth, Math.floor(window.innerWidth * MAX_VIEWPORT_SHARE)));
    return Math.round(Math.max(minWidth, Math.min(ceiling, value)));
  }, [minWidth, maxWidth]);

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? width;
    let latest = startWidth;
    let frame = 0;
    setIsResizing(true);

    const onMove = (move: PointerEvent) => {
      latest = clamp(startWidth + startX - move.clientX);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (panelRef.current) panelRef.current.style.width = `${latest}px`;
      });
    };
    const onEnd = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      setIsResizing(false);
      setWidth(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }, [clamp, width]);

  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = width + KEYBOARD_STEP; break;
      case 'ArrowRight': next = width - KEYBOARD_STEP; break;
      case 'Home': next = minWidth; break;
      case 'End': next = maxWidth; break;
      default: return;
    }
    event.preventDefault();
    setWidth(clamp(next));
  }, [clamp, maxWidth, minWidth, width]);

  const onDoubleClick = React.useCallback(() => setWidth(clamp(defaultWidth)), [clamp, defaultWidth]);

  return {
    width,
    panelRef,
    isResizing,
    separatorProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-valuenow': width,
      'aria-valuemin': minWidth,
      'aria-valuemax': maxWidth,
      onPointerDown,
      onKeyDown,
      onDoubleClick,
    },
  };
}
