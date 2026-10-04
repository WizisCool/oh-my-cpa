import React from 'react';
import dayjs from '../../utils/time';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { useT } from '../../i18n';
import { TimeRangePicker } from '../common/timeRange/TimeRangePicker';
import { presetKeys } from './timeRangePolicy';

export interface TimeRangeValue {
  preset?: string;
  from?: number;
  to?: number;
}

export interface TimeRangeControlProps {
  preset?: string;
  from?: number;
  to?: number;
  onChange: (value: TimeRangeValue) => void;
}

/**
 * TimeRangeControl is the request list's window picker: relative presets for the
 * common case, and an absolute range for the case presets cannot express.
 *
 * Both are needed and neither substitutes for the other. A preset answers "what
 * just happened"; an absolute range answers "what happened during that incident
 * at 14:05", which no relative window can address because it keeps moving while
 * the operator reads it. That question is asked in minutes, so this picker carries
 * a time on each end.
 */
const TimeRangeControlView: React.FC<TimeRangeControlProps> = ({ preset, from, to, onChange }) => {
  useTimeZone();
  const t = useT();
  const label = from !== undefined
    ? `${dayjs(from).format('MM-DD HH:mm')} — ${to ? dayjs(to).format('MM-DD HH:mm') : t('events.range_open_end')}`
    : t('events.last_range', { range: preset ?? '1h' });

  return (
    <TimeRangePicker
      className="req-time-button"
      granularity="minute"
      preset={preset}
      from={from}
      // The query spells an open end as an absent `to`; the picker spells it as `null`.
      to={from === undefined ? undefined : to ?? null}
      // Every preset is offered, the selected one included: selection is a highlight, not a
      // filter. The list is `presetKeys`, so a preset added to `EVENT_PRESETS` cannot be
      // silently missing from it.
      presets={presetKeys().map((value) => ({ key: value, label: t('events.last_range', { range: value }) }))}
      label={label}
      onPresetChange={(next) => onChange({ preset: next })}
      onRangeChange={(nextFrom, nextTo) => onChange({ from: nextFrom, to: nextTo ?? undefined })}
    />
  );
};

/**
 * Memoised because its page re-renders far more often than the window changes - the
 * dashboard on every frame of a rolling readout - and the picker's panel is a calendar's
 * worth of elements that none of those renders can alter.
 */
export const TimeRangeControl = React.memo(TimeRangeControlView);
