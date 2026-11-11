import type { MessageKey } from '../../../i18n/catalog';
import { CALENDAR_PRESETS, type CalendarPreset } from '../../../types/calendarPresets';
import type { TimeRangePresetGroup } from './TimeRangePicker';

type Translate = (key: MessageKey) => string;

export function calendarPresetLabel(t: Translate, preset: CalendarPreset): string {
  return t(`time_range.${preset}`);
}

/**
 * The calendar units as the picker's first group, laid out in pairs: today beside yesterday, this
 * week beside last week. The pair is the comparison the reader is about to make.
 */
export function calendarPresetGroup(t: Translate): TimeRangePresetGroup {
  return {
    key: 'calendar',
    label: t('time_range.calendar'),
    isPaired: true,
    presets: CALENDAR_PRESETS.map((preset) => ({ key: preset, label: calendarPresetLabel(t, preset) })),
  };
}
