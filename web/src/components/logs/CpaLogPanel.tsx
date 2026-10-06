import { useTimeZone } from '../../utils/TimeZoneProvider';
import { formatGatewayTimestamp } from '../../utils/time';
import React from 'react';
import { createPortal } from 'react-dom';
import { Button, Checkbox, Empty, Input, Popconfirm, Segmented, Select, Tabs, Tooltip, Typography } from 'antd';
import {
  ClearOutlined,
  DownloadOutlined,
  FilterOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  WrapTextOutlined,
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
  countLogFacets,
  DEFAULT_LOG_FILTERS,
  LOG_LEVELS,
  LOG_METHODS,
  LOG_STATUS_CLASSES,
  matchesLogFilters,
  MAX_LOG_PATH_FILTERS,
  parseLogFilters,
  shouldExitLogFullscreen,
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
import { ParagraphPlaceholder } from '../common/ContentPlaceholder';

const { Text } = Typography;

// Status classes are shown as the numeric class, not as invented English words:
// the log line itself says 400, and a localized UI must not caption it SUCCESS
// under a different reading language (design.md rule 3).
/** Anything of antd's that Escape should close before it closes the fullscreen viewer. */
const OPEN_OVERLAY_SELECTOR = '.ant-select-open, .ant-popover:not(.ant-popover-hidden), .ant-modal-wrap:not([style*="display: none"])';

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

  if (query.isPending) return <ParagraphPlaceholder rows={4} className="log-files-state" />;
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

  const needle = search.trim().toLowerCase();
  const rows = React.useMemo(() => parsed.filter((line) => matchesLogFilters(line, filters, needle)), [filters, parsed, needle]);
  const facets = React.useMemo(() => countLogFacets(parsed, filters, needle), [filters, parsed, needle]);
  // A method stays offered while it is selected, so a filter that now matches nothing can
  // still be switched off.
  const offeredMethods = LOG_METHODS.filter((method) => (facets.methods[method] ?? 0) > 0 || filters.methods.includes(method));

  // The request filters open on demand: the toolbar keeps what every visit uses - search and
  // level - and a count on the button says when something out of sight is narrowing the list.
  const [isFiltersOpen, setIsFiltersOpen] = React.useState(false);
  const activeFilterCount = (filters.statusClass === 'all' ? 0 : 1) + (filters.methods.length > 0 ? 1 : 0) + (filters.paths.length > 0 ? 1 : 0);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const panelRef = React.useRef<HTMLElement>(null);
  // The panel renders into a host element that is moved between its place in the page and
  // the document body. A routed page sits inside a transformed container, which would
  // confine `position: fixed` to the content area; moving the host instead of rendering
  // twice keeps the tail, the scroll position's pin and every open row across the switch.
  const [panelHost] = React.useState(() => document.createElement('div'));
  const slotRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    (isFullscreen ? document.body : slotRef.current)?.appendChild(panelHost);
    return () => panelHost.remove();
  }, [isFullscreen, panelHost]);
  React.useEffect(() => {
    if (!isFullscreen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasOpenOverlay = document.querySelector(OPEN_OVERLAY_SELECTOR) !== null;
      if (shouldExitLogFullscreen(event.key, event.defaultPrevented, hasOpenOverlay)) setIsFullscreen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    // The viewer covers the page, so focus moves into it: Escape and Tab then act on what
    // the reader is looking at rather than on the navigation underneath.
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

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
    <div ref={slotRef}>
      {createPortal((
        <section
          ref={panelRef}
          tabIndex={-1}
          className={`${styles.panel}${isFullscreen ? ` ${styles['panel-fullscreen']}` : ''}`}
        >
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
                <Button
                  icon={<FilterOutlined />}
                  className={styles['filter-toggle']}
                  aria-expanded={isFiltersOpen}
                  aria-controls="log-request-filters"
                  type={isFiltersOpen || activeFilterCount > 0 ? 'primary' : 'default'}
                  onClick={() => setIsFiltersOpen((isOpen) => !isOpen)}
                >
                  {activeFilterCount > 0 ? t('logs.filters_active', { n: activeFilterCount }) : t('events.more_filters')}
                </Button>
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
              {isTail && (
                <Tooltip title={t('logs.wrap')}>
                  <Button
                    icon={<WrapTextOutlined />}
                    type={filters.wrapLines ? 'primary' : 'default'}
                    aria-pressed={filters.wrapLines}
                    aria-label={t('logs.wrap')}
                    onClick={() => patchFilters({ wrapLines: !filters.wrapLines })}
                  />
                </Tooltip>
              )}
              <Tooltip title={isFullscreen ? t('logs.fullscreen_exit') : t('logs.fullscreen')}>
                <Button
                  icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                  aria-pressed={isFullscreen}
                  aria-label={isFullscreen ? t('logs.fullscreen_exit') : t('logs.fullscreen')}
                  onClick={() => setIsFullscreen(!isFullscreen)}
                />
              </Tooltip>
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

          {isTail && isFiltersOpen && (
            <div id="log-request-filters" className={styles.filters}>
              <div className={styles['filter-field']}>
                <span className={styles['filter-label']}>{t('logs.status_filter')}</span>
                <Segmented
                  size="small"
                  value={filters.statusClass}
                  options={LOG_STATUS_CLASSES.map((value) => ({
                    value,
                    label: value === 'all' ? t('logs.status_all') : STATUS_CLASS_LABELS[value],
                  }))}
                  onChange={(value) => patchFilters({ statusClass: value as LogStatusClass })}
                />
              </div>
              <div className={styles['filter-field']}>
                <span className={styles['filter-label']}>{t('logs.method_filter')}</span>
                {offeredMethods.length > 0 ? (
                  <div className="logs-levels" role="group" aria-label={t('logs.method_filter')}>
                    {offeredMethods.map((method) => {
                      const isActive = filters.methods.includes(method);
                      return (
                        <button
                          key={method}
                          type="button"
                          aria-pressed={isActive}
                          className={`log-level-chip${isActive ? ' is-active' : ''}`}
                          onClick={() => patchFilters({
                            methods: isActive
                              ? filters.methods.filter((item) => item !== method)
                              : LOG_METHODS.filter((item) => item === method || filters.methods.includes(item)),
                          })}
                        >
                          {method}
                          <span className={styles['method-count']}>{facets.methods[method] ?? 0}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : <span className={styles['filter-empty']}>{t('logs.no_requests')}</span>}
              </div>
              <div className={`${styles['filter-field']} ${styles['filter-field-wide']}`}>
                <span className={styles['filter-label']}>{t('logs.path_filter')}</span>
                {facets.paths.length > 0 ? (
                  <Select
                    mode="multiple"
                    allowClear
                    maxTagCount="responsive"
                    maxCount={MAX_LOG_PATH_FILTERS}
                    className={styles['path-select']}
                    popupMatchSelectWidth={false}
                    placeholder={t('logs.path_filter')}
                    aria-label={t('logs.path_filter')}
                    value={filters.paths}
                    onChange={(paths: string[]) => patchFilters({ paths })}
                    options={facets.paths.map((option) => ({ value: option.path, count: option.count }))}
                    optionRender={(option) => (
                      <span className={styles['path-option']}>
                        <span className={styles['path-option-name']}>{option.value}</span>
                        <span className={styles['path-option-count']}>{option.data.count}</span>
                      </span>
                    )}
                  />
                ) : <span className={styles['filter-empty']}>{t('logs.no_requests')}</span>}
              </div>
              <Checkbox
                className={styles['filter-check']}
                checked={filters.hideManagement}
                onChange={(event) => patchFilters({ hideManagement: event.target.checked })}
              >
                {t('logs.hide_management')}
              </Checkbox>
              {activeFilterCount > 0 && (
                <Button
                  type="link"
                  size="small"
                  className={styles['filter-clear']}
                  onClick={() => patchFilters({ statusClass: 'all', methods: [], paths: [] })}
                >
                  {t('logs.filters_clear')}
                </Button>
              )}
            </div>
          )}

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
                        isWrapped={filters.wrapLines}
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
      ), panelHost)}
    </div>
  );
};
