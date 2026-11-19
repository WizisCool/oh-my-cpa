import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '../../../api/client';
import { AppDrawer } from '../../../components/common/AppDrawer';
import { CopyButton } from '../../../components/common/CopyButton';
import { EmptyState } from '../../../components/common/EmptyState';
import { FactList, type Fact } from '../../../components/common/FactList';
import { MetaLine } from '../../../components/common/MetaLine';
import { Tag } from '../../../components/common/Tag';
import { LoadFailure } from '../../../components/feedback';
import { ArrowRightOutlined, DownOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { maskKeyText } from '../../../utils/maskKey';
import { formatLatency } from '../../../types/insightsFormat';
import { requestFailureCause } from '../../../types/requestDetailSummary';
import type { InsightsWindow } from '../../../types/insights';
import type { TrendsFailureGroup } from '../../../types/trends';
import type { UsageEvent } from '../../../types/usageEvents';
import {
  aggregateStabilityFailures,
  formatPercent,
  isFailureGroupExclusiveToLane,
  isStabilityFailureLane,
  stabilityEventsHref,
  stabilityEventsQueryString,
  type StabilityAttributionDim,
  type StabilityAttributionRow,
  type StabilityDisplayBucket,
  type StabilityLane,
  type TrendsFilters,
} from '../trendsLogic';
import { TrendsValue, type TrendsIdentity } from '../useTrendsIdentity';
import styles from '../trends.module.css';

const SAMPLE_LIMIT = 20;
const CROSS_LIMIT = 5;

export interface StabilityInspectionTarget {
  lane: StabilityLane | null;
  cell: StabilityDisplayBucket | null;
  cellHeading?: string;
  row: StabilityAttributionRow | null;
  count?: number;
  window: InsightsWindow;
  filters: TrendsFilters;
  failureGroups: readonly TrendsFailureGroup[];
}

export interface StabilityDetailDrawerProps {
  target: StabilityInspectionTarget | null;
  isDemo: boolean;
  canFilterTrends?: boolean;
  identity: TrendsIdentity;
  onClose: () => void;
  isEntityFiltered: (dimension: StabilityAttributionDim, id: string) => boolean;
  onFilterEntity: (dimension: StabilityAttributionDim, id: string) => void;
  onNavigate: (href: string) => void;
}

function complementaryDims(dimension: StabilityAttributionDim | null): StabilityAttributionDim[] {
  if (dimension === 'model') return ['provider', 'credential'];
  if (dimension === 'provider') return ['model', 'credential'];
  if (dimension === 'credential') return ['model'];
  return ['model', 'provider', 'credential'];
}

function filterGroupsForRow(
  groups: readonly TrendsFailureGroup[],
  row: StabilityAttributionRow | null,
): readonly TrendsFailureGroup[] {
  if (!row) return groups;
  return groups.filter((group) => {
    if (row.dimension === 'model') return (group.model_id ?? group.model) === row.id;
    if (row.dimension === 'provider') return (group.provider_id ?? group.provider) === row.id;
    return (group.auth_index_id ?? group.auth_index ?? '') === row.id;
  });
}

function eventStatusBadge(event: UsageEvent, t: ReturnType<typeof useT>): { label: string; tone: 'danger' | 'warn' } {
  if (event.failed) {
    return {
      label: event.fail_status_code
        ? t('trends.stability.drawer.http_status', { code: event.fail_status_code })
        : t('events.filter_failed'),
      tone: 'danger',
    };
  }
  return { label: t('trends.stability.lane.model_substituted'), tone: 'warn' };
}

/** Lazy-loads the single-record detail only after the operator expands a failed request row. */
const StabilityEventBody: React.FC<{ event: UsageEvent; isDemo: boolean }> = ({ event, isDemo }) => {
  const t = useT();
  const replay = isDemo ? 'calendar' : undefined;
  const detailQuery = useQuery({
    queryKey: replay === 'calendar' ? ['usage-event', event.id, 'calendar'] : ['usage-event', event.id],
    queryFn: () => api.getUsageEvent(event.id, replay),
    staleTime: 60_000,
    meta: { silent: true },
  });

  if (detailQuery.isPending) {
    return (
      <div className={styles['stability-event-loading']}>
        <Spinner size="small" />
      </div>
    );
  }
  if (detailQuery.isError) {
    return <p className={styles['stability-event-note']}>{t('events.fail_load_failed')}</p>;
  }

  const detail = detailQuery.data?.event;
  const body = detail?.fail_body?.trim() ?? '';
  const cause = requestFailureCause(undefined, detail?.fail_code);
  const relatedErrors = detailQuery.data?.related_errors ?? [];
  const providerKeyMask = maskKeyText(detail?.provider_key_mask);

  return (
    <div className={styles['stability-event-detail']}>
      {cause !== 'unknown' && (
        <div className={styles['stability-event-cause']}>
          <Tag size="small" tone="danger">{t(`events.cause_${cause}`)}</Tag>
        </div>
      )}
      {event.model_substituted && event.response_model && (
        <div className={styles['stability-event-meta']}>
          <span className={styles['stability-event-meta-label']}>{t('events.served_model')}</span>
          <span className={styles['pair-models']}>
            <span className={styles['pair-model']}>{event.model}</span>
            <ArrowRightOutlined className={styles['pair-arrow']} aria-hidden="true" />
            <span className={`${styles['pair-model']} ${styles['pair-served']}`}>{event.response_model}</span>
          </span>
        </div>
      )}
      {event.failed && (
        body ? (
          <div className={styles['stability-error-block']}>
            <div className={styles['stability-error-head']}>
              <span>{t('trends.stability.drawer.error_body')}</span>
              <CopyButton text={body} label={t('events.fail_copy')} />
            </div>
            <pre className={styles['stability-error-pre']}>{body}</pre>
          </div>
        ) : (
          <p className={styles['stability-event-note']}>{t('events.fail_no_body')}</p>
        )
      )}
      {relatedErrors.length > 0 && (
        <div className={styles['stability-related-errors']}>
          <span className={styles['stability-event-meta-label']}>{t('trends.stability.drawer.related_errors', { n: relatedErrors.length })}</span>
          {relatedErrors.slice(0, 3).map((err) => (
            <div key={err.id} className={styles['stability-related-item']}>
              <MetaLine>
                {err.status_code > 0 && (
                  <Tag size="small" tone="danger">
                    {t('trends.stability.drawer.http_status', { code: err.status_code })}
                  </Tag>
                )}
                {err.quota_reason && <span>{err.quota_reason}</span>}
                {err.code && <span>{err.code}</span>}
              </MetaLine>
              {err.body?.trim() && <pre className={styles['stability-error-pre']}>{err.body.trim()}</pre>}
            </div>
          ))}
        </div>
      )}
      {(event.request_id || providerKeyMask) && (
        <div className={styles['stability-event-foot']}>
          {event.request_id && (
            <span className={styles['stability-event-id']}>
              <span className={styles['stability-event-meta-label']}>{t('events.col_request_id')}</span>
              <code className={styles['stability-code']}>{event.request_id}</code>
              <CopyButton text={event.request_id} label={t('events.copy_id')} />
            </span>
          )}
          {providerKeyMask && (
            <span className={styles['stability-event-id']}>
              <span className={styles['stability-event-meta-label']}>{t('events.provider_key')}</span>
              <code className={styles['stability-code']}>{providerKeyMask}</code>
            </span>
          )}
        </div>
      )}
    </div>
  );
};

const StabilityEventAccordionRow: React.FC<{
  event: UsageEvent;
  fixedDim: StabilityAttributionDim | null;
  identity: TrendsIdentity;
  isDemo: boolean;
}> = ({ event, fixedDim, identity, isDemo }) => {
  const t = useT();
  const [hasOpened, setHasOpened] = React.useState(false);
  const badge = eventStatusBadge(event, t);
  const providerName = event.provider ? identity.label('provider', event.provider) : '';
  const credName = event.auth_index ? identity.label('credential', event.auth_index) : '';

  return (
    <details
      className={styles['stability-event-item']}
      onToggle={(ev) => {
        if ((ev.currentTarget as HTMLDetailsElement).open) setHasOpened(true);
      }}
    >
      <summary className={styles['stability-event-summary']}>
        <DownOutlined className={styles['stability-event-chevron']} aria-hidden="true" />
        <Tag size="small" tone={badge.tone}>{badge.label}</Tag>
        <time className={styles['stability-event-time']} dateTime={new Date(event.timestamp_ms).toISOString()}>
          {dayjs(event.timestamp_ms).format('MM-DD HH:mm:ss')}
        </time>
        <span className={styles['stability-event-context']}>
          <MetaLine>
            {fixedDim !== 'model' && event.model && (
              <span className={styles['stability-event-entity']}>{event.model}</span>
            )}
            {fixedDim !== 'provider' && providerName && (
              <span>{providerName}</span>
            )}
            {fixedDim !== 'credential' && credName && (
              <span>{credName}</span>
            )}
          </MetaLine>
        </span>
        <span className={styles['stability-event-latency']}>
          {event.latency_ms > 0 ? formatLatency(event.latency_ms) : '—'}
        </span>
      </summary>
      <div className={styles['stability-event-body']}>
        {hasOpened && <StabilityEventBody event={event} isDemo={isDemo} />}
      </div>
    </details>
  );
};

/**
 * In-place failure investigation drawer opened from the Stability & Substitutions panel:
 * shows failure summary facts, complementary culprit breakdown, and live expandable request records
 * with their upstream error bodies — without losing the operator's place on Trends.
 */
export const StabilityDetailDrawer: React.FC<StabilityDetailDrawerProps> = ({
  target,
  isDemo,
  canFilterTrends = true,
  identity,
  onClose,
  isEntityFiltered,
  onFilterEntity,
  onNavigate,
}) => {
  useTimeZone();
  const t = useT();
  // Retain the last target during close transition so the sheet slides out populated.
  const [shownTarget, setShownTarget] = React.useState<StabilityInspectionTarget | null>(target);
  if (target !== null && target !== shownTarget) setShownTarget(target);
  const active = target ?? shownTarget;

  const activeFailureLane = active && isStabilityFailureLane(active.lane) ? active.lane : null;
  const entityFilter = active?.row && !active.row.drillDisabled && active.row.id
    ? { dimension: active.row.dimension, id: active.row.id }
    : null;

  // Close the captured window to its snapshot end so both sample queries and the Request records
  // link share the exact boundary that produced the drawer's counts and breakdown.
  const closedWindow = React.useMemo(
    () => (active ? { ...active.window, open_end: false as const } : null),
    [active],
  );

  const eventsQueryString = React.useMemo(() => {
    if (!active || !closedWindow) return null;
    if (active.row && (!active.row.id || active.row.drillDisabled)) return null;
    return stabilityEventsQueryString(
      closedWindow,
      active.filters,
      { lane: active.lane, cell: active.cell, entity: entityFilter, limit: SAMPLE_LIMIT },
      { isDemo },
    );
  }, [active, closedWindow, entityFilter, isDemo]);

  const eventsHref = React.useMemo(() => {
    if (!active || !closedWindow) return null;
    if (active.row && (!active.row.id || active.row.drillDisabled)) return null;
    return stabilityEventsHref(
      closedWindow,
      active.filters,
      { lane: active.lane, cell: active.cell, entity: entityFilter },
      { isDemo },
    );
  }, [active, closedWindow, entityFilter, isDemo]);

  const eventsQuery = useQuery({
    queryKey: ['trends-stability-events', eventsQueryString],
    queryFn: ({ signal }) => api.getUsageEvents(eventsQueryString!, signal),
    enabled: target !== null && eventsQueryString !== null,
    staleTime: 15_000,
    meta: { silent: true },
  });

  const scopedGroups = React.useMemo(
    () => (active ? filterGroupsForRow(active.failureGroups, active.row) : []),
    [active],
  );

  const crossSections = React.useMemo(() => {
    if (!active || active.lane === 'model_substituted') return [];
    return complementaryDims(active.row?.dimension ?? null)
      .map((dim) => ({
        dim,
        rows: aggregateStabilityFailures(scopedGroups, dim, activeFailureLane).slice(0, CROSS_LIMIT),
      }))
      .filter((section) => section.rows.length > 0);
  }, [active, activeFailureLane, scopedGroups]);

  const statusTags = React.useMemo(() => {
    if (!active || active.lane === 'model_substituted') return [];
    if (active.row) return active.row.statusCodes;
    const merged = new Map<number, number>();
    for (const row of aggregateStabilityFailures(scopedGroups, 'model', activeFailureLane)) {
      for (const item of row.statusCodes) {
        merged.set(item.code, (merged.get(item.code) ?? 0) + item.count);
      }
    }
    return [...merged.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code - b.code)
      .slice(0, 6);
  }, [active, activeFailureLane, scopedGroups]);

  const lastFailedAtMs = React.useMemo(() => {
    if (!active || active.lane === 'model_substituted') return 0;
    if (active.row) return active.row.lastFailedAtMs;
    if (activeFailureLane) {
      let latest = 0;
      for (const group of scopedGroups) {
        if (group[activeFailureLane] <= 0) continue;
        if (!isFailureGroupExclusiveToLane(group, activeFailureLane)) return 0;
        if ((group.last_failed_at_ms ?? 0) > latest) latest = group.last_failed_at_ms ?? 0;
      }
      return latest;
    }
    return scopedGroups.reduce((max, group) => Math.max(max, group.last_failed_at_ms ?? 0), 0);
  }, [active, activeFailureLane, scopedGroups]);

  const manageTarget = React.useMemo(() => {
    const row = active?.row;
    if (!row || !row.id || row.drillDisabled) return null;
    if (row.dimension === 'provider' || row.dimension === 'credential') {
      return identity.manage(row.dimension, row.id);
    }
    return null;
  }, [active?.row, identity]);

  const canFilterInTrends = Boolean(
    canFilterTrends &&
    active?.row &&
    active.row.id &&
    !active.row.drillDisabled &&
    !isEntityFiltered(active.row.dimension, active.row.id),
  );

  const entityLabel = (row: StabilityAttributionRow) =>
    row.id ? identity.label(row.dimension, { id: row.id, label: row.label }) : t('trends.stability.unassigned_credential');

  const drawerTitle = active ? (
    <span className={styles['stability-drawer-head']}>
      {active.row ? (
        <TrendsValue
          mark={active.row.id ? identity.mark(active.row.dimension, active.row.id) : null}
          name={entityLabel(active.row)}
        />
      ) : (
        <span>{active.lane ? t(`trends.stability.lane.${active.lane}`) : t('trends.stability.drawer.title')}</span>
      )}
      <MetaLine tone="quiet">
        {active.row && <span>{t(`trends.stability.dim.${active.row.dimension}`)}</span>}
        {active.row && active.lane && <span>{t(`trends.stability.lane.${active.lane}`)}</span>}
        {active.cellHeading && <span>{active.cellHeading}</span>}
      </MetaLine>
    </span>
  ) : undefined;

  const facts: Fact[] = [];
  if (active) {
    const count = active.row?.failures ?? active.count;
    if (count !== undefined) {
      const rateText = active.row?.failureRate !== null && active.row?.failureRate !== undefined
        ? t('trends.stability.drawer.count_with_rate', {
            failed: count.toLocaleString('en'),
            total: active.row.totalRequests.toLocaleString('en'),
            rate: formatPercent(active.row.failureRate * 100),
          })
        : t('trends.stability.pair_count', { n: count });
      facts.push({
        key: 'count',
        label: active.lane === 'model_substituted' ? t('trends.stability.lane.model_substituted') : t('trends.stability.drawer.failures'),
        value: rateText,
      });
    }
    if (statusTags.length > 0) {
      facts.push({
        key: 'codes',
        label: t('trends.stability.drawer.status_codes'),
        value: (
          <span className={styles['stability-code-tags']}>
            {statusTags.map((item) => (
              <Tag key={item.code} size="small" tone="danger">{`${item.code} × ${item.count}`}</Tag>
            ))}
          </span>
        ),
      });
    }
    if (lastFailedAtMs > 0) {
      facts.push({
        key: 'last',
        label: t('trends.stability.drawer.last_seen'),
        value: dayjs(lastFailedAtMs).format('MM-DD HH:mm:ss'),
      });
    }
  }

  const events = eventsQuery.data?.items ?? [];

  return (
    <AppDrawer
      widthKey="trends_stability"
      open={target !== null}
      onClose={onClose}
      width="medium"
      title={drawerTitle}
      data-testid="trends-stability-drawer"
      footerStart={active ? (
        <div className={styles['stability-drawer-actions']}>
          {manageTarget && (
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                onNavigate(manageTarget.href);
              }}
              data-testid="trends-stability-manage"
            >
              {t(manageTarget.target === 'oauth' ? 'trends.stability.manage_oauth' : 'trends.stability.manage_provider')}
            </Button>
          )}
          {canFilterInTrends && active.row && (
            <Button
              variant="secondary"
              onClick={() => {
                onFilterEntity(active.row!.dimension, active.row!.id);
                onClose();
              }}
              data-testid="trends-stability-filter-page"
            >
              {t('trends.stability.filter_in_trends')}
            </Button>
          )}
        </div>
      ) : undefined}
      footer={active ? (
        <Button
          variant="primary"
          disabled={!eventsHref}
          onClick={() => {
            if (!eventsHref) return;
            onClose();
            onNavigate(eventsHref);
          }}
          data-testid="trends-stability-open-events"
        >
          {t('trends.view_requests_link')}
        </Button>
      ) : undefined}
    >
      {active && (
        <div className={styles['stability-drawer-body']}>
          {facts.length > 0 && <FactList facts={facts} />}

          {crossSections.length > 0 && (
            <div className={styles['stability-cross-grid']}>
              {crossSections.map(({ dim, rows }) => (
                <section key={dim} className={styles['stability-cross-section']}>
                  <h3 className={styles['stability-drawer-heading']}>{t(`trends.stability.dim.${dim}`)}</h3>
                  <ul className={styles['stability-cross-list']}>
                    {rows.map((item) => {
                      const label = entityLabel(item);
                      const canFilter = Boolean(canFilterTrends && item.id && !item.drillDisabled);
                      return (
                        <li key={`${item.id}\u0000${item.label}`} className={styles['stability-cross-row']}>
                          {canFilter ? (
                            <button
                              type="button"
                              className={styles['mover-name']}
                              aria-pressed={isEntityFiltered(dim, item.id)}
                              onClick={() => {
                                onFilterEntity(dim, item.id);
                                onClose();
                              }}
                            >
                              <TrendsValue mark={identity.mark(dim, item.id)} name={label} />
                            </button>
                          ) : (
                            <TrendsValue mark={item.id ? identity.mark(dim, item.id) : null} name={label} />
                          )}
                          <span className={styles['stability-cross-count']}>{item.failures.toLocaleString('en')}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}

          <section className={styles['stability-events-section']}>
            <div className={styles['stability-events-head']}>
              <h3 className={styles['stability-drawer-heading']}>
                {t(active.lane === 'model_substituted'
                  ? 'trends.stability.drawer.substituted_requests'
                  : 'trends.stability.drawer.failed_requests')}
              </h3>
              {eventsQuery.isFetching && !eventsQuery.isPending && <Spinner size="small" />}
            </div>
            {eventsQueryString === null ? (
              <EmptyState
                size="compact"
                title={t(
                  active.row && !active.row.id
                    ? 'trends.stability.drawer.unassigned_unfilterable'
                    : active.row?.drillDisabled
                      ? 'trends.stability.drawer.unfilterable'
                      : 'trends.stability.drawer.lookup_unavailable',
                )}
              />
            ) : eventsQuery.isPending ? (
              <div className={styles['stability-event-loading']}>
                <Spinner size="small" />
              </div>
            ) : eventsQuery.isError ? (
              <LoadFailure
                tone="warning"
                title={t('trends.error_title')}
                error={eventsQuery.error}
                onRetry={() => void eventsQuery.refetch()}
              />
            ) : events.length === 0 ? (
              <EmptyState size="compact" title={t('trends.stability.drawer.no_samples')} />
            ) : (
              <>
                <div className={styles['stability-event-list']} data-testid="trends-stability-event-list">
                  {events.map((event) => (
                    <StabilityEventAccordionRow
                      key={event.id}
                      event={event}
                      fixedDim={active.row?.dimension ?? null}
                      identity={identity}
                      isDemo={isDemo}
                    />
                  ))}
                </div>
                {eventsQuery.data?.has_more && (
                  <p className={styles['stability-events-more']}>
                    {t('trends.stability.drawer.more_in_requests', { n: SAMPLE_LIMIT })}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </AppDrawer>
  );
};
