import React from 'react';
import { Button, Checkbox, Drawer, Popover } from 'antd';
import { CaretDownOutlined, ClockCircleOutlined, LeftOutlined, RightOutlined } from '../../icons';
import { languageLocale, useI18n } from '../../../i18n';
import { useIsNarrowViewport } from '../../../hooks/useIsNarrowViewport';
import { useOverlayHistory } from '../../../hooks/useOverlayHistory';
import dayjs, { formatTimeZoneOffset } from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { RangeCalendar } from './RangeCalendar';
import {
  clampEndTime,
  draftFromWindow,
  effectiveEndDay,
  formatClockInput,
  isPickingEnd,
  monthOf,
  pickDay,
  resolveDraft,
  type CivilDay,
  type RangeDraft,
  type RangeGranularity,
} from './rangeDraft';
import './TimeRangePicker.css';

export interface TimeRangePreset {
  key: string;
  label: string;
}

export interface TimeRangePickerProps {
  /** The committed window: a preset, or `from` with `to` (`null` when open-ended). */
  preset?: string;
  from?: number;
  to?: number | null;
  presets: readonly TimeRangePreset[];
  /** Whether a custom range is whole days or carries a time on each end. */
  granularity: RangeGranularity;
  /** What the trigger reads; the caller owns how its page words a window. */
  label: string;
  className?: string;
  placement?: 'bottomLeft' | 'bottomRight';
  onPresetChange: (preset: string) => void;
  onRangeChange: (from: number, to: number | null) => void;
}

type PanelMode = 'quick' | 'custom';

const ERROR_KEYS: Record<string, string | undefined> = {
  reversed: 'time_range.reversed',
  future: 'time_range.in_future',
};

/**
 * TimeRangePicker is the console's one window picker: a button that names the window, and a
 * single surface that changes it.
 *
 * It opens as a short list of relative presets, because that is what the reader wants almost
 * every time, and a calendar they did not ask for is a screenful of attention spent on
 * nothing. The exact range is one level down, behind the list's last row. It opens there
 * directly only when the committed window is already a custom one - the reader reopening it
 * came to adjust that range.
 *
 * A preset is a complete answer, so it applies on the press. A range is two presses and
 * sometimes two times, so it is staged and committed with Apply: committing each press would
 * query a half-chosen window and move the data under the pointer.
 *
 * The surface is a popover beside the trigger on a desktop and a bottom sheet below the
 * shell's narrow breakpoint, where a popover anchored to a toolbar button has neither the
 * width for a calendar nor a thumb's reach. The sheet is a Drawer-class overlay, so the platform's Back dismisses it.
 */
export const TimeRangePicker: React.FC<TimeRangePickerProps> = ({
  preset,
  from,
  to,
  presets,
  granularity,
  label,
  className,
  placement = 'bottomLeft',
  onPresetChange,
  onRangeChange,
}) => {
  const zone = useTimeZone();
  const { t, lang } = useI18n();
  // The sheet takes over at the shell's narrow breakpoint, not only on a phone: the panel
  // with its calendar is wider than a tablet leaves beside a toolbar button.
  const isSheet = useIsNarrowViewport();
  const isCustom = from !== undefined;
  const [isOpen, setIsOpen] = React.useState(false);
  // The panel is built only while the popover is on screen, its closing motion included:
  // this flag follows the popover's own settled state, so it outlives `isOpen` by that motion.
  // Left mounted in a hidden popover it would be rebuilt by every render of the page.
  const [isPanelMounted, setIsPanelMounted] = React.useState(false);
  const [mode, setMode] = React.useState<PanelMode>('quick');
  const [draft, setDraft] = React.useState<RangeDraft>(() => draftFromWindow({ from, to }));
  const today: CivilDay = dayjs().format('YYYY-MM-DD');
  const [viewMonth, setViewMonth] = React.useState(() => monthOf(today));

  const close = React.useCallback(() => setIsOpen(false), []);
  useOverlayHistory({ isOpen: isSheet && isOpen, onClose: close });

  // A popover is not a focus trap, so Escape is heard on the document: focus may still be on
  // the trigger, or on nothing at all after a press on the calendar's padding. The sheet
  // already closes on Escape through the Drawer.
  React.useEffect(() => {
    if (!isOpen || isSheet) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isSheet, close]);

  const open = () => {
    // The draft restarts from the committed window on every open, so a range abandoned
    // half-picked is not what the panel shows the next time.
    const nextDraft = draftFromWindow({ from, to });
    setDraft(nextDraft);
    setViewMonth(monthOf(effectiveEndDay(nextDraft) ?? today));
    setMode(isCustom ? 'custom' : 'quick');
    setIsOpen(true);
  };

  const resolved = resolveDraft(draft, granularity, Date.now());
  const errorKey = resolved.error ? ERROR_KEYS[resolved.error] : undefined;

  const applyDraft = () => {
    if (resolved.error || resolved.from === undefined) return;
    onRangeChange(resolved.from, resolved.to ?? null);
    close();
  };

  const updateDraft = (next: RangeDraft) => {
    setDraft(granularity === 'minute' ? clampEndTime(next, Date.now()) : next);
  };

  const endDay = effectiveEndDay(draft);
  const isEndNext = isPickingEnd(draft);

  const renderField = (edge: 'start' | 'end') => {
    const isStart = edge === 'start';
    const day = isStart ? draft.startDay : endDay;
    const isOpenEnd = !isStart && draft.isOpenEnded;
    return (
      <div className={`time-range-field${isStart !== isEndNext && !isOpenEnd ? ' is-next' : ''}`}>
        <span className="time-range-field-label">{t(isStart ? 'time_range.start' : 'time_range.end')}</span>
        <span className={`time-range-field-value${day === undefined && !isOpenEnd ? ' is-empty' : ''}`}>
          {isOpenEnd ? t('time_range.until_now') : day ?? t('time_range.pick_day')}
        </span>
        {granularity === 'minute' && day !== undefined && !isOpenEnd && (
          <input
            // A text field, not `type="time"`: the native control follows the browser's
            // locale into a 12-hour clock, and every other time in the console is 24-hour.
            type="text"
            inputMode="numeric"
            maxLength={5}
            placeholder="HH:mm"
            className="time-range-time"
            aria-label={t(isStart ? 'time_range.start' : 'time_range.end')}
            value={isStart ? draft.startTime : draft.endTime}
            onChange={(event) =>
              setDraft({ ...draft, [isStart ? 'startTime' : 'endTime']: formatClockInput(event.target.value) })
            }
          />
        )}
      </div>
    );
  };

  const presetList = (
    <div className="time-range-rail">
      <ul className="time-range-presets" role="listbox" aria-label={t('time_range.quick')}>
        {presets.map((option) => {
          const isSelected = !isCustom && option.key === preset;
          return (
            <li key={option.key} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                data-preset={option.key}
                className={`time-range-option${isSelected ? ' is-active' : ''}`}
                onClick={() => {
                  onPresetChange(option.key);
                  close();
                }}
              >
                {option.label}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={`time-range-option time-range-custom-toggle${isCustom ? ' is-active' : ''}`}
        aria-expanded={mode === 'custom'}
        onClick={() => setMode(mode === 'custom' && !isSheet ? 'quick' : 'custom')}
      >
        {t('time_range.custom')}
        <RightOutlined className="time-range-custom-caret" />
      </button>
    </div>
  );

  const customForm = (
    <div className="time-range-custom">
      <RangeCalendar
        draft={draft}
        today={today}
        locale={languageLocale(lang)}
        viewMonth={viewMonth}
        // Two months show a range that crosses a month boundary whole; the sheet has the
        // width for one.
        monthCount={isSheet ? 1 : 2}
        onViewMonthChange={setViewMonth}
        onPick={(day) => updateDraft(pickDay(draft, day))}
      />
      <div className="time-range-fields">
        {renderField('start')}
        <span className="time-range-fields-arrow" aria-hidden="true">→</span>
        {renderField('end')}
      </div>
      <p className="time-range-error" role="alert">{errorKey ? t(errorKey) : ''}</p>
      <div className="time-range-footer">
        <Checkbox
          className="time-range-open-end"
          checked={draft.isOpenEnded}
          onChange={(event) => updateDraft({ ...draft, isOpenEnded: event.target.checked, endDay: undefined })}
        >
          {t('time_range.until_now')}
        </Checkbox>
        <span className="time-range-zone">{formatTimeZoneOffset(zone)}</span>
        <div className="time-range-actions">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="primary" data-testid="time-range-apply" disabled={resolved.error !== undefined} onClick={applyDraft}>
            {t('time_range.apply')}
          </Button>
        </div>
      </div>
    </div>
  );

  const trigger = (
    <Button
      className={[
        'time-range-trigger',
        // A closed range is a fixed fact, not a rolling one. Marking it keeps the reader from
        // taking a frozen window for a live one and waiting for it to move.
        isCustom && typeof to === 'number' ? 'is-frozen' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      icon={<ClockCircleOutlined />}
      title={t('time_range.title')}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      onClick={isSheet ? open : undefined}
    >
      <span className="time-range-trigger-text">{label}</span>
      <CaretDownOutlined className="time-range-trigger-caret" />
    </Button>
  );

  if (isSheet) {
    return (
      <>
        {trigger}
        <Drawer
          className="time-range-sheet"
          placement="bottom"
          title={t('time_range.title')}
          open={isOpen}
          onClose={close}
          destroyOnHidden
          // The sheet is as tall as what it holds, up to the visible viewport: the preset
          // list is short and the calendar is not, and a fixed height fits neither.
          styles={{ wrapper: { height: 'auto', maxHeight: '92dvh' } }}
        >
          <div className="time-range-panel is-sheet" data-mode={mode}>
            {mode === 'quick' ? presetList : (
              <>
                <button type="button" className="time-range-back" onClick={() => setMode('quick')}>
                  <LeftOutlined />
                  {t('time_range.quick')}
                </button>
                {customForm}
              </>
            )}
          </div>
        </Drawer>
      </>
    );
  }

  return (
    <Popover
      open={isOpen}
      trigger="click"
      placement={placement}
      arrow={false}
      classNames={{ root: 'time-range-popover' }}
      // The shell is always present - a popover with no content never opens - and only its
      // children come and go.
      content={(
        <div className="time-range-panel" role="dialog" aria-label={t('time_range.title')} data-mode={mode}>
          {(isOpen || isPanelMounted) && presetList}
          {(isOpen || isPanelMounted) && mode === 'custom' && customForm}
        </div>
      )}
      onOpenChange={(next) => (next ? open() : close())}
      afterOpenChange={setIsPanelMounted}
    >
      {trigger}
    </Popover>
  );
};
