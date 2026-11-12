import type { MessageKey } from '../../i18n/catalog';
import React from 'react';
import clsx from 'clsx';
import { Button } from '@/components/ui/button';
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
import type { DashboardBoardProps } from './DashboardBoard';

const SPAN_LABEL_KEYS: Record<DashboardWidgetSpan, MessageKey> = {
  1: 'dash.layout.span_1',
  2: 'dash.layout.span_2',
  3: 'dash.layout.span_3',
  4: 'dash.layout.span_4',
};

const REFLOW = () => null;
const MEASURE = { droppable: { strategy: MeasuringStrategy.Always } };

const underThePointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

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

export const DashboardBoardEditor: React.FC<DashboardBoardProps> = ({
  layout,
  isEditing,
  isPhone,
  renderWidget,
  onChange,
}) => {
  const t = useT();
  const [dragId, setDragId] = React.useState<DashboardWidgetId | null>(null);
  const [preview, setPreview] = React.useState<DashboardWidgetId[] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const guard = useSortGuard();
  const [resizing, setResizing] = React.useState<{ id: DashboardWidgetId; span: DashboardWidgetSpan; rows: number } | null>(null);
  const [sizeAnnouncement, setSizeAnnouncement] = React.useState('');
  const announceFrame = React.useRef(0);
  const announceSize = (text: string) => {
    cancelAnimationFrame(announceFrame.current);
    setSizeAnnouncement('');
    announceFrame.current = requestAnimationFrame(() => setSizeAnnouncement(text));
  };
  React.useEffect(() => () => cancelAnimationFrame(announceFrame.current), []);
  const latestLayout = React.useRef(layout);
  React.useLayoutEffect(() => {
    latestLayout.current = layout;
  }, [layout]);

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
    const origin = { x: event.clientX, y: event.clientY };
    const start = cell.getBoundingClientRect();
    const startRows = (latestLayout.current.find((entry) => entry.id === item.id) ?? item).rows;
    let isMoving = false;
    const move = (moveEvent: PointerEvent) => {
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
                  size="sm"
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
                    <span className={styles['name']} data-tip={label} data-tip-overflow="">{label}</span>
                    <Tooltip title={t('dash.layout.move_earlier')}>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<LeftOutlined />}
                        aria-label={t('common.action_on', { action: t('dash.layout.move_earlier'), target: label })}
                        disabled={index === 0}
                        onClick={() => onChange(stepDashboardWidget(layout, item.id, -1, isShown))}
                      />
                    </Tooltip>
                    <Tooltip title={t('dash.layout.move_later')}>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<RightOutlined />}
                        aria-label={t('common.action_on', { action: t('dash.layout.move_later'), target: label })}
                        disabled={index === ordered.length - 1}
                        onClick={() => onChange(stepDashboardWidget(layout, item.id, 1, isShown))}
                      />
                    </Tooltip>
                    <Tooltip title={t('dash.layout.hide')}>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<EyeInvisibleOutlined />}
                        aria-label={t('common.action_on', { action: t('dash.layout.hide'), target: label })}
                        data-widget-hide={item.id}
                        onClick={() => onChange(setDashboardWidgetHidden(layout, item.id, true))}
                      />
                    </Tooltip>
                  </div>
                </div>
              )}
              {isEditing && !isPhone && (
                <>
                  <span className={clsx(styles['grip'], styles['grip-x'])} data-resize="x" aria-hidden="true" onPointerDown={(event) => startResize(event, item, 'x')} />
                  <span className={clsx(styles['grip'], styles['grip-y'])} data-resize="y" aria-hidden="true" onPointerDown={(event) => startResize(event, item, 'y')} />
                  <Tooltip title={t('dash.layout.resize')}>
                    <button
                      type="button"
                      className={clsx(styles['grip'], styles['grip-xy'])}
                      data-resize="xy"
                      aria-label={t('common.action_on', { action: t('dash.layout.resize'), target: label })}
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
  isEditing: boolean;
  canGlide: boolean;
  children: (handle: CellHandle) => React.ReactNode;
} & Record<`data-${string}`, string | number | undefined>;

const CELL_SHOWN = { opacity: 1 };

const SortableCell = React.forwardRef<HTMLDivElement, SortableCellProps>(function SortableCell({ id, rows, isEditing, canGlide, children, ...attributes }, forwardedRef) {
  const settle = useSpringTransition('settle');
  const leave = useSpringTransition('leave');
  const variants = React.useMemo(() => ({
    hidden: (isEdited: boolean) => ({ opacity: 0, transition: isEdited ? leave : INSTANT }),
  }), [leave]);
  const motion = useSortableMotion();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition } = useSortable({ id, animateLayoutChanges: glideWhileSorting, ...motion });
  const isPresent = useIsPresent();
  const node = React.useRef<HTMLDivElement | null>(null);
  const ref = React.useCallback((element: HTMLDivElement | null) => {
    node.current = element;
    setNodeRef(element);
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [setNodeRef, forwardedRef]);
  React.useEffect(() => {
    node.current?.toggleAttribute('inert', !isPresent);
  }, [isPresent]);
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

const RESIZE_START_PX = 6;
const RESIZE_DEADBAND = 0.15;

function settle(fraction: number, current: number): number {
  const reach = 0.5 + RESIZE_DEADBAND;
  if (fraction >= current + reach) return Math.floor(fraction + 1 - reach);
  if (fraction <= current - reach) return Math.ceil(fraction - 1 + reach);
  return current;
}

function boardMetrics(grid: HTMLElement): { columns: number; column: number; gap: number } {
  const style = getComputedStyle(grid);
  const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  const gap = Number.parseFloat(style.columnGap) || DASHBOARD_GAP_PX;
  const column = (grid.getBoundingClientRect().width - gap * (columns - 1)) / columns;
  return { columns, column, gap };
}

function nearestSpan(spans: readonly DashboardWidgetSpan[], columns: number): DashboardWidgetSpan {
  return spans.reduce((best, span) => (Math.abs(span - columns) < Math.abs(best - columns) ? span : best), spans[0]);
}

function naturalRows(cell: HTMLElement): number {
  const saved = cell.style.alignSelf;
  cell.style.alignSelf = 'start';
  const height = cell.getBoundingClientRect().height;
  cell.style.alignSelf = saved;
  return rowsForHeight(height);
}
