import React from 'react';
import { Alert, App as AntdApp, Button, Empty, Input, Segmented, Select, Tooltip } from 'antd';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import clsx from 'clsx';
import {
  ApiOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  DollarOutlined,
  DownloadOutlined,
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
  categoryOf,
  dayKey,
  DEFAULT_AUDIT_FILTERS,
  formatDetailValue,
  parseAuditSource,
  readableTarget,
  resultTone,
  type AuditEvent,
  type AuditFilters,
  type AuditOutcome,
} from '../../types/audit';
import { FactList, type Fact } from '../common/FactList';
import { RefreshButton } from '../common/RefreshButton';
import { StatusLabel } from '../common/StatusLabel';
import { CopyButton } from '../common/CopyButton';
import { PageLoading } from '../common/PageLoading';
import { saveBlob } from '../../utils/download';
import { auditActionLabel, auditResultLabel } from './auditText';
import styles from './Logs.module.css';

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

const AuditEntry: React.FC<{ event: AuditEvent }> = ({ event }) => {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  const category = categoryOf(event.action);
  const target = readableTarget(event);
  const source = parseAuditSource(event.source_summary);
  const tone = resultTone(event.result);
  const detailId = `audit-detail-${event.id}`;

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

/**
 * AuditTrail reads the operator audit log as a timeline: one entry per operation, grouped
 * by day, each a sentence ("Deleted a provider  gemini") with its outcome.
 *
 * The server folds a write's `attempt` row into the outcome it recorded, so an entry is an
 * operation rather than a pair of rows; an attempt that never recorded an outcome stays
 * visible as unfinished, because that is the one the operator needs to see.
 */
export const AuditTrail: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [filters, setFilters] = React.useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [searchDraft, setSearchDraft] = React.useState('');
  const [isExporting, setIsExporting] = React.useState(false);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) => (current.search === searchDraft ? current : { ...current, search: searchDraft }));
    }, SEARCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const query = useInfiniteQuery({
    queryKey: ['audit-events', filters],
    queryFn: ({ pageParam }) => api.getAuditEvents(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
    meta: { silent: true },
    staleTime: 10_000,
  });

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

  const isFiltered = filters.categories.length > 0 || filters.outcome !== 'all' || filters.search.trim() !== '';
  const category = Object.keys(AUDIT_CATEGORIES).find(
    (name) => AUDIT_CATEGORIES[name].join(',') === filters.categories.join(','),
  );

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
      <div className="logs-toolbar">
        <Input
          allowClear
          className={styles['audit-search']}
          prefix={<SearchOutlined />}
          placeholder={t('audit.search_placeholder')}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
        <Select
          className={styles['audit-category']}
          value={category ?? 'all'}
          aria-label={t('audit.all_categories')}
          options={[
            { value: 'all', label: t('audit.all_categories') },
            ...Object.keys(AUDIT_CATEGORIES).map((name) => ({ value: name, label: t(`audit.cat.${name}`) })),
          ]}
          onChange={(value: string) => setFilters((current) => ({
            ...current,
            categories: value === 'all' ? [] : [...AUDIT_CATEGORIES[value]],
          }))}
        />
        <Segmented
          size="small"
          value={filters.outcome}
          options={[
            { value: 'all', label: t('audit.outcome_all') },
            { value: 'succeeded', label: t('audit.outcome_succeeded') },
            { value: 'failed', label: t('audit.outcome_failed') },
          ]}
          onChange={(value) => setFilters((current) => ({ ...current, outcome: value as AuditOutcome }))}
        />
        <div className={styles['toolbar-actions']}>
          <RefreshButton
            isIconOnly
            label={t('logs.reload')}
            isRefreshing={query.isFetching && !query.isFetchingNextPage}
            onRefresh={() => void query.refetch()}
          />
          <Tooltip title={t('audit.export')}>
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
                {day.events.map((event) => <AuditEntry key={event.id} event={event} />)}
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
