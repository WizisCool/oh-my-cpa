import type { MessageKey } from '../../i18n/catalog';
import React from 'react';
import clsx from 'clsx';
import { Button } from 'antd';
import { EyeInvisibleOutlined, HolderOutlined, LeftOutlined, PlusOutlined, RightOutlined } from '../icons';
import { useT } from '../../i18n';
import {
  DASHBOARD_GAP_PX,
  DASHBOARD_MAX_ROWS,
  DASHBOARD_ROW_PX,
  dashboardWidgetSpec,
  moveDashboardWidget,
  resizeDashboardWidget,
  rowsForHeight,
  setDashboardWidgetHidden,
  stepDashboardWidget,
  type DashboardLayout,
  type DashboardLayoutItem,
  type DashboardWidgetId,
  type DashboardWidgetSpan,
} from '../../types/dashboardLayout';
import styles from './DashboardBoard.module.css';
import './dashboardGrid.css';
import { Tooltip } from '../common/Tooltip';
import { useSortGuard } from '../common/sortGuard';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable } from '@dnd-kit/sortable';
import { glideWhileSorting, useSortableMotion } from '../../hooks/useSortableMotion';
import { AnimatePresence, INSTANT, MotionScope, m, useIsPresent, useSpringTransition } from '../../motion';

export interface DashboardBoardProps {
  layout: DashboardLayout;
  /** True while the operator is arranging the board; the arrangement then lives in `onChange`'s draft. */
  isEditing: boolean;
  isPhone: boolean;
  /** Draws one widget, or nothing when it has nothing to show yet. */
  renderWidget: (id: DashboardWidgetId) => React.ReactNode;
  onChange: (next: DashboardLayout) => void;
}

const SPAN_LABEL_KEYS: Record<DashboardWidgetSpan, MessageKey> = {
  1: 'dash.layout.span_1',
  2: 'dash.layout.span_2',
  3: 'dash.layout.span_3',
  4: 'dash.layout.span_4',
};

/** The board reflows itself as the order changes, so no cell is shifted by an offset of its own. */
const REFLOW = () => null;
const MEASURE = { droppable: { strategy: MeasuringStrategy.Always } };

/**
 * The widget under the pointer, not the one whose centre is nearest: widgets of different sizes put
 * a small one's centre closer to the pointer than the large one it is over, and the board would swap
 * them back and forth. Between widgets the nearest centre still decides.
 */
const underThePointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

/** The widget in hand stays over the board it is being arranged on. */
const withinTheBoard: Modifier = ({ transform, draggingNodeRect, containerNodeRect }) => {
  if (!draggingNodeRect || !containerNodeRect) return transform;
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
  return {
    ...transform,
    x: clamp(transform.x, containerNodeRect.left - draggingNodeRect.left, containerNodeRect.right - draggingNodeRect.right),
    y: clamp(transform.y, containerNodeRect.top - draggingNodeRect.top, containerNodeRect.bottom - draggingNodeRect.bottom),
  };
};
const OVERLAY_MODIFIERS = [withinTheBoard];

/**
 * DashboardBoard lays the dashboard's widgets on one four-column grid, in the operator's order and
 * at the operator's widths, and is also where that arrangement is edited.
 *
 * Editing is a mode rather than a permanent affordance: a dashboard is read far more often than it is
 * arranged, so the handles, width controls and hide buttons appear only while the operator is
 * arranging it, and the widgets underneath stop taking input so a drag cannot open a drill-down.
 * Reordering is a drag on the handle and, for keyboard and touch, a step earlier or later; both write
 * the same arrangement. A widget is resized from its edges on the board's grid: the right edge snaps
 * to the widths the widget offers, the bottom edge to whole rows, the corner to both, and the board
 * reflows at every step so the operator sees the arrangement the size makes. A widget is never made
 * shorter than its content: a box that small would only be stretched back by the row.
 *
 * A drag rearranges the board as it goes: the widgets are of different widths, so rather than sliding
 * cells by offsets that would overlap, the grid reflows in the order the hand proposes and every
 * widget the reflow moved glides there from where it was. The widget itself follows the pointer,
 * whole and at its own size, and the place it will land stays open as an outline. The drop commits
 * the order already on screen, so nothing moves when the hand lets go.
 *
 * Every other change to the arrangement - a resize, a step earlier or later, hiding or restoring a
 * widget - reflows the board too, and the widgets the reflow moved glide there as well (Motion's
 * layout animation, position only: a widget is never scaled to its old size). A hidden widget fades
 * out where it stood while the rest close up; a restored one fades in as they make room. Only an
 * arrangement being edited moves: a board read normally takes its places as its data arrives.
 */
export const DashboardBoard: React.FC<DashboardBoardProps> = ({ layout, isEditing, isPhone, renderWidget, onChange }) => {
  const t = useT();
  const [dragId, setDragId] = React.useState<DashboardWidgetId | null>(null);
  // The order the hand is proposing; the arrangement is written only when the widget is let go.
  const [preview, setPreview] = React.useState<DashboardWidgetId[] | null>(null);
  // A widget is a large target, so a press that wanders a little is still a press, not a move.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const guard = useSortGuard();
  // The widget being resized and the size it has reached, for the badge that reads it out.
  const [resizing, setResizing] = React.useState<{ id: DashboardWidgetId; span: DashboardWidgetSpan; rows: number } | null>(null);
  // A keyboard resize is announced from a region that stays mounted: a live region that appears
  // with its text, as the size badge does, is not reliably read, and the badge leaves on key up.
  const [sizeAnnouncement, setSizeAnnouncement] = React.useState('');
  // A key that meets a limit leaves the text as it was, and an unchanged region is not read again,
  // so each announcement clears the region and writes the text a frame later.
  const announceFrame = React.useRef(0);
  const announceSize = (text: string) => {
    cancelAnimationFrame(announceFrame.current);
    setSizeAnnouncement('');
    announceFrame.current = requestAnimationFrame(() => setSizeAnnouncement(text));
  };
  React.useEffect(() => () => cancelAnimationFrame(announceFrame.current), []);
  const latestLayout = React.useRef(layout);
  latestLayout.current = layout;

  const isMounted = React.useCallback(
    (item: DashboardLayoutItem) => !(isPhone && dashboardWidgetSpec(item.id).isPhoneOmitted),
    [isPhone],
  );
  const isShown = React.useCallback((item: DashboardLayoutItem) => !item.hidden && isMounted(item), [isMounted]);
  const shown = layout.filter(isShown);
  const hidden = layout.filter((item) => item.hidden && isMounted(item));

  const shownIds = shown.map((item) => item.id);
  const ordered = preview
    ? preview.map((id) => shown.find((item) => item.id === id)).filter((item): item is DashboardLayoutItem => Boolean(item))
    : shown;

  const endDrag = () => {
    setDragId(null);
    setPreview(null);
  };
  const handleStart = (event: DragStartEvent) => {
    guard.reset();
    setDragId(event.active.id as DashboardWidgetId);
    setPreview(shownIds);
  };
  // Evaluated on every move as well as when the widget under the pointer changes: a swap the guard
  // held back while the board reflowed happens once the hand moves on, still over the same widget.
  const handleMove = ({ active, over, delta }: DragMoveEvent) => {
    if (!over || !guard.shouldSwap(String(active.id), String(over.id), delta)) return;
    setPreview((current) => {
      if (!current) return current;
      const from = current.indexOf(active.id as DashboardWidgetId);
      const to = current.indexOf(over.id as DashboardWidgetId);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
  };
  const handleEnd = ({ active }: DragEndEvent) => {
    const order = preview;
    endDrag();
    const id = active.id as DashboardWidgetId;
    const index = order?.indexOf(id) ?? -1;
    if (!order || index < 0 || order.join() === shownIds.join()) return;
    // Placed after the widget now before it, or before the one after it when it leads the board.
    onChange(index > 0 ? moveDashboardWidget(layout, id, order[index - 1], 'after') : moveDashboardWidget(layout, id, order[1], 'before'));
  };
  const dragged = dragId ? shown.find((item) => item.id === dragId) : undefined;

  const spanLabel = (span: DashboardWidgetSpan) => t(SPAN_LABEL_KEYS[span]);

  const resize = (item: DashboardLayoutItem, cell: HTMLElement, axis: ResizeAxis, input: { dx: number; dy: number; startRows: number } | { key: string }) => {
    const grid = cell.parentElement;
    if (!grid) return;
    const spec = dashboardWidgetSpec(item.id);
    const metrics = boardMetrics(grid);
    const box = cell.getBoundingClientRect();
    const current = latestLayout.current.find((entry) => entry.id === item.id) ?? item;
    // A board folded to two columns draws widths its own way, so only the four-column board takes one.
    const canWiden = metrics.columns === 4 && axis !== 'y' && spec.spans.length > 1;
    const canHeighten = axis !== 'x';
    let span = current.span;
    let rows = current.rows;
    if ('key' in input) {
      const index = spec.spans.indexOf(current.span);
      if (canWiden && input.key === 'ArrowRight') span = spec.spans[Math.min(index + 1, spec.spans.length - 1)];
      if (canWiden && input.key === 'ArrowLeft') span = spec.spans[Math.max(index - 1, 0)];
      if (canHeighten && input.key === 'ArrowDown') rows = current.rows + 1;
      if (canHeighten && input.key === 'ArrowUp') rows = current.rows - 1;
    } else {
      if (canWiden) span = nearestSpan(spec.spans, settle((box.width + input.dx + metrics.gap) / (metrics.column + metrics.gap), current.span));
      // Height is counted in rows from where the drag started, not read off the box: a card fitted
      // to its content is taller than its rows, so its box would already read as part of the next row.
      if (canHeighten) rows = settle(input.startRows + input.dy / (DASHBOARD_ROW_PX + DASHBOARD_GAP_PX), current.rows);
    }
    rows = Math.min(Math.max(rows, naturalRows(cell)), DASHBOARD_MAX_ROWS);
    setResizing({ id: item.id, span, rows });
    if ('key' in input) announceSize(`${t(spec.labelKey)}: ${t('dash.layout.size', { width: spanLabel(span), rows })}`);
    const next = resizeDashboardWidget(latestLayout.current, item.id, { span, rows });
    if (next !== latestLayout.current) onChange(next);
  };

  const startResize = (event: React.PointerEvent<HTMLElement>, item: DashboardLayoutItem, axis: ResizeAxis) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const cell = event.currentTarget.closest<HTMLElement>('.dashboard-cell');
    if (!cell) return;
    // The size is measured from where the drag started, so the step the pointer crossed is the one
    // the widget takes however many reflows the board made on the way.
    const origin = { x: event.clientX, y: event.clientY };
    const start = cell.getBoundingClientRect();
    const startRows = (latestLayout.current.find((entry) => entry.id === item.id) ?? item).rows;
    let isMoving = false;
    const move = (moveEvent: PointerEvent) => {
      // A press on a grip is not a resize until the hand has clearly moved.
      if (!isMoving && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < RESIZE_START_PX) return;
      isMoving = true;
      const now = cell.getBoundingClientRect();
      resize(item, cell, axis, { dx: moveEvent.clientX - origin.x - (now.width - start.width), dy: moveEvent.clientY - origin.y, startRows });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('is-board-resizing', `is-resizing-${axis}`);
      setResizing(null);
      // A narrower widget can need more rows than it was given on the way; the drop gives it them.
      requestAnimationFrame(() => {
        const settled = latestLayout.current.find((entry) => entry.id === item.id);
        const needed = cell.isConnected ? naturalRows(cell) : 0;
        if (settled && settled.rows < needed) onChange(resizeDashboardWidget(latestLayout.current, item.id, { rows: needed }));
      });
    };
    document.body.classList.add('is-board-resizing', `is-resizing-${axis}`);
    const current = latestLayout.current.find((entry) => entry.id === item.id) ?? item;
    setResizing({ id: item.id, span: current.span, rows: current.rows });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <>
      {isEditing && (
        <div className={styles['tray']} data-testid="dashboard-layout-tray">
          <span className={styles['tray-hint']}>{t(isPhone ? 'dash.layout.hint_touch' : 'dash.layout.hint')}</span>
          {hidden.length > 0 && (
            <div className={styles['tray-hidden']} role="group" aria-label={t('dash.layout.hidden_label')}>
              <span className={styles['tray-hidden-label']}>{t('dash.layout.hidden_label')}</span>
              {hidden.map((item) => (
                <Button
                  key={item.id}
                  size="small"
                  icon={<PlusOutlined />}
                  data-widget-restore={item.id}
                  onClick={() => onChange(setDashboardWidgetHidden(layout, item.id, false))}
                >
                  {t(dashboardWidgetSpec(item.id).labelKey)}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={underThePointer} measuring={MEASURE} onDragStart={handleStart} onDragMove={handleMove} onDragOver={handleMove} onDragEnd={handleEnd} onDragCancel={endDrag}>
      <SortableContext items={ordered.map((item) => item.id)} strategy={REFLOW} disabled={!isEditing || isPhone}>
      {isEditing && <span className="sr-only" aria-live="polite" data-testid="dashboard-size-announcement">{sizeAnnouncement}</span>}
      <MotionScope features="layout">
      <div className="dashboard-grid" data-testid="dashboard-board">
        {/* `custom` tells a leaving widget whether it left an arrangement being edited. */}
        <AnimatePresence initial={false} mode="popLayout" custom={isEditing}>
        {ordered.map((item, index) => {
          const spec = dashboardWidgetSpec(item.id);
          const content = renderWidget(item.id);
          if (!isEditing && (content === null || content === undefined || content === false)) return null;
          const label = t(spec.labelKey);
          return (
            <SortableCell
              key={item.id}
              id={item.id}
              isEditing={isEditing}
              // dnd-kit draws the glides of a drag itself; Motion takes every other reflow.
              canGlide={isEditing && dragId === null}
              className={clsx('dashboard-cell', isEditing && styles['cell'], dragId === item.id && styles['is-placeholder'], resizing?.id === item.id && styles['is-resizing'])}
              rows={item.rows}
              data-widget={item.id}
              data-widget-kind={spec.isMetric ? 'metric' : 'panel'}
              data-span={item.span}
              data-rows={item.rows}
            >
              {(handle) => (<>
              {isEditing && (
                <div className={styles['toolbar']}>
                  <div className={styles['toolbar-row']}>
                    {!isPhone && (
                      <Tooltip title={t('dash.layout.drag')}>
                        <span
                          ref={handle.ref}
                          className={styles['handle']}
                          data-drag-handle
                          aria-hidden="true"
                          onPointerDown={handle.onPointerDown}
                        >
                          <HolderOutlined />
                        </span>
                      </Tooltip>
                    )}
                    <span className={styles['name']} title={label}>{label}</span>
                    <Tooltip title={t('dash.layout.move_earlier')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<LeftOutlined />}
                        aria-label={`${t('dash.layout.move_earlier')} · ${label}`}
                        disabled={index === 0}
                        onClick={() => onChange(stepDashboardWidget(layout, item.id, -1, isShown))}
                      />
                    </Tooltip>
                    <Tooltip title={t('dash.layout.move_later')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<RightOutlined />}
                        aria-label={`${t('dash.layout.move_later')} · ${label}`}
                        disabled={index === ordered.length - 1}
                        onClick={() => onChange(stepDashboardWidget(layout, item.id, 1, isShown))}
                      />
                    </Tooltip>
                    <Tooltip title={t('dash.layout.hide')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<EyeInvisibleOutlined />}
                        aria-label={`${t('dash.layout.hide')} · ${label}`}
                        data-widget-hide={item.id}
                        onClick={() => onChange(setDashboardWidgetHidden(layout, item.id, true))}
                      />
                    </Tooltip>
                  </div>
                </div>
              )}
              {/* A phone draws every widget at its content's height on its two columns, so a size
                  chosen there would change nothing on screen; resizing is a desktop control. */}
              {isEditing && !isPhone && (
                <>
                  <span className={clsx(styles['grip'], styles['grip-x'])} data-resize="x" aria-hidden="true" onPointerDown={(event) => startResize(event, item, 'x')} />
                  <span className={clsx(styles['grip'], styles['grip-y'])} data-resize="y" aria-hidden="true" onPointerDown={(event) => startResize(event, item, 'y')} />
                  <Tooltip title={t('dash.layout.resize')}>
                    <button
                      type="button"
                      className={clsx(styles['grip'], styles['grip-xy'])}
                      data-resize="xy"
                      aria-label={`${t('dash.layout.resize')} · ${label}`}
                      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
                      onPointerDown={(event) => startResize(event, item, 'xy')}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                        event.preventDefault();
                        const cell = event.currentTarget.closest<HTMLElement>('.dashboard-cell');
                        if (cell) resize(item, cell, 'xy', { key: event.key });
                      }}
                      onKeyUp={() => setResizing(null)}
                      onBlur={() => setResizing(null)}
                    />
                  </Tooltip>
                  {resizing?.id === item.id && (
                    <span className={styles['size-badge']} aria-hidden="true">
                      {t('dash.layout.size', { width: spanLabel(resizing.span), rows: resizing.rows })}
                    </span>
                  )}
                </>
              )}
              {isEditing ? (
                <div className={styles['content']} ref={markInert}>
                  {content ?? <div className={styles['empty']}>{label}</div>}
                </div>
              ) : content}
              </>)}
            </SortableCell>
          );
        })}
        </AnimatePresence>
        {isEditing && shown.length === 0 && (
          <div className={styles['board-empty']}>{t('dash.layout.all_hidden')}</div>
        )}
      </div>
      </MotionScope>
      </SortableContext>
      <DragOverlay dropAnimation={null} modifiers={OVERLAY_MODIFIERS}>
        {dragged ? (
          <div className={styles['lifted']} data-span={dragged.span}>
            <div className={styles['lifted-head']}>
              <HolderOutlined aria-hidden="true" />
              <span className={styles['name']}>{t(dashboardWidgetSpec(dragged.id).labelKey)}</span>
            </div>
            <div className={styles['content']} ref={markInert}>
              {renderWidget(dragged.id) ?? <div className={styles['empty']}>{t(dashboardWidgetSpec(dragged.id).labelKey)}</div>}
            </div>
          </div>
        ) : null}
      </DragOverlay>
      </DndContext>
    </>
  );
};

/**
 * The widget under the editing chrome is a picture of itself: it must not take a click, a focus or a
 * screen reader's attention while the operator is moving it. `inert` says all three at once, and
 * React 18 does not know the attribute, so it is set on the element directly.
 */
function markInert(element: HTMLDivElement | null) {
  element?.setAttribute('inert', '');
}

interface CellHandle {
  ref: (element: HTMLElement | null) => void;
  onPointerDown?: React.PointerEventHandler;
}

type SortableCellProps = Omit<React.HTMLAttributes<HTMLDivElement>,
  'children' | 'id' | 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'> & {
  id: DashboardWidgetId;
  rows: number;
  /** The arrangement is being edited, so the widget's coming and going is animated. */
  isEditing: boolean;
  /** The widget glides to a place a reflow gave it; off while a drag draws its own glides. */
  canGlide: boolean;
  children: (handle: CellHandle) => React.ReactNode;
} & Record<`data-${string}`, string | number | undefined>;

const CELL_SHOWN = { opacity: 1 };

/**
 * One widget's cell: the node the board sorts, with its handle's wiring for the toolbar it draws.
 * It forwards its node because the board's presence lifts a leaving cell out of the grid by it.
 */
const SortableCell = React.forwardRef<HTMLDivElement, SortableCellProps>(function SortableCell({ id, rows, isEditing, canGlide, children, ...attributes }, forwardedRef) {
  const settle = useSpringTransition('settle');
  const leave = useSpringTransition('leave');
  // Kept by identity across renders: a fresh target would read to Motion as a new one and pull
  // against a leaving cell's exit.
  const variants = React.useMemo(() => ({
    hidden: (isEdited: boolean) => ({ opacity: 0, transition: isEdited ? leave : INSTANT }),
  }), [leave]);
  const motion = useSortableMotion();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition } = useSortable({ id, animateLayoutChanges: glideWhileSorting, ...motion });
  // A leaving widget is no longer on the board: it is not counted as one, and its controls take no
  // input for the moment it fades.
  const isPresent = useIsPresent();
  const node = React.useRef<HTMLDivElement | null>(null);
  const ref = React.useCallback((element: HTMLDivElement | null) => {
    node.current = element;
    setNodeRef(element);
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [setNodeRef, forwardedRef]);
  // A widget restored while it fades comes back present, and takes input again.
  React.useEffect(() => {
    node.current?.toggleAttribute('inert', !isPresent);
  }, [isPresent]);
  // Only the glide's offset is drawn: a reflow that changed the widget's row also changes its size,
  // and scaling the widget to its old size would stretch its content for the length of the glide.
  const style = {
    '--rows': rows,
    ...(transform || transition
      ? { transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition }
      : {}),
  } as React.CSSProperties;
  return (
    <m.div
      {...attributes}
      data-widget={isPresent ? attributes['data-widget'] : undefined}
      aria-hidden={isPresent ? undefined : true}
      ref={ref}
      style={style}
      layout={canGlide ? 'position' : false}
      custom={isEditing}
      variants={variants}
      initial={isEditing ? 'hidden' : false}
      animate={CELL_SHOWN}
      exit="hidden"
      transition={settle}
    >
      {children({ ref: setActivatorNodeRef, onPointerDown: listeners?.onPointerDown as React.PointerEventHandler | undefined })}
    </m.div>
  );
});

type ResizeAxis = 'x' | 'y' | 'xy';

/** Pixels the pointer moves on a grip before the widget starts to resize. */
const RESIZE_START_PX = 6;
/** How far past the halfway point a step is crossed before the size changes, in steps. */
const RESIZE_DEADBAND = 0.15;

/**
 * The whole number of steps a drag has reached from `current`, `fraction` being where the pointer
 * is. The size changes a step only once the pointer is past that step's halfway point by a margin,
 * and changes back only once it is as far past it the other way, so a hand resting near a boundary
 * does not flip the widget between two sizes.
 */
function settle(fraction: number, current: number): number {
  const reach = 0.5 + RESIZE_DEADBAND;
  if (fraction >= current + reach) return Math.floor(fraction + 1 - reach);
  if (fraction <= current - reach) return Math.ceil(fraction - 1 + reach);
  return current;
}

/** The board's column count, column width and gap, read from the grid as it is laid out now. */
function boardMetrics(grid: HTMLElement): { columns: number; column: number; gap: number } {
  const style = getComputedStyle(grid);
  const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  const gap = Number.parseFloat(style.columnGap) || DASHBOARD_GAP_PX;
  const column = (grid.getBoundingClientRect().width - gap * (columns - 1)) / columns;
  return { columns, column, gap };
}

/** The offered width nearest to `columns`, a fractional count of the board's columns. */
function nearestSpan(spans: readonly DashboardWidgetSpan[], columns: number): DashboardWidgetSpan {
  return spans.reduce((best, span) => (Math.abs(span - columns) < Math.abs(best - columns) ? span : best), spans[0]);
}

/**
 * The rows the widget's content fills: its height laid out at the top of its cell rather than
 * stretched to the rows it spans, read in one synchronous pass so the board never paints it so.
 */
function naturalRows(cell: HTMLElement): number {
  const saved = cell.style.alignSelf;
  cell.style.alignSelf = 'start';
  const height = cell.getBoundingClientRect().height;
  cell.style.alignSelf = saved;
  return rowsForHeight(height);
}
