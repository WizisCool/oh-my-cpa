import { useTimeZone } from '../../utils/TimeZoneProvider';
import { formatGatewayTimestamp } from '../../utils/time';
import React from 'react';
import { Button, Checkbox, Empty, Input, Popconfirm, Segmented, Tabs, Tooltip, Typography } from 'antd';
import {
  ClearOutlined,
  DownloadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '../icons';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import dayjs from '../../utils/time';
import type { ColumnsType } from 'antd/es/table';
import { api, apiErrorCode, ApiError, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { useLogTail } from '../../hooks/useLogTail';
import { usePreference } from '../../hooks/usePreference';
import { RefreshButton } from '../common/RefreshButton';
import { ResponsiveList } from '../common/ResponsiveList';
import { saveBlob } from '../../utils/download';
import { formatBytes } from '../../utils/format';
import {
  DEFAULT_LOG_FILTERS,
  isManagementLine,
  LOG_LEVELS,
  LOG_STATUS_CLASSES,
  matchesStatusClass,
  parseLogFilters,
  parseLogLine,
  statusTone,
  LOG_FILTERS_PREFERENCE,
  type ErrorLogFile,
  type LogFilters,
  type LogLineParts,
  type LogStatusClass,
} from '../../types/logs';
import { LogList } from './LogList';
import styles from './Logs.module.css';
import { useToast } from '../feedback';
import { LoadFailure, Notice } from '../feedback';

const { Text } = Typography;

// Status classes are shown as the numeric class, not as invented English words:
// the log line itself says 400, and a localized UI must not caption it SUCCESS
// under a different reading language (design.md rule 3).
const STATUS_CLASS_LABELS: Record<LogStatusClass, string> = {
  all: '',
  success: '2xx',
  client: '4xx',
  server: '5xx',
};

/**
 * CpaLogLine renders one gateway line and reveals its raw text on demand.
 *
 * Per-row expansion rather than a whole-list raw mode: structure for the hundred lines
 * being skimmed, raw text for the one line that matters, without losing the context.
 */
const CpaLogLine: React.FC<{ parts: LogLineParts; isOpen: boolean }> = ({ parts, isOpen }) => {
  useTimeZone();
  const tone = statusTone(parts.status);
  return (
    <>
      <div className="log-line">
        <span className="log-time">{parts.timestamp ? formatGatewayTimestamp(parts.timestamp) : ''}</span>
        {parts.requestId && <span className="log-req">{parts.requestId}</span>}
        {parts.level && <span className={`log-level is-${parts.level}`}>{parts.level}</span>}
        {parts.status !== undefined && (
          <span className={`log-status${tone ? ` is-${tone}` : ''}`}>{parts.status}</span>
        )}
        {parts.method && <span className="log-method">{parts.method}</span>}
        {parts.path && <span className="log-path">{parts.path}</span>}
        {parts.latency && <span className="log-latency">{parts.latency}</span>}
        {parts.message && <span className="log-msg">{parts.message}</span>}
      </div>
      {isOpen && <pre className="log-raw">{parts.raw}</pre>}
    </>
  );
};

const ErrorLogFiles: React.FC = () => {
  useTimeZone();
  const t = useT();
  const isDemo = isDemoMode();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['request-error-logs'],
    queryFn: api.getRequestErrorLogs,
    meta: { silent: true },
    staleTime: 10000,
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <div className="log-files-state">{t('logs.loading')}</div>;
  if (query.isError) {
    const code = apiErrorCode(query.error);
    return (
      code === 'capability_missing'
        ? <Notice tone="warning" title={t('logs.errors_unsupported')} />
        : <LoadFailure tone="warning" title={t('logs.errors_failed')} onRetry={() => void query.refetch()} />
    );
  }
  if (query.data.files.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('logs.errors_empty')} />;
  }
  const columns: ColumnsType<ErrorLogFile> = [
    { title: t('logs.file_name'), dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: t('logs.file_size'),
      dataIndex: 'size',
      key: 'size',
      width: 96,
      render: (value: number) => formatBytes(value),
    },
    {
      title: t('logs.file_modified'),
      dataIndex: 'modified',
      key: 'modified',
      width: 150,
      render: (value: number) => (value ? dayjs.unix(value).format('MM-DD HH:mm:ss') : '—'),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      render: (_value, file) => (
        <Button
          size="small"
          type="text"
          icon={<DownloadOutlined />}
          aria-label={`${t('logs.download')} ${file.name}`}
          // An error log quotes request content, so the demonstration does not hand
          // one back at all; the server refuses the download too.
          disabled={isDemo}
          title={isDemo ? t('demo.blocked') : undefined}
          onClick={async () => {
            try {
              saveBlob(await api.downloadRequestErrorLog(file.name), file.name);
            } catch (err: unknown) {
              toast.error(describeError(err));
            }
          }}
        />
      ),
    },
  ];

  // Below 640px one file per row (ADR 0012): the file name is the headline, the size and the
  // modified time are labelled fields, and the download control gets its own line.
  return (
    <ResponsiveList
      columns={columns}
      dataSource={query.data.files}
      rowKey="name"
      isLoading={false}
      emptyText={t('logs.errors_empty')}
      phone={{ identity: 'name', actions: ['actions'] }}
      tableProps={{ size: 'small' }}
    />
  );
};

/** CpaLogPanel is the gateway's own log: CPA's file tail and its request error files. */
export const CpaLogPanel: React.FC = () => {
  useTimeZone();
  const t = useT();
  const isDemo = isDemoMode();
  const toast = useToast();
  const { value: filters, ready: filtersReady, set: setFilters } = usePreference<LogFilters>(
    LOG_FILTERS_PREFERENCE,
    DEFAULT_LOG_FILTERS,
    parseLogFilters,
  );
  const [search, setSearch] = React.useState('');
  const [tab, setTab] = React.useState<'tail' | 'errors'>('tail');

  const status = useQuery({
    queryKey: ['logs-status'],
    queryFn: api.getLogsStatus,
    meta: { silent: true },
    staleTime: 30000,
  });
  // CPA answers 400 for a tail it cannot serve. Asking anyway would be one
  // doomed request per visit; the status answer gates the tail instead.
  const loggingDisabled = status.isSuccess && status.data.logging_to_file === false;
  const tail = useLogTail(tab === 'tail' && filtersReady && status.isSuccess && !loggingDisabled);

  const patchFilters = React.useCallback((next: Partial<LogFilters>) => setFilters({ ...filters, ...next }), [filters, setFilters]);

  const parsed = React.useMemo(() => tail.lines.map((line) => parseLogLine(line)), [tail.lines]);

  const rows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return parsed.filter((line) => {
      if (filters.hideManagement && isManagementLine(line.raw)) return false;
      if (needle && !line.raw.toLowerCase().includes(needle)) return false;
      if (filters.levels.length > 0 && (!line.level || !filters.levels.includes(line.level))) return false;
      if (!matchesStatusClass(line.status, filters.statusClass)) return false;
      return true;
    });
  }, [filters, parsed, search]);

  const truncate = useMutation({
    mutationFn: api.clearLogs,
    onSuccess: () => {
      toast.success(t('logs.clear_success'));
      tail.reload();
    },
    onError: (err: unknown) => {
      toast.error(t('logs.clear_failed', { err: describeError(err) }));
    },
  });

  // "Nothing to show" has three different reasons and they must not share a
  // message: blocked (no file), loading (no answer yet), empty (a live tail with
  // no lines). Showing "no log lines" while waiting, or while the switch is off,
  // is how a working page gets reported as broken.
  const statusError = status.error;
  let statusErrorTitle = t('logs.error_title');
  if (statusError instanceof ApiError) {
    if (statusError.status === 401 || statusError.status === 403) {
      statusErrorTitle = t('logs.auth_failed');
    } else if (statusError.status === 502 || statusError.status === 503) {
      statusErrorTitle = t('logs.offline_title');
    }
  }

  const isBlocked = status.isError || loggingDisabled || tail.phase === 'disabled' || tail.phase === 'unsupported' || tail.phase === 'offline' || tail.phase === 'error';
  const isLoading = !isBlocked && tail.phase === 'pending' && parsed.length === 0;

  let blockedAlert: React.ReactNode = null;
  if (status.isError) {
    blockedAlert = (
      <LoadFailure
        className="logs-alert"
        title={statusErrorTitle}
        error={statusError ?? undefined}
        onRetry={() => void status.refetch()}
      />
    );
  } else if (loggingDisabled || tail.phase === 'disabled') {
    blockedAlert = (
      <Notice
        className="logs-alert"
        tone="warning"
        title={t('logs.disabled_title')}
        action={(
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => {
              void status.refetch();
              tail.reload();
            }}
          >
            {t('logs.retry')}
          </Button>
        )}
      />
    );
  } else if (tail.phase === 'unsupported') {
    blockedAlert = <Notice className="logs-alert" tone="warning" title={t('logs.unsupported_title')} />;
  } else if (tail.phase === 'offline') {
    blockedAlert = <Notice className="logs-alert" tone="error" title={t('logs.offline_title')} />;
  } else if (tail.phase === 'error') {
    blockedAlert = <LoadFailure className="logs-alert" title={t('logs.error_title')} detail={tail.message} onRetry={tail.reload} />;
  }

  const isTail = tab === 'tail';

  return (
    <section className={styles.panel}>
      <div className="logs-toolbar">
        {isTail && (
          <>
            <Input
              allowClear
              className="logs-search"
              prefix={<SearchOutlined />}
              placeholder={t('logs.search_placeholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Checkbox
              checked={filters.hideManagement}
              onChange={(event) => patchFilters({ hideManagement: event.target.checked })}
            >
              {t('logs.hide_management')}
            </Checkbox>
            <Segmented
              size="small"
              value={filters.statusClass}
              options={LOG_STATUS_CLASSES.map((value) => ({
                value,
                label: value === 'all' ? t('logs.status_all') : STATUS_CLASS_LABELS[value],
              }))}
              onChange={(value) => patchFilters({ statusClass: value as LogStatusClass })}
            />
            <div className="logs-levels">
              {LOG_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={filters.levels.includes(level)}
                  className={`log-level-chip is-${level}${filters.levels.includes(level) ? ' is-active' : ''}`}
                  onClick={() => patchFilters({
                    levels: filters.levels.includes(level)
                      ? filters.levels.filter((item) => item !== level)
                      : [...filters.levels, level],
                  })}
                >
                  {level}
                </button>
              ))}
            </div>
            <Text className="logs-counts">
              {t('logs.counts', { shown: rows.length, total: parsed.length })}
              {tail.dropped > 0 ? ` · ${t('logs.dropped', { n: tail.dropped })}` : ''}
            </Text>
          </>
        )}
        <div className={styles['toolbar-actions']}>
          {isTail && (
            <Tooltip title={tail.paused ? t('logs.resume') : t('logs.pause')}>
              <Button
                icon={tail.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                disabled={isBlocked}
                onClick={() => tail.setPaused(!tail.paused)}
                aria-label={tail.paused ? t('logs.resume') : t('logs.pause')}
              />
            </Tooltip>
          )}
          <RefreshButton isIconOnly label={t('logs.reload')} onRefresh={tail.reload} disabled={!isTail} />
          {/* Truncating the file is irreversible, so it asks first - in the same popover every
              other destructive action in the console uses. */}
          <Popconfirm
            title={t('logs.clear_hint')}
            okText={t('logs.clear_confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true, loading: truncate.isPending }}
            onConfirm={() => truncate.mutate()}
            disabled={isDemo}
          >
            <Tooltip title={isDemo ? t('demo.blocked') : t('logs.clear')}>
              <Button icon={<ClearOutlined />} disabled={isDemo} aria-label={t('logs.clear')} />
            </Tooltip>
          </Popconfirm>
        </div>
      </div>

      <Tabs
        size="small"
        activeKey={tab}
        onChange={(key) => setTab(key as 'tail' | 'errors')}
        items={[
          {
            key: 'tail',
            label: t('logs.tab_tail'),
            children: (
              <div className="logs-tail">
                {blockedAlert}
                {!isBlocked && (
                  <LogList
                    items={rows}
                    itemKey={(parts, index) => `${parts.raw}-${index}`}
                    isLoading={isLoading}
                    emptyText={parsed.length > 0 ? t('logs.filter_empty') : t('logs.tail_empty')}
                    renderItem={(parts, isOpen) => <CpaLogLine parts={parts} isOpen={isOpen} />}
                  />
                )}
              </div>
            ),
          },
          {
            key: 'errors',
            label: t('logs.tab_errors'),
            children: <div className="log-files"><ErrorLogFiles /></div>,
          },
        ]}
      />
    </section>
  );
};
