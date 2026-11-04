import React from 'react';
import clsx from 'clsx';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useSortableMotion } from '../../hooks/useSortableMotion';
import { HolderOutlined } from '../icons';
import { Tooltip } from './Tooltip';
import { useT } from '../../i18n';
import { applyKeyOrder, moveKey, type DropSide } from '../../types/displayOrder';

interface ReorderState {
  isEnabled: boolean;
  onStep: (key: string, direction: -1 | 1) => void;
}

const ReorderContext = React.createContext<ReorderState>({ isEnabled: false, onStep: () => undefined });

/** The list runs one way and has two ends: a row travels up or down, and no further than the list. */
const alongTheList: Modifier = ({ transform, draggingNodeRect, containerNodeRect }) => {
  if (!draggingNodeRect || !containerNodeRect) return { ...transform, x: 0 };
  const top = containerNodeRect.top - draggingNodeRect.top;
  const bottom = containerNodeRect.bottom - draggingNodeRect.bottom;
  return { ...transform, x: 0, y: Math.min(Math.max(transform.y, top), bottom) };
};
const MODIFIERS = [alongTheList];

export interface RowReorderProps {
  /** The rows' keys in the order they are drawn. */
  items: readonly string[];
  /** False while the list is in an order the operator did not set, such as a column sort. */
  isEnabled: boolean;
  /** Where a dropped row landed: beside `target`, on the side it was moved towards. */
  onMove: (key: string, target: string, side: DropSide) => void;
  /** A keyboard move from the focused handle: one place earlier or later. */
  onStep: (key: string, direction: -1 | 1) => void;
  children: React.ReactNode;
}

/**
 * Rows the operator reorders from a handle, sorted live: the row in hand follows the pointer, the
 * others make room as it passes them, and the drop keeps the order on screen. Only the handle starts
 * a drag, so pointing at, clicking or selecting text in a row never rearranges anything. A focused
 * handle moves its row a place with the arrow keys.
 */
export function RowReorder({ items, isEnabled, onMove, onStep, children }: RowReorderProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = React.useMemo(() => [...items], [items]);

  const handleStart = () => document.body.classList.add('is-row-dragging');
  const finish = () => document.body.classList.remove('is-row-dragging');
  const handleEnd = ({ active, over }: DragEndEvent) => {
    finish();
    if (!over || over.id === active.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onMove(String(active.id), String(over.id), from < to ? 'after' : 'before');
  };

  const value = React.useMemo(() => ({ isEnabled, onStep }), [isEnabled, onStep]);
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={MODIFIERS} onDragStart={handleStart} onDragEnd={handleEnd} onDragCancel={finish}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!isEnabled}>
        <ReorderContext.Provider value={value}>{children}</ReorderContext.Provider>
      </SortableContext>
    </DndContext>
  );
}

/**
 * The rows in the order to draw them, and the move a drop makes.
 *
 * A drop has to show the new order in the same frame the drag lets go of the rows, or they slide back
 * to their old places and then jump to the new ones when the stored order arrives a tick later. So
 * the order the drop chose is held here until the list it was made from changes (the stored order
 * has arrived) or the write settles (it may have been refused and rolled back).
 */
export function useReorderList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  onMove: (key: string, target: string, side: DropSide) => unknown,
): { ordered: readonly T[]; move: (key: string, target: string, side: DropSide) => void } {
  const signature = items.map(keyOf).join('\u0000');
  const [pending, setPending] = React.useState<{ signature: string; keys: readonly string[] } | null>(null);
  const held = pending?.signature === signature ? pending : null;
  const ordered = React.useMemo(() => (held ? applyKeyOrder(items, keyOf, held.keys) : items), [held, items, keyOf]);
  const move = (key: string, target: string, side: DropSide) => {
    const keys = ordered.map(keyOf);
    const next = moveKey(keys, key, target, side);
    if (next === keys) return;
    const hold = { signature, keys: next };
    setPending(hold);
    void Promise.resolve(onMove(key, target, side)).finally(() => setPending((current) => (current === hold ? null : current)));
  };
  return { ordered, move };
}

export interface ReorderRow {
  /** Spread on the row: its node, its travel and whether it is the row in hand. */
  row: {
    ref: (element: HTMLElement | null) => void;
    style?: React.CSSProperties;
    'data-reorder-key': string;
    'data-dragging'?: 'true';
  };
  /** Passed to the row's `ReorderHandle`. */
  handle: ReorderHandleProps;
}

/** One row's part in the reorder: the row's props and its handle's. */
export function useReorderRow(key: string): ReorderRow {
  const { isEnabled, onStep } = React.useContext(ReorderContext);
  const motion = useSortableMotion();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: key, disabled: !isEnabled, ...motion });
  const style: React.CSSProperties | undefined = transform || transition
    ? { transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined, transition }
    : undefined;
  return {
    row: {
      ref: setNodeRef,
      style,
      'data-reorder-key': key,
      'data-dragging': isDragging ? 'true' : undefined,
    },
    handle: {
      isEnabled,
      isDragging,
      activatorRef: setActivatorNodeRef,
      onPointerDown: listeners?.onPointerDown as React.PointerEventHandler | undefined,
      onStep: (direction) => onStep(key, direction),
    },
  };
}

export interface ReorderHandleProps {
  isEnabled: boolean;
  isDragging: boolean;
  activatorRef: (element: HTMLElement | null) => void;
  onPointerDown?: React.PointerEventHandler;
  onStep: (direction: -1 | 1) => void;
}

/**
 * The grip a row is dragged by. On a wide screen it takes no width: it is a strip along the row's
 * leading edge that stays out of sight until the pointer reaches that edge, or the keyboard focuses
 * it, so a list that is rarely rearranged does not carry a column of grips. `inline` is the phone's
 * form, where no pointer can reveal it: a glyph at the end of the row's controls.
 */
export function ReorderHandle({
  isEnabled, isDragging, activatorRef, onPointerDown, onStep, name, variant = 'edge', className,
}: ReorderHandleProps & { name: string; variant?: 'edge' | 'inline'; className?: string }) {
  const t = useT();
  if (!isEnabled) return null;
  const button = (
    <button
      type="button"
      ref={activatorRef}
      className={clsx('reorder-handle', `is-${variant}`, isDragging && 'is-active', className)}
      aria-label={`${t('common.reorder_handle')}: ${name}`}
      aria-keyshortcuts="ArrowUp ArrowDown"
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        onStep(event.key === 'ArrowUp' ? -1 : 1);
      }}
      onClick={(event) => event.stopPropagation()}
      data-reorder-handle
    >
      <HolderOutlined aria-hidden="true" />
    </button>
  );
  return isDragging ? button : <Tooltip title={t('common.reorder_handle')}>{button}</Tooltip>;
}

/**
 * A table whose rows are rendered by a library (an Ant Design body row) cannot hand the handle's
 * props to the cell that draws it, so the row publishes them here and the cell reads them.
 */
export const RowHandleContext = React.createContext<ReorderHandleProps | null>(null);

/** The handle of the row this cell is in; nothing outside a reorderable row. */
export function RowContextHandle({ name, variant, className }: { name: string; variant?: 'edge' | 'inline'; className?: string }) {
  const handle = React.useContext(RowHandleContext);
  return handle ? <ReorderHandle {...handle} name={name} variant={variant} className={className} /> : null;
}
