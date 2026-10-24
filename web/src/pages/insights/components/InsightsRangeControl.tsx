import React from 'react';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { useT } from '../../../i18n';
import { TimeRangePicker } from '../../../components/common/timeRange/TimeRangePicker';
import { INSIGHTS_PRESETS, type InsightsPreset, type InsightsRange } from '../../../types/insights';

interface InsightsRangeControlProps {
  range: InsightsRange;
  onChange: (range: InsightsRange) => void;
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
 * week") listed ahead of the spans, because a reader comparing keys asks about the calendar first.
 * A custom range is whole days, like the dashboard's.
 */
const InsightsRangeControlView: React.FC<InsightsRangeControlProps> = ({ range, onChange }) => {
  useTimeZone();
  const t = useT();
  const label = range.from !== undefined
    ? (typeof range.to === 'number'
      ? formatSpan(range.from, range.to)
      : `${dayjs(range.from).format('MM-DD')} – ${t('dash.range.until_now')}`)
    : t(`insights.range.${range.preset ?? '7d'}`);
  const presets = React.useMemo(
    () => INSIGHTS_PRESETS.map((preset) => ({ key: preset, label: t(`insights.range.${preset}`) })),
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
      presets={presets}
      label={label}
      onPresetChange={(preset) => onChange({ preset: preset as InsightsPreset })}
      onRangeChange={(from, to) => onChange({ from, to })}
    />
  );
};

export const InsightsRangeControl = React.memo(InsightsRangeControlView);
