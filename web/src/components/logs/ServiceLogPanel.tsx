import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Alert, Button, Input, Tooltip, Typography } from 'antd';
import dayjs from '../../utils/time';
import { PauseCircleOutlined, PlayCircleOutlined, SearchOutlined } from '../icons';
import { useT } from '../../i18n';
import { useServiceLogTail } from '../../hooks/useServiceLogTail';
import { SERVICE_LOG_LEVELS, type ServiceLogRecord } from '../../types/logs';
import { RefreshButton } from '../common/RefreshButton';
import { CopyButton } from '../common/CopyButton';
import { LogList } from './LogList';
import styles from './Logs.module.css';

const { Text } = Typography;

type ServiceLogLevel = (typeof SERVICE_LOG_LEVELS)[number];

/** How many fields a collapsed row shows before the rest wait for the expanded view. */
const INLINE_ATTRS = 4;

function recordJSON(record: ServiceLogRecord): string {
  const fields = Object.fromEntries((record.attrs ?? []).map((attr) => [attr.key, attr.value]));
  return JSON.stringify(
    { time: dayjs(record.logged_at_ms).format('YYYY-MM-DDTHH:mm:ss.SSSZ'), level: record.level, msg: record.message, ...fields },
    null,
    2,
  );
}

const ServiceLogLine: React.FC<{ record: ServiceLogRecord; isOpen: boolean }> = ({ record, isOpen }) => {
  useTimeZone();
  const t = useT();
  const attrs = record.attrs ?? [];
  return (
    <>
      <div className="log-line">
        <span className="log-time">{dayjs(record.logged_at_ms).format('MM-DD HH:mm:ss.SSS')}</span>
        <span className={`log-level is-${record.level}`}>{record.level}</span>
        <span className={styles['service-message']}>{record.message}</span>
        {attrs.slice(0, INLINE_ATTRS).map((attr) => (
          <span key={attr.key} className={styles['service-attr']}>
            <span className={styles['service-attr-key']}>{attr.key}=</span>{attr.value}
          </span>
        ))}
        {attrs.length > INLINE_ATTRS && <span className={styles['service-attr']}>+{attrs.length - INLINE_ATTRS}</span>}
      </div>
      {isOpen && (
        // The copy control sits inside a row that toggles on click, so it keeps its
        // click to itself.
        <div className={styles['service-detail']} onClick={(event) => event.stopPropagation()} role="presentation">
          <pre className="log-raw">{recordJSON(record)}</pre>
          <CopyButton text={recordJSON(record)} label={t('logs.copy_record')} className={styles['service-copy']} />
        </div>
      )}
    </>
  );
};

/**
 * ServiceLogPanel is Oh My CPA's own log - the records it writes to stderr - read from the
 * bounded copy the server keeps, so an operator can see what the console's backend did
 * without shell access to its container.
 */
export const ServiceLogPanel: React.FC = () => {
  useTimeZone();
  const t = useT();
  const tail = useServiceLogTail(true);
  const [search, setSearch] = React.useState('');
  const [levels, setLevels] = React.useState<ServiceLogLevel[]>([]);

  const rows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tail.records.filter((record) => {
      if (levels.length > 0 && !levels.includes(record.level)) return false;
      if (!needle) return true;
      if (record.message.toLowerCase().includes(needle)) return true;
      return (record.attrs ?? []).some((attr) => `${attr.key}=${attr.value}`.toLowerCase().includes(needle));
    });
  }, [levels, search, tail.records]);

  const isBlocked = tail.phase === 'off' || tail.phase === 'error';

  return (
    <section className={styles.panel}>
      <div className="logs-toolbar">
        <Input
          allowClear
          className="logs-search"
          prefix={<SearchOutlined />}
          placeholder={t('logs.service_search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="logs-levels">
          {SERVICE_LOG_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={levels.includes(level)}
              className={`log-level-chip is-${level}${levels.includes(level) ? ' is-active' : ''}`}
              onClick={() => setLevels((current) => (current.includes(level)
                ? current.filter((item) => item !== level)
                : [...current, level]))}
            >
              {level}
            </button>
          ))}
        </div>
        <Text className="logs-counts">
          {t('logs.service_counts', { shown: rows.length, total: tail.records.length })}
          {tail.capacity && tail.startedAtMS
            ? ` · ${t('logs.service_retention', { capacity: tail.capacity, since: dayjs(tail.startedAtMS).format('MM-DD HH:mm') })}`
            : ''}
        </Text>
        <div className={styles['toolbar-actions']}>
          <Tooltip title={tail.paused ? t('logs.resume') : t('logs.pause')}>
            <Button
              icon={tail.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
              disabled={isBlocked}
              onClick={() => tail.setPaused(!tail.paused)}
              aria-label={tail.paused ? t('logs.resume') : t('logs.pause')}
            />
          </Tooltip>
          <RefreshButton isIconOnly label={t('logs.reload')} onRefresh={tail.reload} />
        </div>
      </div>

      <div className="logs-tail">
        {tail.phase === 'off' && <Alert className="logs-alert" type="info" showIcon title={t('logs.service_off')} />}
        {tail.phase === 'error' && (
          <Alert className="logs-alert" type="error" showIcon title={t('logs.service_failed')} description={tail.message} />
        )}
        {!isBlocked && (
          <LogList
            items={rows}
            itemKey={(record) => String(record.seq)}
            isLoading={tail.phase === 'pending' && tail.records.length === 0}
            emptyText={tail.records.length > 0 ? t('logs.filter_empty') : t('logs.service_empty')}
            header={tail.hasGap ? <div className={styles['service-gap']}>{t('logs.service_gap')}</div> : undefined}
            renderItem={(record, isOpen) => <ServiceLogLine record={record} isOpen={isOpen} />}
          />
        )}
      </div>
    </section>
  );
};
