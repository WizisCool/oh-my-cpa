import React from 'react';
import { Button, DatePicker, Dropdown, Modal } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import {
  rangeErrorKey,
  selectedPresetKeys,
  splitPresets,
  validateAbsoluteRange,
} from './timeRangePolicy';
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
  // The custom-range dialog is a modal over the page, so Back closes it rather than leaving the
  // window the operator was configuring.
  useOverlayHistory({ isOpen: isPickerOpen, onClose: () => setIsPickerOpen(false) });

  const isAbsolute = from !== undefined;
  const label = isAbsolute
    ? `${dayjs(from).format('MM-DD HH:mm')} — ${to ? dayjs(to).format('MM-DD HH:mm') : t('events.range_open_end')}`
    : t('events.last_range', { range: preset ?? '1h' });

  // Each preset appears exactly once and none is ever omitted. Filtering the
  // selected value out of its own group removed the current choice from the menu,
  // so the operator could not see which preset they were on and could not return
  // to it after switching away. Selection is a highlight, not a filter.
  // The partition is `splitPresets`, so a preset added to `EVENT_PRESETS` cannot be
  // silently missing from the menu.
  const { quick, slow } = splitPresets();
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
          selectedKeys: selectedPresetKeys(isAbsolute, preset),
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
  // The server requires a positive window bounded at now. The rule that decides
  // whether this range can be applied lives in `timeRangePolicy` and is tested
  // there, because a half-chosen or transposed range has to be refused for reasons
  // no browser assertion can state.
  const validation = validateAbsoluteRange(
    [start ? start.valueOf() : null, end ? end.valueOf() : null],
    Date.now(),
  );
  const errorKey = rangeErrorKey(validation.errorKey);

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
        <Button type="primary" disabled={!validation.isValid} onClick={() => onApply(start!.valueOf(), end!.valueOf())}>
          {t('events.apply_filters')}
        </Button>
      </div>
    </div>
  );
};
