import React from 'react';
import { Alert, App as AntdApp, Button, Checkbox, Empty, Input, Segmented, Space, Table, Tabs, Tooltip, Typography } from 'antd';
import {
  ClearOutlined,
  DownloadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { api, apiErrorCode, ApiError } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import { useLogTail } from '../hooks/useLogTail';
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport';
import { PhoneRow } from '../components/common/PhoneRow';
import { phoneRowFields, renderedCell } from '../components/common/phoneRowFields';
import { usePreference } from '../hooks/usePreference';
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
} from '../types/logs';

const { Text } = Typography;

/** RENDER_CHUNK is how many matching rows are mounted at a time. */
const RENDER_CHUNK = 300;

// Status classes are shown as the numeric class, not as invented English words:
// the log line itself says 400, and a localized UI must not caption it SUCCESS
// under a different reading language (design.md rule 3).
const STATUS_CLASS_LABELS: Record<LogStatusClass, string> = {
  all: '',
  success: '2xx',
  client: '4xx',
  server: '5xx',
};

interface LogRowProps {
  parts: LogLineParts;
}

/**
 * LogRow renders one line and reveals its raw text on demand.
 *
 * CPAMC flips the whole list between structured and raw. Per-row expansion is
 * strictly better: structure for the hundred lines being skimmed, raw text for
 * the one line that matters, without losing the surrounding context.
 */
const LogRow: React.FC<LogRowProps> = ({ parts }) => {
  const [expanded, setExpanded] = React.useState(false);
  const tone = statusTone(parts.status);
  return (
    <div
      className={`log-row${expanded ? ' is-open' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((next) => !next)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setExpanded((next) => !next);
        }
      }}
    >
      <div className="log-line">
        <span className="log-time">{parts.timestamp ?? ''}</span>
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
      {expanded && <pre className="log-raw">{parts.raw}</pre>}
    </div>
  );
};

const ErrorLogFiles: React.FC = () => {
  const t = useT();
  const isDemo = isDemoMode();
  const { message } = AntdApp.useApp();
  const query = useQuery({
    queryKey: ['request-error-logs'],
    queryFn: api.getRequestErrorLogs,
    meta: { silent: true },
    staleTime: 10000,
    placeholderData: keepPreviousData,
  });

  // Read above the early returns, because a hook cannot come after one.
  const isPhone = useIsPhoneViewport();

  if (query.isPending) return <div className="log-files-state">{t('logs.loading')}</div>;
  if (query.isError) {
    const code = apiErrorCode(query.error);
    return (
      <Alert
        type="warning"
        showIcon
        description={code === 'capability_missing' ? t('logs.errors_unsupported') : t('logs.errors_failed')}
      />
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
          render: (value: number) => `${(value / 1024).toFixed(1)} KB`,
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
                  const blob = await api.downloadRequestErrorLog(file.name);
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = file.name;
                  anchor.click();
                  URL.revokeObjectURL(url);
                } catch (err: unknown) {
                  message.error(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          ),
        },
  ];

  // Below 640px one file per row (ADR 0012): the file name is the headline, the size and the
  // modified time are labelled fields, and the download control gets its own line. The columns are
  // one description of a file, so the table and the row cannot disagree about what one shows.
  if (isPhone) {
    return (
      <div>
        {query.data.files.map((file, index) => (
          <PhoneRow
            key={file.name}
            identity={renderedCell(columns, 'name', file, index)}
            fields={phoneRowFields(columns, file, { skip: ['name', 'actions'], index })}
            actions={renderedCell(columns, 'actions', file, index)}
          />
        ))}
      </div>
    );
  }

  return (
    <Table<ErrorLogFile>
      size="small"
      rowKey="name"
      dataSource={query.data.files}
      pagination={false}
      columns={columns}
    />
  );
};

export const LogsPage: React.FC = () => {
  const t = useT();
  const isDemo = isDemoMode();
  const { message } = AntdApp.useApp();
  const { value: filters, ready: filtersReady, set: setFilters } = usePreference<LogFilters>(
    LOG_FILTERS_PREFERENCE,
    DEFAULT_LOG_FILTERS,
    parseLogFilters,
  );
  const [search, setSearch] = React.useState('');
  const [visibleCount, setVisibleCount] = React.useState(RENDER_CHUNK);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [tab, setTab] = React.useState<'tail' | 'errors'>('tail');
  // `pinned` is state, not a ref: the "back to the newest line" affordance has
  // to appear the moment the reader scrolls away, and a ref cannot re-render.
  const [pinned, setPinned] = React.useState(true);
  const listRef = React.useRef<HTMLDivElement>(null);

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

  const mounted = rows.slice(Math.max(0, rows.length - visibleCount));
  const hiddenByFilters = parsed.length - rows.length;

  React.useEffect(() => {
    const node = listRef.current;
    if (!node || !pinned) return;
    node.scrollTop = node.scrollHeight;
  }, [mounted, pinned]);

  const truncate = useMutation({
    mutationFn: api.clearLogs,
    onSuccess: () => {
      setConfirmClear(false);
      message.success(t('logs.clear_success'));
      tail.reload();
    },
    onError: (err: unknown) => {
      setConfirmClear(false);
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('logs.clear_failed', { err: msg }));
    },
  });

  // "Nothing to show" has three different reasons and they must not share a
  // message: blocked (no file), loading (no answer yet), empty (a live tail with
  // no lines). Showing "no log lines" while waiting, or while the switch is off,
  // is how a working page gets reported as broken.
  const statusError = status.error;
  const statusErrorMsg = statusError instanceof ApiError ? statusError.message : statusError instanceof Error ? statusError.message : String(statusError || '');
  let statusErrorTitle = t('logs.error_title');
  if (statusError instanceof ApiError) {
    if (statusError.status === 401 || statusError.status === 403) {
      statusErrorTitle = t('logs.auth_failed');
    } else if (statusError.status === 502 || statusError.status === 503) {
      statusErrorTitle = t('logs.offline_title');
    }
  }

  const blocked = status.isError || loggingDisabled || tail.phase === 'disabled' || tail.phase === 'unsupported' || tail.phase === 'offline' || tail.phase === 'error';
  const loading = !blocked && tail.phase === 'pending' && parsed.length === 0;

  return (
    <div className="terminal-page logs-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('nav.logs')}</h1>
        </div>
        <Space size={6} wrap>
          <Input
            size="small"
            allowClear
            className="logs-search"
            prefix={<SearchOutlined />}
            placeholder={t('logs.search_placeholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Tooltip title={tail.paused ? t('logs.resume') : t('logs.pause')}>
            <Button
              size="small"
              icon={tail.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
              disabled={blocked}
              onClick={() => tail.setPaused(!tail.paused)}
              aria-label={tail.paused ? t('logs.resume') : t('logs.pause')}
            />
          </Tooltip>
          <Tooltip title={t('logs.reload')}>
            <Button size="small" icon={<ReloadOutlined />} onClick={tail.reload} aria-label={t('logs.reload')} />
          </Tooltip>
          {confirmClear ? (
            <Space size={6}>
              <Button size="small" danger type="primary" loading={truncate.isPending} onClick={() => truncate.mutate()}>
                {t('logs.clear_confirm')}
              </Button>
              <Button size="small" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</Button>
            </Space>
          ) : (
            <Tooltip title={isDemo ? t('demo.blocked') : t('logs.clear_hint')}>
              <Button
                size="small"
                icon={<ClearOutlined />}
                disabled={isDemo}
                onClick={() => setConfirmClear(true)}
                aria-label={t('logs.clear')}
              />
            </Tooltip>
          )}
        </Space>
      </div>

      <div className="logs-toolbar">
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
          {t('logs.counts', { shown: rows.length, total: parsed.length, hidden: hiddenByFilters })}
          {tail.dropped > 0 ? ` · ${t('logs.dropped', { n: tail.dropped })}` : ''}
        </Text>
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
                {status.isError ? (
                  <Alert
                    className="logs-alert"
                    type="error"
                    showIcon
                    description={
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <Text strong>{statusErrorTitle}</Text>
                        <Text type="secondary">{statusErrorMsg}</Text>
                      </div>
                    }
                    action={
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={() => {
                          void status.refetch();
                        }}
                      >
                        {t('logs.retry')}
                      </Button>
                    }
                  />
                ) : loggingDisabled || tail.phase === 'disabled' ? (
                  <Alert
                    className="logs-alert"
                    type="warning"
                    showIcon
                    description={t('logs.disabled_title')}
                    action={
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
                    }
                  />
                ) : tail.phase === 'unsupported' ? (
                  <Alert className="logs-alert" type="warning" showIcon description={t('logs.unsupported_title')} />
                ) : tail.phase === 'offline' ? (
                  <Alert className="logs-alert" type="error" showIcon description={t('logs.offline_title')} />
                ) : tail.phase === 'error' ? (
                  <Alert className="logs-alert" type="error" showIcon description={`${t('logs.error_title')}: ${tail.message}`} />
                ) : null}

                {!blocked && (
                  <>
                    <div
                      className="log-list"
                      ref={listRef}
                      onScroll={(event) => {
                        const node = event.currentTarget;
                        setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
                      }}
                    >
                      {loading ? (
                        <div className="log-state">{t('logs.loading')}</div>
                      ) : mounted.length === 0 ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={parsed.length > 0 ? t('logs.filter_empty') : t('logs.tail_empty')}
                        />
                      ) : (
                        <>
                          {visibleCount < rows.length && (
                            <button type="button" className="log-more" onClick={() => setVisibleCount((next) => next + RENDER_CHUNK * 2)}>
                              {t('logs.show_more', { n: rows.length - visibleCount })}
                            </button>
                          )}
                          {mounted.map((parts, index) => <LogRow key={`${parts.raw}-${index}`} parts={parts} />)}
                        </>
                      )}
                    </div>
                    {!pinned && rows.length > 0 && (
                      <Button className="logs-jump" size="small" onClick={() => setPinned(true)}>
                        {t('logs.jump_latest')}
                      </Button>
                    )}
                  </>
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
    </div>
  );
};
