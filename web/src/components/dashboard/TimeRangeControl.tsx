import React from 'react';
import dayjs from '../../utils/time';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { useT } from '../../i18n';
import { TimeRangePicker } from '../common/timeRange/TimeRangePicker';
import { DASHBOARD_PRESETS, type DashboardPreset, type DashboardRange } from '../../types/dashboard';

/**
 * A day-granular window, written the way people read it: one date when the
 * range sits inside a single day, the repeated date dropped otherwise.
 */
function formatSpan(from: number, to: number): string {
  const start = dayjs(from);
  const end = dayjs(to);
  const stamp = start.format('MM-DD');
  return start.format('YYYY-MM-DD') === end.format('YYYY-MM-DD')
    ? stamp
    : `${stamp} – ${end.format('MM-DD')}`;
}

interface TimeRangeControlProps {
  range: DashboardRange;
  onChange: (range: DashboardRange) => void;
}

/**
 * TimeRangeControl is the dashboard's window picker.
 *
 * The dashboard reads trends, so its custom range is whole days: a picked end means
 * *through* that day, and an end left to track the present keeps the newest bucket arriving
 * the way a preset does.
 */
const TimeRangeControlView: React.FC<TimeRangeControlProps> = ({ range, onChange }) => {
  useTimeZone();
  const t = useT();
  const label = range.from !== undefined
    ? (typeof range.to === 'number'
      ? formatSpan(range.from, range.to)
      : `${dayjs(range.from).format('MM-DD')} – ${t('dash.range.until_now')}`)
    : t(`dash.range.${range.preset ?? '24h'}`);

  return (
    <TimeRangePicker
      className="range-trigger"
      placement="bottomRight"
      granularity="day"
      preset={range.preset}
      from={range.from}
      to={range.to}
      presets={DASHBOARD_PRESETS.map((preset) => ({ key: preset, label: t(`dash.range.${preset}`) }))}
      label={label}
      onPresetChange={(preset) => onChange({ preset: preset as DashboardPreset })}
      onRangeChange={(from, to) => onChange({ from, to })}
    />
  );
};

/**
 * Memoised because its page re-renders far more often than the window changes - the
 * dashboard on every frame of a rolling readout - and the picker's panel is a calendar's
 * worth of elements that none of those renders can alter.
 */
export const TimeRangeControl = React.memo(TimeRangeControlView);
