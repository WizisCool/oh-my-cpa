import type { MessageKey } from '../../../i18n/catalog';
import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetBody, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { DropdownCaret } from '@/components/ui/dropdown-caret';
import { Checkbox } from '@/components/ui/checkbox';
import { ClockCircleOutlined, LeftOutlined, RightOutlined } from '../../icons';
import { languageLocale, useI18n } from '../../../i18n';
import { useIsNarrowViewport } from '../../../hooks/useIsNarrowViewport';
import dayjs, { formatTimeZoneOffset } from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { isMotionReduced } from '../../../utils/motionPreference';
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

/**
 * A run of presets that answer the same kind of question - calendar units, spans back from now.
 * A group with a label is headed by it; `isPaired` lays its options two to a row, for groups whose
 * options come in current/previous pairs.
 */
export interface TimeRangePresetGroup {
  key: string;
  label?: string;
  isPaired?: boolean;
  presets: readonly TimeRangePreset[];
}

export interface TimeRangePickerProps {
  /** The committed window: a preset, or `from` with `to` (`null` when open-ended). */
  preset?: string;
  from?: number;
  to?: number | null;
  groups: readonly TimeRangePresetGroup[];
  /** Whether a custom range is whole days or carries a time on each end. */
  granularity: RangeGranularity;
  /** What the trigger reads; the caller owns how its page words a window. */
  label: string;
  className?: string;
  placement?: 'bottomLeft' | 'bottomRight';
  onPresetChange: (preset: string) => void;
  onRangeChange: (from: number, to: number | null) => void;
  /** Inactive until the page knows which window it began with, so a fallback is never written back. */
  isDisabled?: boolean;
}

type PanelMode = 'quick' | 'custom';

const ERROR_KEYS: Record<string, MessageKey | undefined> = {
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
 * width for a calendar nor a thumb's reach.
 */
export const TimeRangePicker: React.FC<TimeRangePickerProps> = ({
  preset,
  from,
  to,
  groups,
  granularity,
  label,
  className,
  placement = 'bottomLeft',
  onPresetChange,
  onRangeChange,
  isDisabled = false,
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

  // Opening the calendar beside the presets grows the popover several times over. The panel eases
  // from the size it had to the size it now has, so the calendar unfolds out of the list rather
  // than the surface jumping to its new box.
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const panelSizeBefore = React.useRef<{ width: number; height: number } | null>(null);
  const switchMode = (next: PanelMode) => {
    const panel = panelRef.current;
    panelSizeBefore.current = panel ? { width: panel.offsetWidth, height: panel.offsetHeight } : null;
    setMode(next);
  };
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    const before = panelSizeBefore.current;
    panelSizeBefore.current = null;
    if (!panel || !before || isMotionReduced()) return;
    const after = { width: panel.offsetWidth, height: panel.offsetHeight };
    if (after.width === before.width && after.height === before.height) return;
    // A switch back mid-ease starts from where the panel had got to (measured before this commit,
    // with the ease still on); the cleanup takes the running ease off before the new size is read,
    // and also when the panel closes or unmounts mid-ease.
    const resize = panel.animate(
      [
        { width: `${before.width}px`, height: `${before.height}px`, overflow: 'clip' },
        { width: `${after.width}px`, height: `${after.height}px`, overflow: 'clip' },
      ],
      { duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
    return () => resize.cancel();
  }, [mode]);

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
      <div className="time-range-presets" role="listbox" aria-label={t('time_range.quick')}>
        {groups.map((group) => (
          <div key={group.key} className="time-range-group" role="group" aria-label={group.label}>
            {group.label && <div className="time-range-group-label" aria-hidden="true">{group.label}</div>}
            <div className={`time-range-group-options${group.isPaired ? ' is-paired' : ''}`}>
              {group.presets.map((option) => {
                const isSelected = !isCustom && option.key === preset;
                return (
                  <button
                    key={option.key}
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
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`time-range-option time-range-custom-toggle${isCustom ? ' is-active' : ''}`}
        aria-expanded={mode === 'custom'}
        onClick={() => switchMode(mode === 'custom' && !isSheet ? 'quick' : 'custom')}
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
          onCheckedChange={(checked) => updateDraft({ ...draft, isOpenEnded: checked, endDay: undefined })}
        >
          {t('time_range.until_now')}
        </Checkbox>
        <span className="time-range-zone">{formatTimeZoneOffset(zone)}</span>
        <div className="time-range-actions">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" data-testid="time-range-apply" disabled={resolved.error !== undefined} onClick={applyDraft}>
            {t('time_range.apply')}
          </Button>
        </div>
      </div>
    </div>
  );

  // A field, not a button: it holds a value and opens a choice of values, exactly as the selects
  // beside it do, so it takes their fill, hover and chevron rather than the button wash.
  const trigger = (
    <Button
      variant="filled"
      className={[
        'time-range-trigger',
        // A closed range is a fixed fact, not a rolling one. Marking it keeps the reader from
        // taking a frozen window for a live one and waiting for it to move.
        isCustom && typeof to === 'number' ? 'is-frozen' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      icon={<ClockCircleOutlined />}
      disabled={isDisabled}
      data-tip={t('time_range.title')}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      onClick={isSheet ? open : undefined}
    >
      <span className="time-range-trigger-text">{label}</span>
      <DropdownCaret className="time-range-trigger-caret" />
    </Button>
  );

  if (isSheet) {
    return (
      <>
        {trigger}
        <Sheet
          open={isOpen}
          onOpenChange={(next) => {
            if (!next) close();
          }}
        >
          <SheetContent
            side="bottom"
            destroyOnHidden
            className="time-range-sheet h-auto max-h-[92dvh]"
          >
            <SheetHeader title={t('time_range.title')} closeLabel={t('common.close')} />
            <SheetBody>
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
            </SheetBody>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => (next ? open() : close())}
      afterOpenChange={setIsPanelMounted}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent placement={placement} className="time-range-popover p-0">
        <div ref={panelRef} className="time-range-panel" role="dialog" aria-label={t('time_range.title')} data-mode={mode}>
          {(isOpen || isPanelMounted) && presetList}
          {(isOpen || isPanelMounted) && mode === 'custom' && customForm}
        </div>
      </PopoverContent>
    </Popover>
  );
};
