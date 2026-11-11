import React from 'react';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { useT } from '../../../i18n';
import { TimeRangePicker } from '../../../components/common/timeRange/TimeRangePicker';
import { calendarPresetGroup, calendarPresetLabel } from '../../../components/common/timeRange/presetGroups';
import { isCalendarPreset } from '../../../types/calendarPresets';
import { INSIGHTS_SPAN_PRESETS, type InsightsPreset, type InsightsRange } from '../../../types/insights';

interface InsightsRangeControlProps {
  range: InsightsRange;
  onChange: (range: InsightsRange) => void;
  /** False until the stored window has been read; the trigger then shows it inertly. */
  isDisabled?: boolean;
}

function formatSpan(from: number, to: number): string {
  const start = dayjs(from);
  const end = dayjs(to);
  return start.format('YYYY-MM-DD') === end.format('YYYY-MM-DD')
    ? start.format('MM-DD')
    : `${start.format('MM-DD')} – ${end.format('MM-DD')}`;
}

/**
 * The Insights window picker: the console's one picker, with the calendar units ("today", "this
 * week") grouped ahead of the spans, because a reader comparing keys asks about the calendar first.
 * A custom range is whole days, like the dashboard's.
 */
const InsightsRangeControlView: React.FC<InsightsRangeControlProps> = ({ range, onChange, isDisabled }) => {
  useTimeZone();
  const t = useT();
  const label = range.from !== undefined
    ? (typeof range.to === 'number'
      ? formatSpan(range.from, range.to)
      : `${dayjs(range.from).format('MM-DD')} – ${t('dash.range.until_now')}`)
    : isCalendarPreset(range.preset)
      ? calendarPresetLabel(t, range.preset)
      : t(`insights.range.${range.preset ?? '7d'}`);
  const groups = React.useMemo(
    () => [
      calendarPresetGroup(t),
      {
        key: 'recent',
        label: t('time_range.quick'),
        presets: INSIGHTS_SPAN_PRESETS.map((preset) => ({ key: preset, label: t(`insights.range.${preset}`) })),
      },
    ],
    [t],
  );

  return (
    <TimeRangePicker
      className="range-trigger"
      placement="bottomRight"
      granularity="day"
      preset={range.preset}
      from={range.from}
      to={range.to}
      groups={groups}
      label={label}
      isDisabled={isDisabled}
      onPresetChange={(preset) => onChange({ preset: preset as InsightsPreset })}
      onRangeChange={(from, to) => onChange({ from, to })}
    />
  );
};

export const InsightsRangeControl = React.memo(InsightsRangeControlView);
