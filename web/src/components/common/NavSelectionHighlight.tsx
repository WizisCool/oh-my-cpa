import React from 'react';

interface Placement {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface HighlightState {
  /** The layer that currently marks the selection; the other one is resting or fading out. */
  active: 0 | 1;
  key: string | null;
  group: string | null;
  placement: Placement | null;
}

function measureRow(frame: HTMLElement, key: string): Placement | null {
  const row = frame.querySelector<HTMLElement>(`[data-route-path="${CSS.escape(key)}"]`);
  if (!row) return null;
  const frameBox = frame.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.height === 0) return null;
  return { top: box.top - frameBox.top, left: box.left - frameBox.left, width: box.width, height: box.height };
}

function samePlacement(a: Placement | null, b: Placement | null): boolean {
  return a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function applyPlacement(layer: HTMLElement, placement: Placement) {
  layer.style.transform = `translate3d(${placement.left}px, ${placement.top}px, 0)`;
  layer.style.width = `${placement.width}px`;
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
  const stateRef = React.useRef<HighlightState>({ active: 0, key: null, group: null, placement: null });
  // Read by the resize observer, so it holds only a committed selection.
  const selectionRef = React.useRef({ selectedKey, groupKey });

  React.useLayoutEffect(() => {
    selectionRef.current = { selectedKey, groupKey };
    const frame = frameRef.current;
    const layers = [layerRefs[0].current, layerRefs[1].current];
    if (!frame || !layers[0] || !layers[1]) return;
    const state = stateRef.current;
    const placement = measureRow(frame, selectedKey);
    const current = layers[state.active]!;
    if (!placement) {
      // The selected page is hidden from the rail: nothing to mark.
      current.style.opacity = '0';
      state.placement = null;
      state.key = null;
      state.group = null;
      return;
    }
    if (state.placement === null || state.key === selectedKey) {
      snap(current, placement, '1');
    } else if (state.group === groupKey) {
      applyPlacement(current, placement);
    } else {
      current.style.opacity = '0';
      state.active = state.active === 0 ? 1 : 0;
      const next = layers[state.active]!;
      snap(next, placement, '0');
      next.style.opacity = '1';
    }
    state.placement = placement;
    state.key = selectedKey;
    state.group = groupKey;
  }, [selectedKey, groupKey, layoutKey]);

  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const state = stateRef.current;
      const layer = layerRefs[state.active].current;
      if (!layer) return;
      const placement = measureRow(frame, selectionRef.current.selectedKey);
      if (!placement || samePlacement(placement, state.placement)) return;
      snap(layer, placement, '1');
      state.placement = placement;
      state.key = selectionRef.current.selectedKey;
      state.group = selectionRef.current.groupKey;
    });
    observer.observe(frame);
    const menu = frame.querySelector('.ant-menu');
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
