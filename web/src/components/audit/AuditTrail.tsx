import { FilterDisclosure } from '../common/FilterDisclosure';
import { ActionMenu } from '../common/ActionMenu';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Button, Input, Segmented, Select, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import dayjs from '../../utils/time';
import clsx from 'clsx';
import {
  ApiOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  DollarOutlined,
  DownloadOutlined,
  KeyOutlined,
  LoginOutlined,
  ProfileOutlined,
  RightOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '../icons';
import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import {
  AUDIT_CATEGORIES,
  auditFacets,
  categoryOf,
  dayKey,
  parseAuditSource,
  readableTarget,
  resultTone,
  selectedCategory,
  type AuditEvent,
  type AuditFilters,
  type AuditOutcome,
  type AuditRange,
} from '../../types/audit';
import { PageHeader } from '../common/PageHeader';
import { RefreshButton } from '../common/RefreshButton';
import { StatusLabel, type StatusTone } from '../common/StatusLabel';
import { ResponsiveList } from '../common/ResponsiveList';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { StatTiles } from '../common/StatTiles';
import { saveBlob } from '../../utils/download';
import { auditActionLabel, auditResultLabel } from './auditText';
import { AuditEventDrawer } from './AuditEventDrawer';
import styles from './Audit.module.css';
import { useToast } from '../feedback';
import { LoadFailure } from '../feedback';

/** How long typing settles before the search asks the server. */
const SEARCH_SETTLE_MS = 300;

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  access: <LoginOutlined />,
  keys: <KeyOutlined />,
  providers: <CloudServerOutlined />,
  credentials: <SafetyCertificateOutlined />,
  quota: <ThunderboltOutlined />,
  config: <SettingOutlined />,
  pricing: <DollarOutlined />,
  plugins: <ApiOutlined />,
  agent: <RobotOutlined />,
  system: <DatabaseOutlined />,
};

/** The outcome tiles, in reading order, with the tone of each one's label and count. */
const OUTCOME_TILES: readonly { outcome: AuditOutcome; tone: StatusTone }[] = [
  { outcome: 'all', tone: 'neutral' },
  { outcome: 'succeeded', tone: 'success' },
  { outcome: 'failed', tone: 'danger' },
  { outcome: 'unfinished', tone: 'warn' },
];

const RANGES: readonly AuditRange[] = ['24h', '7d', '30d', 'all'];

/** Only reached for the empty and loading states: a phone draws its own entry rows (`AuditPhoneEntry`). */
const AUDIT_PHONE_LAYOUT = { identity: 'operation', actions: ['actions'] } as const;

interface AuditPhoneEntryProps {
  event: AuditEvent;
  isOpen: boolean;
  onOpen: (event: AuditEvent) => void;
}

/**
 * One entry on a phone: the whole row is the control that opens it.
 *
 * The generic labelled row (`PhoneRow`) spent three label lines and a separate Details
 * button on every entry, so a phone screen held two and a half operations and each had to
 * be read field by field. An audit entry is one sentence and a verdict, so the row reads
 * as one: the sentence and its outcome on the first line, the target and the time under
 * it, and the rest behind the tap.
 */
const AuditPhoneEntry: React.FC<AuditPhoneEntryProps> = ({ event, isOpen, onOpen }) => {
  useTimeZone();
  const t = useT();
  const eventCategory = categoryOf(event.action);
  const target = readableTarget(event);
  const action = auditActionLabel(event.action, t);
  return (
    <li>
      <button
        type="button"
        className={clsx(styles['phone-entry'], isOpen && styles['phone-entry-open'])}
        onClick={() => onOpen(event)}
        aria-label={`${t('common.details')}: ${action}`}
        data-testid="audit-entry"
      >
        <span className={styles['audit-mark']} aria-hidden="true">
          {(eventCategory && CATEGORY_ICONS[eventCategory]) ?? <DatabaseOutlined />}
        </span>
        <span className={styles['phone-entry-body']}>
          <span className={styles['phone-entry-line']}>
            <span className={styles['audit-action']}>{action}</span>
            <StatusLabel tone={resultTone(event.result)} className={styles['phone-entry-result']}>{auditResultLabel(event.result, t)}</StatusLabel>
          </span>
          <span className={styles['phone-entry-meta']}>
            <span className={styles['audit-time']}>{dayjs(event.occurred_at_ms).format('HH:mm:ss')}</span>
            {target && <span className={styles['audit-target']}>{target}</span>}
            {!target && eventCategory && <span className={styles['audit-meta']}>{t(`audit.cat.${eventCategory}`)}</span>}
          </span>
        </span>
        <RightOutlined className={styles['phone-entry-chevron']} aria-hidden="true" />
      </button>
    </li>
  );
};

function dayHeading(key: string, t: ReturnType<typeof useT>): string {
  const today = dayKey(Date.now());
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const date = dayjs(key).format('YYYY-MM-DD');
  if (key === today) return `${t('audit.today')} · ${date}`;
  if (key === yesterday) return `${t('audit.yesterday')} · ${date}`;
  return date;
}

interface AuditTrailProps {
  title: React.ReactNode;
  filters: AuditFilters;
  onFiltersChange: (next: AuditFilters) => void;
}

/**
 * AuditTrail is the audit page's workspace: outcome tabs that count the window, a search and
 * filter row, and the trail as the console's one list surface - a frame per day, each row an
 * operation read as a sentence with its target and outcome - with the full entry in a Drawer.
 *
 * The server folds a write's `attempt` row into the outcome it recorded, so a row is an
 * operation rather than a pair of rows; an attempt that never recorded an outcome stays
 * visible as unfinished, because that is the one the operator needs to see. The filters are
 * owned by the caller (the page keeps them in its URL), so a link can open a filtered trail.
 */
export const AuditTrail: React.FC<AuditTrailProps> = ({ title, filters, onFiltersChange }) => {
  const timeZone = useTimeZone();
  const t = useT();
  const toast = useToast();
  const isPhone = useIsPhoneViewport();
  const [searchDraft, setSearchDraft] = React.useState(filters.search);
  const [isExporting, setIsExporting] = React.useState(false);
  const [openId, setOpenId] = React.useState<number>();
  const filtersRef = React.useRef(filters);
  filtersRef.current = filters;

  // A search set from outside the box (an entry's "only this target", Back) replaces the draft.
  React.useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  React.useEffect(() => {
    if (searchDraft.trim() === filtersRef.current.search) return undefined;
    const timer = window.setTimeout(() => {
      onFiltersChange({ ...filtersRef.current, search: searchDraft.trim() });
    }, SEARCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [searchDraft, onFiltersChange]);

  const query = useInfiniteQuery({
    queryKey: ['audit-events', filters],
    queryFn: ({ pageParam }) => api.getAuditEvents(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
    meta: { silent: true },
    staleTime: 10_000,
  });

  // Keyed on what the summary actually reads, so switching a facet reuses the matrix it
  // already has instead of asking the server to count the same rows again.
  const summary = useQuery({
    queryKey: ['audit-summary', filters.range, filters.search],
    queryFn: () => api.getAuditSummary(filters),
    placeholderData: keepPreviousData,
    meta: { silent: true },
    staleTime: 10_000,
  });

  const facets = React.useMemo(() => auditFacets(summary.data ?? [], filters), [summary.data, filters]);
  const events = React.useMemo(() => query.data?.pages.flatMap((page) => page.events) ?? [], [query.data]);
  const days = React.useMemo(() => {
    const groups: { key: string; events: AuditEvent[] }[] = [];
    for (const event of events) {
      const key = dayKey(event.occurred_at_ms);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.events.push(event);
      else groups.push({ key, events: [event] });
    }
    return groups;
  }, [events, timeZone]);

  const openIndex = openId === undefined ? -1 : events.findIndex((event) => event.id === openId);
  const openEvent = openIndex >= 0 ? events[openIndex] : undefined;

  const isFiltered = filters.categories.length > 0 || filters.outcome !== 'all' || filters.search.trim() !== '' || filters.range !== 'all';
  const category = selectedCategory(filters);
  const hasCounts = summary.data !== undefined;
  const isBlocked = query.isError && !query.data;
  // A filter change closes the open entry: it may leave the list, and the Drawer must not
  // reopen on its own when a later filter brings it back.
  const update = (patch: Partial<AuditFilters>) => {
    setOpenId(undefined);
    onFiltersChange({ ...filters, ...patch });
  };
  const refresh = () => {
    void query.refetch();
    void summary.refetch();
  };
  const closeDetail = React.useCallback(() => setOpenId(undefined), []);
  const navigateDetail = React.useCallback((event: AuditEvent) => setOpenId(event.id), []);
  const searchFromDetail = (needle: string) => update({ search: needle });

  const onExport = async () => {
    setIsExporting(true);
    try {
      saveBlob(await api.exportAuditEvents(filters), `omc-audit-${dayjs().format('YYYYMMDD-HHmmss')}.json`);
    } catch (err: unknown) {
      toast.error(t('audit.export_failed', { err: describeError(err) }));
    } finally {
      setIsExporting(false);
    }
  };

  const columns: ColumnsType<AuditEvent> = [
    {
      key: 'time',
      title: t('audit.field_time'),
      width: 96,
      render: (_, event) => (
        <span className={styles['audit-time']} title={dayjs(event.occurred_at_ms).format('YYYY-MM-DD HH:mm:ss.SSS')}>
          {dayjs(event.occurred_at_ms).format('HH:mm:ss')}
        </span>
      ),
    },
    {
      key: 'operation',
      title: t('audit.col_operation'),
      render: (_, event) => {
        const eventCategory = categoryOf(event.action);
        return (
          <span className={styles['audit-operation']}>
            <span className={styles['audit-mark']} aria-hidden="true">
              {(eventCategory && CATEGORY_ICONS[eventCategory]) ?? <DatabaseOutlined />}
            </span>
            <span className={styles['audit-action']}>{auditActionLabel(event.action, t)}</span>
          </span>
        );
      },
    },
    {
      key: 'target',
      title: t('audit.field_target'),
      render: (_, event) => {
        const target = readableTarget(event);
        return target
          ? <span className={styles['audit-target']} title={event.target_id}>{target}</span>
          : <span className={styles['audit-none']}>—</span>;
      },
    },
    {
      key: 'category',
      title: t('audit.col_category'),
      width: 140,
      render: (_, event) => {
        const eventCategory = categoryOf(event.action);
        return <span className={styles['audit-meta']}>{eventCategory ? t(`audit.cat.${eventCategory}`) : '—'}</span>;
      },
    },
    {
      key: 'source',
      title: t('audit.field_ip'),
      width: 160,
      render: (_, event) => <span className={styles['audit-meta']}>{parseAuditSource(event.source_summary).ip ?? '—'}</span>,
    },
    {
      key: 'result',
      title: t('audit.field_result'),
      width: 120,
      render: (_, event) => <StatusLabel tone={resultTone(event.result)}>{auditResultLabel(event.result, t)}</StatusLabel>,
    },
    {
      key: 'actions',
      title: t('common.details'),
      width: 92,
      align: 'right',
      render: (_, event) => (
        <Button
          size="small"
          icon={<ProfileOutlined />}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            setOpenId(event.id);
          }}
          aria-label={`${t('common.details')}: ${auditActionLabel(event.action, t)}`}
          data-testid="audit-open"
        >
          {t('common.details')}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={title}
        mobileActions={(
          <>
            <ActionMenu><RefreshButton label={t('common.refresh')} isRefreshing={(query.isFetching && !query.isFetchingNextPage) || summary.isFetching} onRefresh={refresh} /></ActionMenu>
            <Button icon={<DownloadOutlined />} loading={isExporting} onClick={() => void onExport()}>{t('audit.export')}</Button>
          </>
        )}
        actions={(
          <>
            <RefreshButton
              label={t('common.refresh')}
              isRefreshing={(query.isFetching && !query.isFetchingNextPage) || summary.isFetching}
              onRefresh={refresh}
            />
            <Tooltip title={t('audit.export_hint')}>
              <Button icon={<DownloadOutlined />} loading={isExporting} onClick={() => void onExport()}>
                {t('audit.export')}
              </Button>
            </Tooltip>
          </>
        )}
      />

      <StatTiles
        className={styles['audit-stats']}
        ariaLabel={t('audit.outcome_filter')}
        testId="audit-stats"
        tileTestIdPrefix="audit-stat"
        selected={filters.outcome}
        onSelect={(outcome) => update({ outcome })}
        tiles={OUTCOME_TILES.map(({ outcome, tone }) => ({
          key: outcome,
          label: outcome === 'all' ? t('audit.stat_all') : t(`audit.outcome_${outcome}`),
          count: hasCounts ? facets.outcomes[outcome] : undefined,
          tone,
        }))}
      />

      <div className={clsx('logs-toolbar', styles.toolbar)}>
        <Input
          allowClear
          className={styles['audit-search']}
          prefix={<SearchOutlined aria-hidden="true" />}
          placeholder={t('audit.search_placeholder')}
          aria-label={t('audit.search_placeholder')}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
        <FilterDisclosure activeLabel={[
          category ? t(`audit.cat.${category}`) : '',
          filters.range !== 'all' ? t(`audit.range_${filters.range}`) : '',
        ].filter(Boolean).join(' · ')}>
          <Select
            className={styles['audit-category']}
            value={category ?? 'all'}
            aria-label={t('audit.all_categories')}
            popupMatchSelectWidth={false}
            options={[
              { value: 'all', label: t('audit.all_categories') },
              ...Object.keys(AUDIT_CATEGORIES).map((name) => ({
                value: name,
                label: (
                  <span className={styles['category-option']}>
                    <span>{t(`audit.cat.${name}`)}</span>
                    {hasCounts && <span className={styles['category-count']}>{facets.categories[name] ?? 0}</span>}
                  </span>
                ),
              })),
            ]}
            onChange={(value: string) => update({ categories: value === 'all' ? [] : [...AUDIT_CATEGORIES[value]] })}
          />
          {/* A phone has no width for four segments beside the category, so the range is the
              same choice as a select sharing that row. */}
          {isPhone ? (
            <Select
              className={styles['audit-range']}
              value={filters.range}
              aria-label={t('audit.range_label')}
              options={RANGES.map((range) => ({ value: range, label: t(range === 'all' ? 'audit.range_all_time' : `audit.range_${range}`) }))}
              onChange={(value: AuditRange) => update({ range: value })}
            />
          ) : (
            <Segmented
              value={filters.range}
              aria-label={t('audit.range_label')}
              options={RANGES.map((range) => ({ value: range, label: t(`audit.range_${range}`) }))}
              onChange={(value) => update({ range: value as AuditRange })}
            />
          )}
          {isFiltered && (
            <Button type="link" className={styles['clear-filters']} onClick={() => update({ categories: [], outcome: 'all', search: '', range: 'all' })}>
              {t('audit.clear_filters')}
            </Button>
          )}
        </FilterDisclosure>
      </div>

      {isBlocked && (
        <LoadFailure
          className={styles['audit-alert']}
          title={t('audit.load_failed')}
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}

      {days.length === 0 ? (
        <ResponsiveList<AuditEvent>
          columns={columns}
          dataSource={[]}
          rowKey="id"
          isLoading={query.isPending}
          isBlocked={isBlocked}
          emptyText={isFiltered ? t('audit.filter_empty') : t('audit.empty')}
          phone={AUDIT_PHONE_LAYOUT}
        />
      ) : (
        <div className={clsx(styles['audit-trail'], query.isPlaceholderData && styles['audit-trail-stale'])} data-testid="audit-trail">
          {days.map((day, index) => (
            <section key={day.key} className={styles['audit-day']} aria-label={dayHeading(day.key, t)}>
              <header className={styles['audit-day-head']}>
                <h2>{dayHeading(day.key, t)}</h2>
                {/* The oldest day loaded may continue on the next page, and a count of what
                    happens to be loaded would read as the day's total. */}
                {(index < days.length - 1 || !query.hasNextPage) && (
                  <span className={styles['audit-day-count']}>{t('audit.day_count', { n: day.events.length })}</span>
                )}
              </header>
              {/* Every day has the same columns, so their names are drawn once, above the
                  first day; later days keep the header row for assistive technology. */}
              {isPhone ? (
                <ol className={clsx('data-table', styles['phone-list'])}>
                  {day.events.map((event) => (
                    <AuditPhoneEntry key={event.id} event={event} isOpen={event.id === openId} onOpen={navigateDetail} />
                  ))}
                </ol>
              ) : (
                <ResponsiveList<AuditEvent>
                  columns={columns}
                  dataSource={day.events}
                  rowKey="id"
                  isLoading={false}
                  emptyText={null}
                  phone={AUDIT_PHONE_LAYOUT}
                  tableProps={{
                    size: 'small',
                    className: index > 0 ? 'data-table-head-hidden' : undefined,
                    tableLayout: 'fixed',
                    onRow: (event) => ({
                      onClick: () => setOpenId(event.id),
                      className: clsx(styles['audit-row'], event.id === openId && styles['audit-row-open']),
                      'data-testid': 'audit-entry',
                    } as React.HTMLAttributes<HTMLElement>),
                  }}
                />
              )}
            </section>
          ))}
          <div className={styles['audit-footer']}>
            {query.hasNextPage ? (
              <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
                {t('audit.load_more')}
              </Button>
            ) : (
              <span>{t('audit.end')}</span>
            )}
          </div>
        </div>
      )}

      <AuditEventDrawer
        event={openEvent}
        newer={openIndex > 0 ? events[openIndex - 1] : undefined}
        older={openIndex >= 0 && openIndex < events.length - 1 ? events[openIndex + 1] : undefined}
        onNavigate={navigateDetail}
        onClose={closeDetail}
        onSearch={searchFromDetail}
      />
    </>
  );
};
