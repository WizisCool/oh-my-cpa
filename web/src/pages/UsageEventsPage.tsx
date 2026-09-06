import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
  Input,
  Listy,
  Popover,
  Segmented,
  Select,
  Skeleton,
  Tooltip,
} from 'antd';
import {
  ArrowRightOutlined,
  FileTextOutlined,
  FilterOutlined,
  InfoCircleOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { useT } from '../i18n';
import {
  usageEventParams,
  type UsageEvent,
  type UsageEventPage,
  type UsageFacetValue,
} from '../types/usageEvents';
import {
  indexCredentialFiles,
  resolveCredential,
  requestGroupName,
  type CredentialIndex,
  EVENT_FILTER_KEYS,
  EVENT_PRESETS,
  eventPageMetrics,
  eventWindow,
  formatEventDuration,
  readEventQuery,
} from '../types/usageEventView';
import { UsageEventDrawer } from '../components/usage/UsageEventDrawer';
import './UsageEventsPage.css';

interface IngestStatus {
  enabled?: boolean;
  healthy?: boolean;
  collector?: {
    mode?: string;
    running?: boolean;
    captured?: number;
    coverage_gaps?: number;
    last_error?: string;
  };
  stats?: { pending?: number };
}

const RequestRow = React.memo(
  ({
    event,
    credentials,
    onOpen,
  }: {
    event: UsageEvent;
    credentials: CredentialIndex;
    onOpen: (id: number) => void;
  }) => {
    const t = useT();
    const identity = resolveCredential(event, credentials);
    const credential = identity.name;
    return (
      <button
        type="button"
        className="request-row"
        onClick={() => onOpen(event.id)}
        aria-label={`${t('common.details')}: ${event.model}, ${event.request_id || event.id}`}
      >
        <div className="request-identity">
          <div className="request-primary">
            <span className={`request-result ${event.failed ? 'is-failed' : ''}`}>
              <i />
              {t(event.failed ? 'events.filter_failed' : 'events.filter_success')}
            </span>
            <strong className="request-model" title={event.model}>
              {event.model || t('events.not_captured')}
            </strong>
            {!event.generate && <span className="request-preflight">{t('events.preflight')}</span>}
          </div>
          <div className="request-secondary">
            <time
              dateTime={new Date(event.timestamp_ms).toISOString()}
              title={dayjs(event.timestamp_ms).format('YYYY-MM-DD HH:mm:ss.SSS')}
            >
              {dayjs(event.timestamp_ms).format('MM-DD HH:mm:ss')}
            </time>
            <span className="request-id" title={event.request_id}>
              {event.request_id || t('events.no_request_id')}
            </span>
          </div>
        </div>
        <div className="request-origin">
          <div className="request-route">
            <span title={event.provider}>{event.provider || t('events.unknown_provider')}</span>
            <ArrowRightOutlined />
            <span title={`${t(`events.credential_${identity.kind}`)}: ${credential || '—'}`}>
              <FileTextOutlined /> {credential || t('events.unknown_credential')}
            </span>
          </div>
          <div className="request-secondary">
            <span title={requestGroupName(event)}>
              {t('events.caller')}: {requestGroupName(event) || '—'}
            </span>
            {event.auth_type && <span>{event.auth_type}</span>}
          </div>
        </div>
        <div className="request-metric">
          <strong>{formatEventDuration(event.latency_ms)}</strong>
          <span>TTFT {formatEventDuration(event.ttft_ms)}</span>
        </div>
        <div className="request-metric request-token">
          <strong>
            {event.tokens.total.toLocaleString()} <small>tokens</small>
          </strong>
          <span>
            ↑ {event.tokens.input.toLocaleString()} · ↓ {event.tokens.output.toLocaleString()}
          </span>
        </div>
        <RightOutlined className="request-chevron" />
      </button>
    );
  },
);

export const UsageEventsPage: React.FC = () => {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const signature = params.toString();
  const query = React.useMemo(() => readEventQuery(new URLSearchParams(signature)), [signature]);
  const [refresh, setRefresh] = React.useState(0);
  const window = React.useMemo(() => eventWindow(query, Date.now()), [query, refresh]);
  const scope = `${signature}:${refresh}`;
  const [pagination, setPagination] = React.useState<{ scope: string; cursors: string[] }>({
    scope,
    cursors: [],
  });
  const cursors = pagination.scope === scope ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [advanced, setAdvanced] = React.useState(false);
  const [grouping, setGrouping] = React.useState('time');
  const [search, setSearch] = React.useState(query.request_id || '');
  React.useEffect(() => setSearch(query.request_id || ''), [query.request_id]);
  const update = React.useCallback(
    (values: Record<string, string | undefined>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(values)) {
            if (!value) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  React.useEffect(() => {
    if (search.trim() === (query.request_id || '')) return;
    const timer = setTimeout(() => update({ request_id: search.trim() }), 350);
    return () => clearTimeout(timer);
  }, [search, query.request_id, update]);
  const facetParams = usageEventParams(window);
  const facets = useQuery({
    queryKey: ['usage-facets', facetParams, refresh],
    queryFn: () => api.getUsageFacets(facetParams),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const ingest = useQuery({
    queryKey: ['usage-ingest-status'],
    queryFn: api.getUsageIngestStatus,
    refetchInterval: 15_000,
  });
  const status = ingest.data as IngestStatus | undefined;
  const queryString = usageEventParams({ ...query, ...window, cursor });
  const result = useQuery({
    queryKey: ['usage-events', queryString, refresh],
    queryFn: () => api.getUsageEvents(queryString),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  // keepPreviousData covers in-flight changes; retain the last successful page
  // after a failed query too, with an explicit stale-data label.
  const [lastPage, setLastPage] = React.useState<UsageEventPage>();
  React.useEffect(() => {
    if (result.data && !result.isPlaceholderData) setLastPage(result.data);
  }, [result.data, result.isPlaceholderData]);
  const displayedPage = result.data || (result.isError ? lastPage : undefined);
  const stale = result.isPlaceholderData || (result.isError && !!lastPage);
  const events = displayedPage?.items || [];
  const metrics = eventPageMetrics(events);
  // Safe file metadata only: never download credential contents for the stream.
  const authFiles = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    staleTime: 60_000,
  });
  const credentials = React.useMemo(
    () => indexCredentialFiles(authFiles.data?.files || []),
    [authFiles.data],
  );
  const activeFilters = EVENT_FILTER_KEYS.filter((key) => query[key]);
  const extraCount = activeFilters.filter((key) => !['model', 'provider', 'request_id'].includes(key)).length;
  const listHost = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(480);
  React.useLayoutEffect(() => {
    const host = listHost.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.max(240, Math.floor(entry.contentRect.height))),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const options = (values: UsageFacetValue[] | undefined) =>
    (values || []).map((v) => ({ value: v.value, label: `${v.value} (${v.requests})` }));
  const facet = (
    key: 'model' | 'provider' | 'source' | 'auth_index' | 'api_key' | 'executor',
    label: string,
    values?: UsageFacetValue[],
  ) => (
    <Select
      aria-label={label}
      placeholder={label}
      value={query[key]}
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      onChange={(value) => update({ [key]: value })}
      options={
        key === 'auth_index'
          ? options(values).map((option) => ({
              ...option,
              label: credentials.get(option.value)?.name
                ? `${credentials.get(option.value)!.name} · ${option.value}`
                : option.label,
            }))
          : options(values)
      }
    />
  );
  const group =
    grouping === 'time'
      ? undefined
      : {
          key: (event: UsageEvent) =>
            grouping === 'provider'
              ? event.provider || t('events.unknown_provider')
              : JSON.stringify([
                  event.provider,
                  event.auth_index || event.source || event.resource_id || 'unknown',
                ]),
          title: (key: React.Key, items: UsageEvent[]) => (
            <div className="request-group-title">
              <strong>
                {grouping === 'provider'
                  ? String(key)
                  : `${items[0].provider || t('events.unknown_provider')} / ${resolveCredential(items[0], credentials).name || t('events.unknown_credential')}`}
              </strong>
              <span>{t('events.record_count', { n: items.length })}</span>
            </div>
          ),
        };
  const ingestTone =
    !status || ingest.isError
      ? 'default'
      : status.enabled === false
        ? 'default'
        : status.healthy === true && !status.collector?.coverage_gaps
          ? 'success'
          : 'warning';
  const ingestLabel =
    !status || ingest.isError
      ? 'events.ingest_unknown'
      : status.enabled === false
        ? 'events.ingest_disabled'
        : ingestTone === 'success'
          ? 'events.ingest_healthy'
          : 'events.ingest_attention';

  return (
    <div className="terminal-page usage-events-page request-events-page">
      <header className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('events.title')}</h1>
          <p className="request-window">
            {dayjs(window.from).format('MM-DD HH:mm')} — {dayjs(window.to).format('MM-DD HH:mm')}
          </p>
        </div>
        <div className="request-actions">
          <Popover
            trigger="click"
            title={t('events.ingest_status')}
            content={
              <div className="request-ingest">
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    {
                      key: 'mode',
                      label: t('events.collector_mode'),
                      children: status?.collector?.mode || '—',
                    },
                    {
                      key: 'captured',
                      label: t('events.captured'),
                      children: status?.collector?.captured ?? '—',
                    },
                    {
                      key: 'gaps',
                      label: t('events.coverage_gaps'),
                      children: status?.collector?.coverage_gaps ?? '—',
                    },
                    { key: 'pending', label: t('events.pending'), children: status?.stats?.pending ?? '—' },
                  ]}
                />
                <p>{t('events.delivery_semantics_hint')}</p>
                {status?.collector?.last_error && <p>{status.collector.last_error}</p>}
              </div>
            }
          >
            <Button type="text" icon={<InfoCircleOutlined />}>
              <Badge status={ingestTone} text={t(ingestLabel)} />
            </Button>
          </Popover>
          <Button
            aria-label={t('common.refresh')}
            icon={<ReloadOutlined spin={result.isFetching} />}
            disabled={result.isFetching}
            onClick={() => {
              setRefresh((v) => v + 1);
              void ingest.refetch();
            }}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </header>
      {result.isError && (
        <Alert
          type="error"
          showIcon
          title={t('events.load_error')}
          description={result.error instanceof Error ? result.error.message : undefined}
          action={<Button onClick={() => void result.refetch()}>{t('common.retry')}</Button>}
        />
      )}
      <section className="request-toolbar" aria-label={t('events.filters')}>
        <div className="request-filters">
          <Input
            className="request-search"
            aria-label={t('events.col_request_id')}
            placeholder={t('events.search_hint')}
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
          <Select
            aria-label={t('events.time_range')}
            value={query.from !== undefined ? 'custom' : query.preset}
            onChange={(value) => update({ preset: value, from: undefined, to: undefined })}
            options={[
              ...(query.from !== undefined ? [{ value: 'custom', label: t('events.custom_range') }] : []),
              ...Object.keys(EVENT_PRESETS).map((value) => ({
                value,
                label: t('events.last_range', { range: value }),
              })),
            ]}
          />
          {facet('model', t('events.col_model'), facets.data?.facets.models)}
          {facet('provider', t('events.provider'), facets.data?.facets.providers)}
          <Button
            aria-label={t('events.more_filters')}
            icon={<FilterOutlined />}
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            {t('events.more_filters')}
            {extraCount > 0 ? ` (${extraCount})` : ''}
          </Button>
        </div>
        {advanced && (
          <div className="request-advanced">
            {facet('source', t('events.source'), facets.data?.facets.sources)}
            {facet('auth_index', t('events.credential_filter'), facets.data?.facets.auth_indexes)}
            {facet('api_key', t('events.caller'), facets.data?.facets.api_group_keys)}
            {facet('executor', t('events.executor'), facets.data?.facets.executors)}
            <Input
              aria-label={t('events.auth_type')}
              placeholder={t('events.auth_type')}
              value={query.auth_type || ''}
              allowClear
              onChange={(e) => update({ auth_type: e.target.value })}
            />
            <Input
              aria-label={t('events.model_alias')}
              placeholder={t('events.model_alias')}
              value={query.model_alias || ''}
              allowClear
              onChange={(e) => update({ model_alias: e.target.value })}
            />
            {facets.isError && <span role="status">{t('events.facets_error')}</span>}
          </div>
        )}
        <div className="request-toolbar-bottom">
          <Segmented
            aria-label={t('events.col_result')}
            value={query.result}
            onChange={(value) => update({ result: value === 'all' ? undefined : String(value) })}
            options={['all', 'success', 'failed'].map((value) => ({
              value,
              label: t(`events.filter_${value}`),
            }))}
          />
          <div className="request-actions">
            {(activeFilters.length > 0 ||
              query.result !== 'all' ||
              query.preset !== '1h' ||
              query.from !== undefined) && (
              <Button
                type="text"
                onClick={() => {
                  setSearch('');
                  setParams({}, { replace: true });
                }}
              >
                {t('events.reset')}
                {activeFilters.length ? ` (${activeFilters.length})` : ''}
              </Button>
            )}
            <Select
              aria-label={t('events.group_by')}
              value={grouping}
              onChange={setGrouping}
              options={['time', 'provider', 'credential'].map((value) => ({
                value,
                label: t(`events.group_${value}`),
              }))}
            />
          </div>
        </div>
      </section>
      {authFiles.isError && (
        <div className="request-detail-note" role="status">
          {t('events.credentials_unavailable')}
        </div>
      )}
      <section className="request-stream" aria-label={t('events.title')} aria-busy={result.isFetching}>
        <div className="request-summary">
          <span>{t(stale ? 'events.previous_results' : 'events.this_page')}</span>
          <strong>
            {result.isLoading ? '—' : metrics.count.toLocaleString()}{' '}
            <small>{t('events.requests_unit')}</small>
          </strong>
          <span>
            {t('events.filter_failed')} <b>{result.isLoading ? '—' : metrics.failed}</b>
          </span>
          <span>
            {t('events.mean_latency')} <b>{formatEventDuration(metrics.latency)}</b>
          </span>
          <span>
            {t('events.col_tokens')} <b>{result.isLoading ? '—' : metrics.tokens.toLocaleString()}</b>
          </span>
        </div>
        <div ref={listHost} className="request-list-host">
          {result.isLoading ? (
            <div className="request-loading">
              <Skeleton active={false} paragraph={{ rows: 8 }} title={false} />
            </div>
          ) : events.length ? (
            <Listy<UsageEvent>
              key={`${queryString}:${grouping}`}
              virtual
              height={height}
              items={events}
              rowKey="id"
              group={group}
              sticky
              className="request-list"
              itemRender={(event) => (
                <RequestRow event={event} credentials={credentials} onOpen={setSelected} />
              )}
            />
          ) : !result.isError ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <>
                  <strong>{t('events.empty_title')}</strong>
                  <p>
                    {t(
                      activeFilters.length || query.result !== 'all'
                        ? 'events.empty_filtered'
                        : 'events.empty_hint',
                    )}
                  </p>
                </>
              }
            />
          ) : (
            <div className="request-empty-error">{t('events.load_error')}</div>
          )}
        </div>
        <footer className="request-pagination">
          <span aria-live="polite">
            {stale
              ? t('events.previous_results')
              : t('events.page_loaded', { page: cursors.length + 1, n: events.length })}
            {result.isPlaceholderData && ` · ${t('events.updating')}`}
          </span>
          <div className="request-actions">
            <Select
              aria-label={t('events.page_size')}
              value={query.limit}
              onChange={(value) => update({ limit: String(value) })}
              options={Array.from(new Set([100, 250, 500, query.limit!]))
                .sort((a, b) => a - b)
                .map((value) => ({ value, label: t('events.per_page', { n: value }) }))}
            />
            <Tooltip title={t('events.prev_page')}>
              <Button
                aria-label={t('events.prev_page')}
                icon={<LeftOutlined />}
                disabled={!cursors.length || result.isFetching}
                onClick={() => setPagination({ scope, cursors: cursors.slice(0, -1) })}
              />
            </Tooltip>
            <Tooltip title={t('events.next_page')}>
              <Button
                aria-label={t('events.next_page')}
                icon={<RightOutlined />}
                disabled={
                  !result.data?.has_more || !result.data?.next_cursor || result.isFetching || result.isError
                }
                onClick={() => setPagination({ scope, cursors: [...cursors, result.data!.next_cursor!] })}
              />
            </Tooltip>
          </div>
        </footer>
      </section>
      <UsageEventDrawer credentials={credentials} eventId={selected} onClose={() => setSelected(null)} />
    </div>
  );
};
