import React from 'react';
import { LeftOutlined, RightOutlined } from '../../icons';
import { useT } from '../../../i18n';
import { formatCalendarDay } from '../../../utils/dateTimeFormat';
import {
  buildMonthGrid,
  firstWeekdayOf,
  isPickingEnd,
  monthOf,
  shiftDay,
  shiftMonth,
  type CivilDay,
  type RangeDraft,
} from './rangeDraft';

/** A Sunday, so weekday headers can be formatted without consulting the clock. */
const REFERENCE_SUNDAY = '2023-01-01';
const DAYS_PER_WEEK = 7;

const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -DAYS_PER_WEEK,
  ArrowDown: DAYS_PER_WEEK,
};

interface RangeCalendarProps {
  draft: RangeDraft;
  today: CivilDay;
  locale: string;
  /** The latest month on screen; with two months the earlier one sits to its left. */
  viewMonth: string;
  monthCount: 1 | 2;
  onViewMonthChange: (month: string) => void;
  onPick: (day: CivilDay) => void;
}

/**
 * RangeCalendar draws the months a range is picked on.
 *
 * It lives inside the picker's own panel rather than in a floating layer of its own, which is
 * what lets the panel be one surface on a desktop and one sheet on a phone. Days after today
 * cannot be picked: every window the console can query ends at or before now.
 */
export const RangeCalendar: React.FC<RangeCalendarProps> = ({
  draft,
  today,
  locale,
  viewMonth,
  monthCount,
  onViewMonthChange,
  onPick,
}) => {
  const t = useT();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [hoverDay, setHoverDay] = React.useState<CivilDay>();
  const [focusDay, setFocusDay] = React.useState<CivilDay>();
  // Focus follows the keyboard only. Moving it on every render would pull focus into the
  // calendar whenever the panel opened or the draft changed.
  const shouldMoveFocus = React.useRef(false);

  const firstWeekday = React.useMemo(() => firstWeekdayOf(locale), [locale]);
  const months = monthCount === 2 ? [shiftMonth(viewMonth, -1), viewMonth] : [viewMonth];
  const currentMonth = monthOf(today);

  // While the end is still to be picked, the hovered day previews it, so the band the reader
  // is about to commit is on screen before the press. An open-ended range runs to today.
  const previewDay = isPickingEnd(draft) ? hoverDay : undefined;
  const otherEnd = draft.isOpenEnded ? today : draft.endDay ?? previewDay ?? draft.startDay;
  const rangeStart = draft.startDay !== undefined && otherEnd !== undefined && otherEnd < draft.startDay ? otherEnd : draft.startDay;
  const rangeEnd = draft.startDay !== undefined && otherEnd !== undefined && otherEnd < draft.startDay ? draft.startDay : otherEnd;

  const isVisible = (day: CivilDay | undefined): day is CivilDay => day !== undefined && months.includes(monthOf(day));
  const tabDay = [focusDay, draft.startDay, today].find(isVisible) ?? `${viewMonth}-01`;

  React.useEffect(() => {
    if (!shouldMoveFocus.current || focusDay === undefined) return;
    shouldMoveFocus.current = false;
    containerRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, viewMonth]);

  const moveFocus = (target: CivilDay) => {
    const day = target > today ? today : target;
    const month = monthOf(day);
    if (month > viewMonth) onViewMonthChange(month);
    else if (month < months[0]) onViewMonthChange(monthCount === 2 ? shiftMonth(month, 1) : month);
    shouldMoveFocus.current = true;
    setFocusDay(day);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const day = (event.target as HTMLElement).dataset.day;
    if (day === undefined) return;
    if (event.key in KEY_STEPS) {
      event.preventDefault();
      moveFocus(shiftDay(day, KEY_STEPS[event.key]));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      // The day of the month is kept where the target month has it; the 31st lands on the
      // month's last day rather than spilling into the one after.
      const month = shiftMonth(monthOf(day), event.key === 'PageUp' ? -1 : 1);
      const lastDay = shiftDay(`${shiftMonth(month, 1)}-01`, -1);
      const sameDay = `${month}-${day.slice(8)}`;
      moveFocus(sameDay > lastDay ? lastDay : sameDay);
    }
  };

  return (
    <div
      ref={containerRef}
      className="time-range-calendar"
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setHoverDay(undefined)}
    >
      {months.map((month, monthIndex) => (
        <div key={month} className="time-range-month" role="group" aria-label={formatCalendarDay(`${month}-01`, locale, { year: 'numeric', month: 'long' })}>
          <div className="time-range-month-head">
            {monthIndex === 0 ? (
              <button
                type="button"
                className="time-range-month-step"
                aria-label={t('time_range.prev_month')}
                onClick={() => onViewMonthChange(shiftMonth(viewMonth, -1))}
              >
                <LeftOutlined />
              </button>
            ) : <span className="time-range-month-step is-spacer" />}
            <span className="time-range-month-title" aria-live="polite">
              {formatCalendarDay(`${month}-01`, locale, { year: 'numeric', month: 'long' })}
            </span>
            {monthIndex === months.length - 1 ? (
              <button
                type="button"
                className="time-range-month-step"
                aria-label={t('time_range.next_month')}
                disabled={viewMonth >= currentMonth}
                onClick={() => onViewMonthChange(shiftMonth(viewMonth, 1))}
              >
                <RightOutlined />
              </button>
            ) : <span className="time-range-month-step is-spacer" />}
          </div>
          <div className="time-range-weekdays" aria-hidden="true">
            {Array.from({ length: DAYS_PER_WEEK }, (_, weekday) => (
              <span key={weekday}>
                {formatCalendarDay(shiftDay(REFERENCE_SUNDAY, firstWeekday + weekday), locale, { weekday: 'short' })}
              </span>
            ))}
          </div>
          <div className="time-range-days">
            {buildMonthGrid(month, firstWeekday).map((day) => {
              // A day outside the month keeps its cell and draws nothing: with two months on
              // screen it would otherwise appear twice, once in each grid.
              if (monthOf(day) !== month) return <span key={day} className="time-range-day-gap" />;
              const isEdgeStart = day === rangeStart;
              const isEdgeEnd = day === rangeEnd;
              const isInRange = rangeStart !== undefined && rangeEnd !== undefined && day >= rangeStart && day <= rangeEnd;
              const classes = [
                'time-range-day',
                day === today && 'is-today',
                isInRange && 'is-in-range',
                isEdgeStart && 'is-range-start',
                isEdgeEnd && 'is-range-end',
                // The open end and a previewed end are not picked days, so they are banded
                // but not filled.
                (day === draft.startDay || day === draft.endDay) && 'is-picked',
              ].filter(Boolean).join(' ');
              return (
                <button
                  key={day}
                  type="button"
                  className={classes}
                  data-day={day}
                  tabIndex={day === tabDay ? 0 : -1}
                  disabled={day > today}
                  aria-label={formatCalendarDay(day, locale, { dateStyle: 'full' })}
                  aria-pressed={day === draft.startDay || day === draft.endDay}
                  aria-current={day === today ? 'date' : undefined}
                  onMouseEnter={() => setHoverDay(day)}
                  onFocus={() => setHoverDay(day)}
                  onClick={() => {
                    setFocusDay(day);
                    onPick(day);
                  }}
                >
                  {Number(day.slice(8))}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
