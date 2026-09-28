import React from 'react';
import { Alert, App as AntdApp, Button, Empty, Input, Segmented, Select, Tooltip } from 'antd';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import clsx from 'clsx';
import {
  ApiOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  DollarOutlined,
  DownloadOutlined,
  FilterOutlined,
  KeyOutlined,
  LoginOutlined,
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
  formatDetailValue,
  parseAuditSource,
  readableTarget,
  resultTone,
  selectedCategory,
  type AuditEvent,
  type AuditFilters,
  type AuditOutcome,
  type AuditRange,
} from '../../types/audit';
import { FactList, type Fact } from '../common/FactList';
import { RefreshButton } from '../common/RefreshButton';
import { StatusLabel, type StatusTone } from '../common/StatusLabel';
import { StatTiles } from '../common/StatTiles';
import { CopyButton } from '../common/CopyButton';
import { PageLoading } from '../common/PageLoading';
import { saveBlob } from '../../utils/download';
import { auditActionLabel, auditResultLabel } from './auditText';
import styles from './Audit.module.css';

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

/** The outcome tiles, in reading order, with the tone each one's count is painted in. */
const OUTCOME_TILES: readonly { outcome: AuditOutcome; tone: StatusTone }[] = [
  { outcome: 'all', tone: 'neutral' },
  { outcome: 'succeeded', tone: 'success' },
  { outcome: 'failed', tone: 'danger' },
  { outcome: 'unfinished', tone: 'warn' },
];

const RANGES: readonly AuditRange[] = ['24h', '7d', '30d', 'all'];

interface AuditEntryProps {
  event: AuditEvent;
  /** Narrows the trail to one identifier, from the entry's own detail. */
  onSearch: (needle: string) => void;
}

const AuditEntry: React.FC<AuditEntryProps> = ({ event, onSearch }) => {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  const category = categoryOf(event.action);
  const target = readableTarget(event);
  const source = parseAuditSource(event.source_summary);
  const tone = resultTone(event.result);
  const detailId = `audit-detail-${event.id}`;
  const targetId = event.target_id.trim();

  const facts: Fact[] = [
    { key: 'time', label: t('audit.field_time'), value: dayjs(event.occurred_at_ms).format('YYYY-MM-DD HH:mm:ss.SSS') },
    { key: 'action', label: t('audit.field_action'), value: <code>{event.action}</code> },
    {
      key: 'target',
      label: t('audit.field_target'),
      value: <span className={styles['audit-mono']}>{[event.target_type, event.target_id].filter(Boolean).join(' / ') || '—'}</span>,
    },
    { key: 'result', label: t('audit.field_result'), value: <StatusLabel tone={tone}>{auditResultLabel(event.result, t)}</StatusLabel> },
  ];
  if (event.request_id) {
    facts.push({
      key: 'request',
      label: t('audit.field_request'),
      value: (
        <span className={styles['audit-copyable']}>
          <span className={styles['audit-mono']}>{event.request_id}</span>
          <CopyButton text={event.request_id} />
        </span>
      ),
    });
  }
  if (source.ip) facts.push({ key: 'ip', label: t('audit.field_ip'), value: source.ip });
  if (source.userAgent) facts.push({ key: 'agent', label: t('audit.field_agent'), value: source.userAgent });
  for (const [key, value] of Object.entries(event.details ?? {})) {
    facts.push({ key: `detail-${key}`, label: key, value: <span className={styles['audit-mono']}>{formatDetailValue(value)}</span> });
  }

  return (
    <li className={clsx(styles['audit-entry'], isOpen && styles['audit-entry-open'])} data-testid="audit-entry">
      <button
        type="button"
        className={styles['audit-summary']}
        aria-expanded={isOpen}
        aria-controls={detailId}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className={styles['audit-time']}>{dayjs(event.occurred_at_ms).format('HH:mm:ss')}</span>
        <span className={clsx(styles['audit-icon'], styles[`tone-${tone}`])} aria-hidden="true">
          {(category && CATEGORY_ICONS[category]) ?? <DatabaseOutlined />}
        </span>
        <span className={styles['audit-text']}>
          <span className={styles['audit-sentence']}>
            <span className={styles['audit-action']}>{auditActionLabel(event.action, t)}</span>
            {target && <span className={styles['audit-target']}>{target}</span>}
          </span>
          <span className={styles['audit-meta']}>
            {[category ? t(`audit.cat.${category}`) : undefined, source.ip].filter(Boolean).join(' · ')}
          </span>
        </span>
        <StatusLabel tone={tone} className={styles['audit-result']}>{auditResultLabel(event.result, t)}</StatusLabel>
      </button>
      {isOpen && (
        <div id={detailId} className={styles['audit-detail']}>
          <FactList facts={facts} emphasis="quiet" />
          {/* The two questions a single entry raises: what else happened to this thing, and
              what else did this one request do. Both are the trail's own search. */}
          {(targetId || event.request_id) && (
            <div className={styles['audit-detail-actions']}>
              {targetId && (
                <Button size="small" icon={<FilterOutlined />} onClick={() => onSearch(targetId)}>
                  {t('audit.only_target')}
                </Button>
              )}
              {event.request_id && (
                <Button size="small" icon={<FilterOutlined />} onClick={() => onSearch(event.request_id)}>
                  {t('audit.only_request')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
};

function dayHeading(key: string, t: ReturnType<typeof useT>): string {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  const date = dayjs(key).format('YYYY-MM-DD');
  if (key === today) return `${t('audit.today')} · ${date}`;
  if (key === yesterday) return `${t('audit.yesterday')} · ${date}`;
  return date;
}

interface AuditTrailProps {
  filters: AuditFilters;
  onFiltersChange: (next: AuditFilters) => void;
}

/**
 * AuditTrail reads the operator audit log as a timeline: one entry per operation, grouped
 * by day, each a sentence ("Deleted a provider  gemini") with its outcome, under a strip that
 * counts the window by outcome.
 *
 * The server folds a write's `attempt` row into the outcome it recorded, so an entry is an
 * operation rather than a pair of rows; an attempt that never recorded an outcome stays
 * visible as unfinished, because that is the one the operator needs to see. The filters are
 * owned by the caller (the page keeps them in its URL), so a link can open a filtered trail.
 */
export const AuditTrail: React.FC<AuditTrailProps> = ({ filters, onFiltersChange }) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [searchDraft, setSearchDraft] = React.useState(filters.search);
  const [isExporting, setIsExporting] = React.useState(false);
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
  }, [events]);

  const isFiltered = filters.categories.length > 0 || filters.outcome !== 'all' || filters.search.trim() !== '' || filters.range !== 'all';
  const category = selectedCategory(filters);
  const hasCounts = summary.data !== undefined;
  const update = (patch: Partial<AuditFilters>) => onFiltersChange({ ...filters, ...patch });
  const refresh = () => {
    void query.refetch();
    void summary.refetch();
  };

  const onExport = async () => {
    setIsExporting(true);
    try {
      saveBlob(await api.exportAuditEvents(filters), `omc-audit-${dayjs().format('YYYYMMDD-HHmmss')}.json`);
    } catch (err: unknown) {
      message.error(t('audit.export_failed', { err: describeError(err) }));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <section className={styles.panel}>
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

      <div className="logs-toolbar">
        <Input
          allowClear
          className={styles['audit-search']}
          prefix={<SearchOutlined />}
          placeholder={t('audit.search_placeholder')}
          aria-label={t('audit.search_placeholder')}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
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
        <Segmented
          size="small"
          value={filters.range}
          aria-label={t('audit.range_label')}
          options={RANGES.map((range) => ({ value: range, label: t(`audit.range_${range}`) }))}
          onChange={(value) => update({ range: value as AuditRange })}
        />
        <div className={styles['toolbar-actions']}>
          {isFiltered && (
            <Button type="link" size="small" onClick={() => onFiltersChange({ categories: [], outcome: 'all', search: '', range: 'all' })}>
              {t('audit.clear_filters')}
            </Button>
          )}
          <RefreshButton
            isIconOnly
            label={t('logs.reload')}
            isRefreshing={(query.isFetching && !query.isFetchingNextPage) || summary.isFetching}
            onRefresh={refresh}
          />
          <Tooltip title={t('audit.export_hint')}>
            <Button icon={<DownloadOutlined />} loading={isExporting} onClick={() => void onExport()} aria-label={t('audit.export')}>
              <span className={styles['action-label']}>{t('audit.export')}</span>
            </Button>
          </Tooltip>
        </div>
      </div>

      {query.isError && !query.data ? (
        <Alert
          className="logs-alert"
          type="error"
          showIcon
          title={t('audit.load_failed')}
          description={describeError(query.error)}
          action={<Button size="small" onClick={() => void query.refetch()}>{t('logs.retry')}</Button>}
        />
      ) : query.isPending ? (
        <PageLoading variant="block" />
      ) : events.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isFiltered ? t('audit.filter_empty') : t('audit.empty')} />
      ) : (
        <div className={clsx(styles['audit-trail'], query.isPlaceholderData && styles['audit-trail-stale'])} data-testid="audit-trail">
          {days.map((day, index) => (
            <section key={day.key} className={styles['audit-day']} aria-label={dayHeading(day.key, t)}>
              <header className={styles['audit-day-head']}>
                <span>{dayHeading(day.key, t)}</span>
                {/* The oldest day loaded may continue on the next page, and a count of what
                    happens to be loaded would read as the day's total. */}
                {(index < days.length - 1 || !query.hasNextPage) && (
                  <span className={styles['audit-day-count']}>{t('audit.day_count', { n: day.events.length })}</span>
                )}
              </header>
              <ol className={styles['audit-list']}>
                {day.events.map((event) => (
                  <AuditEntry key={event.id} event={event} onSearch={(needle) => update({ search: needle })} />
                ))}
              </ol>
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
    </section>
  );
};
