import React from 'react';

interface Placement {
  top: number;
  height: number;
}

interface HighlightState {
  /** The layer that currently marks the selection; the other one is resting or fading out. */
  active: 0 | 1;
  key: string | null;
  group: string | null;
  layoutKey: string | null;
  placement: Placement | null;
  layerPlacements: [Placement | null, Placement | null];
}

function measureRow(frame: HTMLElement, key: string): Placement | null {
  const row = frame.querySelector<HTMLElement>(`[data-route-path="${CSS.escape(key)}"]`);
  if (!row) return null;
  const frameBox = frame.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.height === 0) return null;
  return { top: box.top - frameBox.top, height: box.height };
}

/** Keeps an externally selected or freshly revealed row inside the rail's scroll viewport. */
function revealRowIfClipped(frame: HTMLElement, key: string) {
  const viewport = frame.parentElement;
  if (!viewport || viewport.clientHeight === 0 || viewport.scrollHeight <= viewport.clientHeight) return;
  const row = frame.querySelector<HTMLElement>(`[data-route-path="${CSS.escape(key)}"]`);
  if (!row) return;
  const viewBox = viewport.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.height === 0) return;
  const edgeGap = 4;
  if (box.top < viewBox.top) {
    viewport.scrollTop = Math.max(0, viewport.scrollTop - (viewBox.top + edgeGap - box.top));
  } else if (box.bottom > viewBox.bottom) {
    viewport.scrollTop += box.bottom - (viewBox.bottom - edgeGap);
  }
}

function samePlacement(a: Placement | null, b: Placement | null): boolean {
  return a !== null && b !== null && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function applyPlacement(layer: HTMLElement, placement: Placement) {
  layer.style.transform = `translate3d(0, ${placement.top}px, 0)`;
  layer.style.height = `${placement.height}px`;
}

/** Moves a layer without letting its transition play: the move is a reflow, not a selection. */
function snap(layer: HTMLElement, placement: Placement, opacity: '0' | '1') {
  layer.style.transition = 'none';
  applyPlacement(layer, placement);
  layer.style.opacity = opacity;
  void layer.offsetWidth;
  layer.style.transition = '';
}

function hideImmediate(layer: HTMLElement) {
  layer.style.transition = 'none';
  layer.style.opacity = '0';
  void layer.offsetWidth;
  layer.style.transition = '';
}

/**
 * The selected navigation row's wash, drawn as a layer under the menu so it can travel.
 *
 * Within a group the wash slides to the new row: the eye follows one mark down a short list.
 * Across groups it would have to cross a group caption and the rows of another section, which
 * reads as a jump through unrelated entries, so the old wash fades out where it stands while a
 * second layer fades in on the new row. Two layers make that a cross-fade rather than a
 * fade-out-then-in, which would leave the rail without a selection for a moment.
 *
 * Layout changes - collapsing the rail, a plugin page appearing, the sheet opening - move the
 * wash with no transition, since the selection itself did not change. A reorder can move the
 * selected row without resizing anything, so `layoutKey` names the rail's order for that case.
 */
export function NavSelectionHighlight({ selectedKey, groupKey, layoutKey, children }: {
  selectedKey: string;
  groupKey: string | null;
  layoutKey: string;
  children: React.ReactNode;
}) {
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const layerRefs = [React.useRef<HTMLSpanElement | null>(null), React.useRef<HTMLSpanElement | null>(null)] as const;
  const stateRef = React.useRef<HighlightState>({
    active: 0,
    key: null,
    group: null,
    layoutKey: null,
    placement: null,
    layerPlacements: [null, null],
  });
  // Read by the resize observer, so it holds only the latest committed selection.
  const selectionRef = React.useRef({ selectedKey, groupKey, layoutKey });

  React.useLayoutEffect(() => {
    selectionRef.current = { selectedKey, groupKey, layoutKey };
    const frame = frameRef.current;
    const layers = [layerRefs[0].current, layerRefs[1].current];
    if (!frame || !layers[0] || !layers[1]) return;
    const state = stateRef.current;
    if (state.key !== selectedKey || state.layoutKey !== layoutKey) {
      revealRowIfClipped(frame, selectedKey);
    }
    const placement = measureRow(frame, selectedKey);
    const currentIndex = state.active;
    const otherIndex: 0 | 1 = currentIndex === 0 ? 1 : 0;
    const current = layers[currentIndex]!;
    const other = layers[otherIndex]!;

    if (!placement) {
      // The selected page is hidden from the rail or sits inside a closed sheet: nothing to mark.
      hideImmediate(current);
      hideImmediate(other);
      state.placement = null;
      state.key = null;
      state.group = null;
      state.layoutKey = layoutKey;
      state.layerPlacements = [null, null];
      return;
    }

    if (state.placement === null || state.key === selectedKey || state.layoutKey !== layoutKey) {
      hideImmediate(other);
      snap(current, placement, '1');
      state.layerPlacements[otherIndex] = null;
      state.layerPlacements[currentIndex] = placement;
    } else if (state.group === groupKey) {
      applyPlacement(current, placement);
      state.layerPlacements[currentIndex] = placement;
    } else {
      current.style.opacity = '0';
      state.active = otherIndex;
      if (samePlacement(state.layerPlacements[otherIndex], placement)) {
        // Clicking back onto a row whose previous wash is still fading out reverses its fade cleanly.
        other.style.opacity = '1';
      } else {
        snap(other, placement, '0');
        other.style.opacity = '1';
      }
      state.layerPlacements[otherIndex] = placement;
    }
    state.placement = placement;
    state.key = selectedKey;
    state.group = groupKey;
    state.layoutKey = layoutKey;
  }, [selectedKey, groupKey, layoutKey]);

  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const state = stateRef.current;
      const currentIndex = state.active;
      const otherIndex: 0 | 1 = currentIndex === 0 ? 1 : 0;
      const layer = layerRefs[currentIndex].current;
      const other = layerRefs[otherIndex].current;
      if (!layer || !other) return;
      const placement = measureRow(frame, selectionRef.current.selectedKey);
      if (!placement) {
        if (state.placement !== null) {
          hideImmediate(layer);
          hideImmediate(other);
          state.placement = null;
          state.layerPlacements = [null, null];
        }
        return;
      }
      if (samePlacement(placement, state.placement)) return;
      hideImmediate(other);
      snap(layer, placement, '1');
      state.placement = placement;
      state.key = selectionRef.current.selectedKey;
      state.group = selectionRef.current.groupKey;
      state.layoutKey = selectionRef.current.layoutKey;
      state.layerPlacements = currentIndex === 0 ? [placement, null] : [null, placement];
    });
    observer.observe(frame);
    const menu = frame.querySelector('.app-menu');
    if (menu) observer.observe(menu);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={frameRef} className="app-menu-frame">
      <span ref={layerRefs[0]} className="app-menu-highlight" aria-hidden="true" />
      <span ref={layerRefs[1]} className="app-menu-highlight" aria-hidden="true" />
      {children}
    </div>
  );
}
