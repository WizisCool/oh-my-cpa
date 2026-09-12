import React from 'react';
import { Button, DatePicker, Dropdown, Modal } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { EVENT_PRESETS } from '../../types/usageEventView';
import { useT } from '../../i18n';
import './TimeRangeControl.css';

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

/** Presets offered inline; the rest of EVENT_PRESETS follows under a divider. */
const QUICK_PRESETS: readonly string[] = ['15m', '1h', '6h', '24h'];

/**
 * TimeRangeControl is the request list's window picker: relative presets for the
 * common case, and an absolute range for the case presets cannot express.
 *
 * Both are needed and neither substitutes for the other. A preset answers "what
 * just happened"; an absolute range answers "what happened during that incident
 * at 14:05", which no relative window can address because it keeps moving while
 * the operator reads it.
 */
export const TimeRangeControl: React.FC<TimeRangeControlProps> = ({ preset, from, to, onChange }) => {
  const t = useT();
  const [isPickerOpen, setIsPickerOpen] = React.useState(false);

  const isAbsolute = from !== undefined;
  const label = isAbsolute
    ? `${dayjs(from).format('MM-DD HH:mm')} — ${to ? dayjs(to).format('MM-DD HH:mm') : t('events.range_open_end')}`
    : t('events.last_range', { range: preset ?? '1h' });

  // Each preset appears exactly once and none is ever omitted. Filtering the
  // selected value out of its own group removed the current choice from the menu,
  // so the operator could not see which preset they were on and could not return
  // to it after switching away. Selection is a highlight, not a filter.
  const quick = QUICK_PRESETS.filter((value) => value in EVENT_PRESETS);
  const slow = Object.keys(EVENT_PRESETS).filter((value) => !QUICK_PRESETS.includes(value));
  const items = [
    ...quick.map((value) => ({ key: `preset:${value}`, label: t('events.last_range', { range: value }) })),
    { type: 'divider' as const },
    ...slow.map((value) => ({ key: `preset:${value}`, label: t('events.last_range', { range: value }) })),
    { type: 'divider' as const },
    { key: 'absolute', label: t('events.custom_range') },
  ];

  return (
    <>
      <Dropdown
        trigger={['click']}
        menu={{
          items,
          selectable: true,
          selectedKeys: isAbsolute ? ['absolute'] : [`preset:${preset}`],
          onClick: ({ key }) => {
            if (key === 'absolute') {
              setIsPickerOpen(true);
              return;
            }
            if (key.startsWith('preset:')) onChange({ preset: key.slice('preset:'.length) });
          },
        }}
        classNames={{ root: 'req-time-menu' }}
      >
        <Button
          className={`req-time-button${isAbsolute ? ' is-absolute' : ''}`}
          aria-label={t('events.time_range')}
          icon={<ClockCircleOutlined />}
        >
          <span className="req-time-button-text">{label}</span>
        </Button>
      </Dropdown>
      <Modal
        className="req-time-modal"
        title={t('events.custom_range')}
        open={isPickerOpen}
        onCancel={() => setIsPickerOpen(false)}
        destroyOnHidden
        footer={null}
        width={420}
      >
        <AbsoluteRangeForm
          from={from}
          to={to}
          onCancel={() => setIsPickerOpen(false)}
          onApply={(nextFrom, nextTo) => {
            setIsPickerOpen(false);
            onChange({ from: nextFrom, to: nextTo });
          }}
        />
      </Modal>
    </>
  );
};

interface AbsoluteRangeFormProps {
  from?: number;
  to?: number;
  onCancel: () => void;
  onApply: (from: number, to: number) => void;
}

type RangePair = [dayjs.Dayjs | null, dayjs.Dayjs | null];

/**
 * The absolute range is staged rather than live.
 *
 * A RangePicker emits intermediate values while the operator clicks through the
 * calendar - two clicks means two values, the first of which is a half-chosen
 * range. Committing each one would fire a query per click and move the window's
 * ends out from under the pointer, so the form holds both ends and applies them
 * together.
 */
const AbsoluteRangeForm: React.FC<AbsoluteRangeFormProps> = ({ from, to, onCancel, onApply }) => {
  const t = useT();
  const [range, setRange] = React.useState<RangePair>([
    from !== undefined ? dayjs(from) : dayjs().subtract(1, 'hour'),
    to !== undefined ? dayjs(to) : dayjs(),
  ]);

  const [start, end] = range;
  // The server requires a positive window, so equal ends are refused here rather
  // than sent as a request that is rejected as malformed. An end after the current
  // time is also refused: the console bounds every window at "now", so the part
  // beyond it could not be shown as chosen.
  const now = dayjs();
  const isIncomplete = start === null || end === null;
  const isReversed = !isIncomplete && !start.isBefore(end);
  const isFuture = !isIncomplete && (start.isAfter(now) || end.isAfter(now));
  const isValid = !isIncomplete && !isReversed && !isFuture;

  const errorKey = isReversed ? 'events.range_reversed' : isFuture ? 'events.range_in_future' : undefined;

  return (
    <div className="req-time-form">
      <p className="req-time-form-hint">{t('events.time_range_hint')}</p>
      <DatePicker.RangePicker
        className="req-time-form-picker"
        showTime={{ format: 'HH:mm' }}
        format="YYYY-MM-DD HH:mm"
        value={range}
        onChange={(next) => setRange(next ? [next[0], next[1]] : [null, null])}
        allowClear={false}
        placeholder={[t('events.range_start'), t('events.range_end')]}
      />
      {errorKey && <p className="req-filter-error">{t(errorKey)}</p>}
      <div className="req-time-form-footer">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="primary" disabled={!isValid} onClick={() => onApply(start!.valueOf(), end!.valueOf())}>
          {t('events.apply_filters')}
        </Button>
      </div>
    </div>
  );
};
