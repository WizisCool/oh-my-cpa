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
import { api, apiErrorCode } from '../api/client';
import { useT } from '../i18n';
import { useLogTail } from '../hooks/useLogTail';
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
// the log line itself says 400, and a Chinese UI must not caption it SUCCESS
// (design.md rule 3).
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
  const { message } = AntdApp.useApp();
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
      <Alert
        type="warning"
        showIcon
        message={code === 'capability_missing' ? t('logs.errors_unsupported') : t('logs.errors_failed')}
      />
    );
  }
  if (query.data.files.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('logs.errors_empty')} />;
  }
  return (
    <Table<ErrorLogFile>
      size="small"
      rowKey="name"
      dataSource={query.data.files}
      pagination={false}
      columns={[
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
      ]}
    />
  );
};

export const LogsPage: React.FC = () => {
  const t = useT();
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

  // Follow the tail unless the reader has scrolled away to read something.
  React.useEffect(() => {
    const node = listRef.current;
    if (!node || !pinned) return;
    node.scrollTop = node.scrollHeight;
  }, [mounted, pinned]);

  const truncate = useMutation({
    mutationFn: api.clearLogs,
    onSuccess: () => {
      setConfirmClear(false);
      tail.reload();
    },
    onError: () => setConfirmClear(false),
  });

  // "Nothing to show" has three different reasons and they must not share a
  // message: blocked (no file), loading (no answer yet), empty (a live tail with
  // no lines). Showing "no log lines" while waiting, or while the switch is off,
  // is how a working page gets reported as broken.
  const blocked = loggingDisabled || tail.phase === 'disabled' || tail.phase === 'unsupported';
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
            <Tooltip title={t('logs.clear_hint')}>
              <Button size="small" icon={<ClearOutlined />} onClick={() => setConfirmClear(true)} aria-label={t('logs.clear')} />
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
                {loggingDisabled || tail.phase === 'disabled' ? (
                  <Alert
                    className="logs-alert"
                    type="warning"
                    showIcon
                    message={t('logs.disabled_title')}
                    action={
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={() => {
                          // The switch may have been flipped elsewhere; retry
                          // means re-ask, not re-render.
                          void status.refetch();
                          tail.reload();
                        }}
                      >
                        {t('logs.retry')}
                      </Button>
                    }
                  />
                ) : tail.phase === 'unsupported' ? (
                  <Alert className="logs-alert" type="warning" showIcon message={t('logs.unsupported_title')} />
                ) : tail.phase === 'offline' ? (
                  <Alert className="logs-alert" type="error" showIcon message={t('logs.offline_title')} />
                ) : tail.phase === 'error' ? (
                  <Alert className="logs-alert" type="error" showIcon message={t('logs.error_title')} description={tail.message} />
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
