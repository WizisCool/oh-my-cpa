import React from 'react';
import { Button, DatePicker, Popover, Tabs } from 'antd';
import { CaretDownOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useT } from '../../i18n';
import { DASHBOARD_PRESETS, type DashboardPreset, type DashboardRange } from '../../types/dashboard';

const { RangePicker } = DatePicker;

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
 * TimeRangeControl is the dashboard's whole time-filter surface: one button
 * that names the current window, and a popover that resolves it.
 *
 * It follows the shape ops consoles settled on (Grafana's time picker,
 * Datadog's time frame widget): quick windows and an exact range are two modes
 * of one control, not two controls side by side. The previous layout spent a
 * seven-item segmented row plus a permanently mounted RangePicker to say
 * "last 24 hours".
 *
 * The exact-range side is left to antd: its own panel, its own OK button, its
 * own time columns. Anything wrapped around a date picker — draft state, a
 * second Apply control, a hand-rolled confirm — is a second opinion on when a
 * date is "chosen", and the two disagree in ways users feel as friction.
 */
export const TimeRangeControl: React.FC<TimeRangeControlProps> = ({ range, onChange }) => {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const isCustom = range.from !== undefined;
  const [tab, setTab] = React.useState<'quick' | 'custom'>(isCustom ? 'custom' : 'quick');
  // antd's calendar needs the viewport's width; squeezed inside this panel it
  // spills past the popover's own edge. So it renders where antd puts it by
  // default, in a layer of its own, and the only thing this control adds is
  // that an outside click which was really a click on that calendar must not
  // close the popover hosting the picker.
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const begin = () => {
    setTab(isCustom ? 'custom' : 'quick');
  };

  const applyPreset = (preset: DashboardPreset) => {
    onChange({ preset });
    setOpen(false);
  };

  const applyCustom = (from: number | undefined, to: number | null) => {
    if (from === undefined) return;
    // The picker is day-granular, so a picked end means *through* that day.
    // Leaving it at midnight would quietly drop the last day from a range the
    // operator just read as "08-09 to 08-21".
    const end = to === null ? null : dayjs(to).endOf('day').valueOf();
    if (end !== null && end <= from) return;
    onChange({ from, to: end });
    // The panel stays open on purpose. antd has already closed the calendar,
    // and a range is the kind of thing people adjust twice — closing the panel
    // too also loses the race between its own commit and the popover's
    // outside-click handler, which reads as a control that ignores you.
  };

  const label = isCustom && range.from !== undefined
    ? (range.to === null
      ? `${dayjs(range.from).format('MM-DD')} – ${t('dash.range.until_now')}`
      : formatSpan(range.from, range.to as number))
    : t(`dash.range.${range.preset ?? '24h'}`);

  const panel = (
    <div className={`range-panel${tab === 'custom' ? ' is-wide' : ''}`}>
      <Tabs
        size="small"
        activeKey={tab}
        onChange={(key) => setTab(key as 'quick' | 'custom')}
        items={[
          {
            key: 'quick',
            label: t('dash.range.tab_quick'),
            children: (
              <ul className="range-options">
                {DASHBOARD_PRESETS.map((preset) => (
                  <li key={preset}>
                    <button
                      type="button"
                      className={`range-option${range.preset === preset ? ' is-active' : ''}`}
                      onClick={() => applyPreset(preset)}
                    >
                      {t(`dash.range.${preset}`)}
                    </button>
                  </li>
                ))}
              </ul>
            ),
          },
          {
            key: 'custom',
            label: t('dash.range.tab_custom'),
            children: (
              <RangePicker
                size="small"
                className="range-picker"
                onOpenChange={setPickerOpen}
                // An empty end *is* "至今" — antd built allowEmpty for exactly
                // this. It only works while the picker is day-granular: with
                // showTime on, antd collapses to a single panel and keeps 确
                // 定 disabled until the end has a value, which is what forces a
                // second control on top. Day granularity is also what the
                // two-month calendar is for.
                allowEmpty={[false, true]}
                placeholder={[t('dash.range.start_date'), t('dash.range.until_now')]}
                value={[
                  range.from === undefined ? null : dayjs(range.from),
                  typeof range.to === 'number' ? dayjs(range.to) : null,
                ]}
                onChange={(values: [Dayjs | null, Dayjs | null] | null) => {
                  applyCustom(values?.[0]?.valueOf(), values?.[1]?.valueOf() ?? null);
                }}
                disabledDate={(current: Dayjs) => current && current.valueOf() > Date.now()}
              />
            ),
          },
        ]}
      />
    </div>
  );

  return (
    <Popover
      open={open}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      content={panel}
      onOpenChange={(next) => {
        // The calendar lives outside this popover, so every click on it reads
        // as an outside click. While it is open, only our own actions close the
        // panel behind it.
        if (!next && pickerOpen) return;
        setOpen(next);
        if (next) begin();
      }}
    >
      <Button size="small" className="range-trigger">
        {label}
        <CaretDownOutlined className="range-trigger-caret" />
      </Button>
    </Popover>
  );
};
