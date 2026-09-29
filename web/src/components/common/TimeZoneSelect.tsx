import React from 'react';
import { Select } from 'antd';
import { useT } from '../../i18n';
import { timeZoneOptions } from '../../utils/time';
import styles from './TimeZoneSelect.module.css';

export interface TimeZoneSelectProps {
  value?: string;
  onChange: (timezone: string) => void;
  serverTimezone?: string;
  isDisabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

/** A controlled IANA-zone picker. Persistence and the meaning of a cleared override belong to its caller. */
export const TimeZoneSelect: React.FC<TimeZoneSelectProps> = ({ value, onChange, serverTimezone, isDisabled, id, 'aria-label': ariaLabel }) => {
  const t = useT();
  const serverLabel = t('omc.timezone_server');
  const [offsetMinute, setOffsetMinute] = React.useState(() => Math.floor(Date.now() / 60_000));
  const options = React.useMemo(
    () => timeZoneOptions(serverTimezone, value ?? '', serverLabel, offsetMinute * 60_000),
    [serverTimezone, value, serverLabel, offsetMinute],
  );
  const byZone = React.useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const renderZone = React.useCallback((zone: string) => (
    <span className={styles['timezone-option']}>
      <span className={styles['timezone-identity']}>
        <span className={styles['timezone-name']}>{zone}</span>
        {zone === serverTimezone && <span className={styles['timezone-source']}>{serverLabel}</span>}
      </span>
      <span className={styles['timezone-offset']}>{byZone.get(zone)?.offset}</span>
    </span>
  ), [serverTimezone, serverLabel, byZone]);
  return <Select
    id={id}
    disabled={isDisabled}
    className={styles['timezone-select']}
    classNames={{ popup: { root: styles['timezone-popup'] } }}
    showSearch={{ filterOption: (input, option) => String(option?.searchText ?? '').includes(input.replace(/_/g, ' ').toLowerCase()) }}
    popupMatchSelectWidth
    virtual
    listHeight={320}
    listItemHeight={64}
    onOpenChange={(isOpen) => { if (isOpen) setOffsetMinute(Math.floor(Date.now() / 60_000)); }}
    aria-label={ariaLabel ?? t('omc.timezone')}
    value={value || serverTimezone || 'UTC'}
    onChange={onChange}
    options={options}
    labelRender={({ value: zone }) => renderZone(String(zone))}
    optionRender={(option) => renderZone(String(option.value))}
  />;
};
