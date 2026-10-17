import React from 'react';
import clsx from 'clsx';
import { Button, Segmented, Tooltip } from 'antd';
import { EyeInvisibleOutlined, HolderOutlined, LeftOutlined, PlusOutlined, RightOutlined } from '../icons';
import { useT } from '../../i18n';
import {
  dashboardWidgetSpec,
  moveDashboardWidget,
  resizeDashboardWidget,
  setDashboardWidgetHidden,
  stepDashboardWidget,
  type DashboardLayout,
  type DashboardLayoutItem,
  type DashboardWidgetId,
  type DashboardWidgetSpan,
  type DropSide,
} from '../../types/dashboardLayout';
import styles from './DashboardBoard.module.css';

export interface DashboardBoardProps {
  layout: DashboardLayout;
  /** True while the operator is arranging the board; the arrangement then lives in `onChange`'s draft. */
  isEditing: boolean;
  isPhone: boolean;
  /** Draws one widget, or nothing when it has nothing to show yet. */
  renderWidget: (id: DashboardWidgetId) => React.ReactNode;
  onChange: (next: DashboardLayout) => void;
}

const SPAN_LABEL_KEYS: Record<DashboardWidgetSpan, string> = {
  1: 'dash.layout.span_1',
  2: 'dash.layout.span_2',
  3: 'dash.layout.span_3',
  4: 'dash.layout.span_4',
};

interface DropTarget {
  id: DashboardWidgetId;
  side: DropSide;
  /** A cell spanning the board's whole row takes a drop above or below it rather than beside it. */
  axis: 'x' | 'y';
}

/**
 * DashboardBoard lays the dashboard's widgets on one four-column grid, in the operator's order and
 * at the operator's widths, and is also where that arrangement is edited.
 *
 * Editing is a mode rather than a permanent affordance: a dashboard is read far more often than it is
 * arranged, so the handles, width controls and hide buttons appear only while the operator is
 * arranging it, and the widgets underneath stop taking input so a drag cannot open a drill-down.
 * Reordering is a drag on the handle and, for keyboard and touch, a step earlier or later; both write
 * the same arrangement.
 */
export const DashboardBoard: React.FC<DashboardBoardProps> = ({ layout, isEditing, isPhone, renderWidget, onChange }) => {
  const t = useT();
  const [dragId, setDragId] = React.useState<DashboardWidgetId | null>(null);
  const [armedId, setArmedId] = React.useState<DashboardWidgetId | null>(null);
  const [dropTarget, setDropTarget] = React.useState<DropTarget | null>(null);
  const boardRef = React.useRef<HTMLDivElement>(null);

  const isMounted = React.useCallback(
    (item: DashboardLayoutItem) => !(isPhone && dashboardWidgetSpec(item.id).isPhoneOmitted),
    [isPhone],
  );
  const isShown = React.useCallback((item: DashboardLayoutItem) => !item.hidden && isMounted(item), [isMounted]);
  const shown = layout.filter(isShown);
  const hidden = layout.filter((item) => item.hidden && isMounted(item));

  const endDrag = () => {
    setDragId(null);
    setArmedId(null);
    setDropTarget(null);
  };

  const dropAt = (event: React.DragEvent<HTMLElement>, id: DashboardWidgetId): DropTarget => {
    const rect = event.currentTarget.getBoundingClientRect();
    const boardWidth = boardRef.current?.getBoundingClientRect().width ?? rect.width;
    const axis = rect.width >= boardWidth - 1 ? 'y' : 'x';
    const isBefore = axis === 'x' ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top + rect.height / 2;
    return { id, side: isBefore ? 'before' : 'after', axis };
  };

  const spanLabel = (span: DashboardWidgetSpan) => t(SPAN_LABEL_KEYS[span]);

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

      <div ref={boardRef} className="dashboard-grid" data-testid="dashboard-board">
        {shown.map((item, index) => {
          const spec = dashboardWidgetSpec(item.id);
          const content = renderWidget(item.id);
          if (!isEditing && (content === null || content === undefined || content === false)) return null;
          const label = t(spec.labelKey);
          const drop = dropTarget?.id === item.id ? dropTarget : null;
          return (
            <div
              key={item.id}
              className={clsx('dashboard-cell', isEditing && styles['cell'], dragId === item.id && styles['is-dragging'])}
              data-widget={item.id}
              data-widget-kind={spec.isMetric ? 'metric' : 'panel'}
              data-span={item.span}
              data-drop={drop?.side}
              data-drop-axis={drop?.axis}
              draggable={isEditing && armedId === item.id}
              onDragStart={isEditing ? (event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.id);
                setDragId(item.id);
              } : undefined}
              onDragEnd={isEditing ? endDrag : undefined}
              onDragOver={isEditing ? (event) => {
                if (!dragId || dragId === item.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const next = dropAt(event, item.id);
                if (next.id !== dropTarget?.id || next.side !== dropTarget.side || next.axis !== dropTarget.axis) setDropTarget(next);
              } : undefined}
              onDragLeave={isEditing ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropTarget((current) => (current?.id === item.id ? null : current));
                }
              } : undefined}
              onDrop={isEditing ? (event) => {
                event.preventDefault();
                if (dragId) onChange(moveDashboardWidget(layout, dragId, item.id, dropAt(event, item.id).side));
                endDrag();
              } : undefined}
            >
              {isEditing && (
                <div className={styles['toolbar']}>
                  <div className={styles['toolbar-row']}>
                    {!isPhone && (
                      <Tooltip title={t('dash.layout.drag')}>
                        <span
                          className={styles['handle']}
                          data-drag-handle
                          aria-hidden="true"
                          onPointerDown={() => setArmedId(item.id)}
                          onPointerUp={() => { if (!dragId) setArmedId(null); }}
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
                        disabled={index === shown.length - 1}
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
                  {/* A phone collapses every width to its two columns, so a width chosen there
                      would change nothing on screen; the control is a desktop one. */}
                  {!isPhone && spec.spans.length > 1 && (
                    <Segmented
                      size="small"
                      className={styles['spans']}
                      value={item.span}
                      aria-label={`${t('dash.layout.width')} · ${label}`}
                      options={spec.spans.map((span) => ({ value: span, label: spanLabel(span) }))}
                      onChange={(span) => onChange(resizeDashboardWidget(layout, item.id, span as DashboardWidgetSpan))}
                    />
                  )}
                </div>
              )}
              {isEditing ? (
                <div className={styles['content']} ref={markInert}>
                  {content ?? <div className={styles['empty']}>{label}</div>}
                </div>
              ) : content}
            </div>
          );
        })}
        {isEditing && shown.length === 0 && (
          <div className={styles['board-empty']}>{t('dash.layout.all_hidden')}</div>
        )}
      </div>
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
