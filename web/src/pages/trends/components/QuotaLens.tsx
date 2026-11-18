import React from 'react';
import { ToolButton } from '../../../components/common/ToolButton';
import { LeftOutlined, RightOutlined, UndoOutlined, ZoomInOutlined, ZoomOutOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import { isWholeLens, panLens, zoomLens, type TimeSpan } from '../trendsLogic';
import styles from '../trends.module.css';

export interface QuotaLensProps {
  lens: TimeSpan;
  bounds: TimeSpan;
  minSpan: number;
  onChange: (lens: TimeSpan) => void;
}

/** How far a button pans, and how much a button zooms, as a share of the lens. */
const PAN_STEP = 0.25;
const ZOOM_STEP = 0.5;

/**
 * The quota chart's camera as a few glyphs: pan, zoom and back to the whole cycle. The chart itself
 * takes a sweep to zoom and the wheel with a modifier, so the buttons only need to cover the rest.
 */
export const QuotaLens: React.FC<QuotaLensProps> = ({ lens, bounds, minSpan, onChange }) => {
  const t = useT();
  const width = lens.end - lens.start;
  const isWhole = isWholeLens(lens, bounds);
  const pan = (direction: -1 | 1) => onChange(panLens(lens, bounds, direction * width * PAN_STEP, minSpan));
  return (
    <span className={styles['window-lens']} data-testid="trends-quota-lens" data-lens-start={lens.start} data-lens-end={lens.end}>
      <ToolButton size="sm" variant="ghost" icon={<LeftOutlined />} label={t('trends.lens.pan_earlier')} disabled={lens.start <= bounds.start} onClick={() => pan(-1)} />
      <ToolButton size="sm" variant="ghost" icon={<RightOutlined />} label={t('trends.lens.pan_later')} disabled={lens.end >= bounds.end} onClick={() => pan(1)} />
      <ToolButton
        size="sm"
        variant="ghost"
        icon={<ZoomInOutlined />}
        label={t('trends.lens.zoom_in')}
        disabled={width <= minSpan}
        onClick={() => onChange(zoomLens(lens, bounds, ZOOM_STEP, minSpan))}
      />
      <ToolButton
        size="sm"
        variant="ghost"
        icon={<ZoomOutOutlined />}
        label={t('trends.lens.zoom_out')}
        disabled={isWhole}
        onClick={() => onChange(zoomLens(lens, bounds, 1 / ZOOM_STEP, minSpan))}
      />
      <ToolButton size="sm" variant="ghost" icon={<UndoOutlined />} label={t('trends.lens.reset')} disabled={isWhole} onClick={() => onChange(bounds)} />
    </span>
  );
};
