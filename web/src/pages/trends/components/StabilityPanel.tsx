import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import { api, apiErrorCode } from '../../../api/client';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { LoadFailure } from '../../../components/feedback';
import { MetaLine } from '../../../components/common/MetaLine';
import { ToolButton } from '../../../components/common/ToolButton';
import { Tag } from '../../../components/common/Tag';
import { tipCard, type TipRow } from '../../../components/common/tipCard';
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  HistoryOutlined,
  SearchOutlined,
  SettingOutlined,
} from '../../../components/icons';
import { useT } from '../../../i18n';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { sharedResizeObserverHub } from '../../../performance/resizeObserverHub';
import { insightsPollInterval, type InsightsBucket } from '../../../types/insights';
import type { TrendsSubstitutionPair, TrendsTelemetryResponse } from '../../../types/trends';
import {
  STABILITY_ATTRIBUTION_DIMS,
  aggregateStabilityFailures,
  deriveFailureGroupsFromEvents,
  deriveSubstitutionPairsFromEvents,
  formatPercent,
  isStabilityFailureLane,
  stabilityDemoSliceEventsQueryString,
  stabilityDisplayBuckets,
  stabilityEventsHref,
  stabilityLanes,
  stabilitySliceTelemetryParams,
  stabilityWindowForCell,
  substitutionEventsHref,
  successRate,
  type StabilityAttributionDim,
  type StabilityAttributionRow,
  type StabilityDisplayBucket,
  type StabilityLane,
  type TrendsFilters,
} from '../trendsLogic';
import { ModelMark } from '../../../components/ModelMark';
import { TrendsValue, type TrendsIdentity } from '../useTrendsIdentity';
import { StabilityDetailDrawer, type StabilityInspectionTarget } from './StabilityDetailDrawer';
import styles from '../trends.module.css';

const TOOLTIP_FORMATS: Record<InsightsBucket, string> = { hour: 'MM-DD HH:mm', day: 'YYYY-MM-DD', week: 'YYYY-MM-DD', month: 'YYYY-MM' };
const AXIS_FORMATS: Record<InsightsBucket, string> = { hour: 'MM-DD HH:mm', day: 'MM-DD', week: 'MM-DD', month: 'YYYY-MM' };
const PAIR_LIMIT = 6;
const ATTRIBUTION_LIMIT = 6;
const SIGNAL_TAG_LIMIT = 3;
/** Past this many buckets the cells close up, so none of them thins to nothing. */
const DENSE_BUCKETS = 72;
/** Minimum pixel width of one displayed stability cell before adjacent buckets aggregate. */
const MIN_CELL_PX = 2;
/** The faintest a bucket with any event is drawn, so a single failure is never invisible. */
const MIN_WEIGHT = 22;

export interface StabilityPanelProps {
  data: TrendsTelemetryResponse | undefined;
  filters: TrendsFilters;
  isDemo?: boolean;
  /** False in Demo mode where `/trends` window reads do not capture filtered dimensions. */
  canFilterTrends?: boolean;
  /** Matches the parent Trends polling cadence while a live slice is open. */
  isPollingActive?: boolean;
  /** True while `data` is a `keepPreviousData` placeholder for an earlier range or filter set. */
  isStale?: boolean;
  identity: TrendsIdentity;
  pairHref: (pair: TrendsSubstitutionPair) => string | null;
  isEntityFiltered: (dimension: StabilityAttributionDim, id: string) => boolean;
  onToggleFilter: (dimension: StabilityAttributionDim, id: string) => void;
  onNavigate: (href: string) => void;
  isUnavailable?: boolean;
}

function laneTone(lane: StabilityLane): 'danger' | 'warn' {
  // A substitution served an answer; the other lanes are failures, and red stays with failure.
  return lane === 'model_substituted' ? 'warn' : 'danger';
}

function formatCellHeading(cell: StabilityDisplayBucket, bucket: InsightsBucket): string {
  const start = dayjs(cell.start_ms);
  if (cell.span_count <= 1) return start.format(TOOLTIP_FORMATS[bucket]);
  const endInstant = bucket === 'hour' ? cell.end_ms : cell.last_start_ms;
  const end = dayjs(endInstant);
  const endFormat = bucket === 'hour' && start.isSame(end, 'day') ? 'HH:mm' : TOOLTIP_FORMATS[bucket];
  return `${start.format(TOOLTIP_FORMATS[bucket])} – ${end.format(endFormat)}`;
}

interface FailureSignalTag {
  key: string;
  label: string;
  count: number;
}

function rowSignalTags(
  row: StabilityAttributionRow,
  activeLane: StabilityLane | null,
  t: ReturnType<typeof useT>,
): FailureSignalTag[] {
  const tags: FailureSignalTag[] = [];
  if (!activeLane && row.lanes.stream_truncated > 0) {
    tags.push({ key: 'stream_truncated', label: t('trends.stability.lane.stream_truncated'), count: row.lanes.stream_truncated });
  }
  if (!activeLane && row.lanes.force_cooldown > 0) {
    tags.push({ key: 'force_cooldown', label: t('trends.stability.lane.force_cooldown'), count: row.lanes.force_cooldown });
  }
  for (const item of row.statusCodes) {
    tags.push({ key: `http:${item.code}`, label: String(item.code), count: item.count });
  }
  if (tags.length === 0) {
    if (isStabilityFailureLane(activeLane)) {
      tags.push({ key: activeLane, label: t(`trends.stability.lane.${activeLane}`), count: row.failures });
    } else {
      const laneKeys = ['rate_limited_429', 'upstream_5xx', 'stream_truncated', 'force_cooldown', 'other_failures'] as const;
      for (const lane of laneKeys) {
        if (row.lanes[lane] > 0) {
          tags.push({ key: lane, label: t(`trends.stability.lane.${lane}`), count: row.lanes[lane] });
        }
      }
    }
  }
  return tags;
}

function failureRateTone(rate: number | null): 'danger' | 'warn' | undefined {
  if (rate === null) return undefined;
  if (rate >= 0.2) return 'danger';
  if (rate >= 0.05) return 'warn';
  return undefined;
}

/**
 * Operational stability and model-substitution console: interactive timeline lanes over the
 * window, instant model/provider/credential failure attribution with HTTP status codes and exact
 * failure rates, clickable time-slice focus, and an in-place investigation drawer for inspecting
 * upstream error bodies and jumping straight to Request Records, Providers, or OAuth Management.
 */
export const StabilityPanel: React.FC<StabilityPanelProps> = ({
  data,
  filters,
  isDemo = false,
  canFilterTrends = !isDemo,
  isPollingActive = false,
  isStale = false,
  identity,
  pairHref,
  isEntityFiltered,
  onToggleFilter,
  onNavigate,
  isUnavailable,
}) => {
  const timeZone = useTimeZone();
  const t = useT();
  const [trackNode, setTrackNode] = React.useState<HTMLSpanElement | null>(null);
  const [trackWidth, setTrackWidth] = React.useState<number | null>(null);
  const [focusedCells, setFocusedCells] = React.useState<Partial<Record<StabilityLane, number>>>({});
  const cellRefs = React.useRef<Record<string, Array<HTMLButtonElement | null>>>({});

  const [selectedLane, setSelectedLane] = React.useState<StabilityLane | null>(null);
  // Store the selected interval independently of `displayCells` so viewport resizes that regroup
  // buckets keep the exact clicked span instead of silently broadening to the whole window.
  const [selectedCell, setSelectedCell] = React.useState<StabilityDisplayBucket | null>(null);
  const [attributionDim, setAttributionDim] = React.useState<StabilityAttributionDim>('model');
  const [showAllRows, setShowAllRows] = React.useState(false);
  const [inspectTarget, setInspectTarget] = React.useState<StabilityInspectionTarget | null>(null);

  // Preserve operator focus across live polls that merely advance open-ended preset timestamps;
  // reset only when the operator switches preset/range/bucket or changes page filters.
  const filtersKey = React.useMemo(
    () => JSON.stringify(
      Object.keys(filters)
        .sort()
        .map((key) => [key, filters[key as keyof TrendsFilters] ?? []]),
    ),
    [filters],
  );
  const scopeResetKey = data
    ? `${data.window.preset ?? ''}:${data.window.open_end && data.window.preset ? '' : data.window.from}:${data.window.open_end ? 'open' : data.window.to}:${data.window.bucket}:${filtersKey}`
    : '';
  const prevScopeRef = React.useRef(scopeResetKey);
  React.useEffect(() => {
    if (prevScopeRef.current !== scopeResetKey) {
      prevScopeRef.current = scopeResetKey;
      setSelectedLane(null);
      setSelectedCell(null);
      setShowAllRows(false);
      setInspectTarget(null);
    }
  }, [scopeResetKey]);

  React.useEffect(() => {
    if (!trackNode) return undefined;
    return sharedResizeObserverHub.observe(
      trackNode,
      ({ width }) => {
        const rounded = Math.round(width);
        if (rounded > 0) setTrackWidth((curr) => (curr === rounded ? curr : rounded));
      },
      { epsilonPx: 4, allowZeroHeight: true },
    );
  }, [trackNode]);

  const maxCells = trackWidth && trackWidth > 0 ? Math.max(1, Math.floor(trackWidth / MIN_CELL_PX)) : undefined;
  const displayCells = React.useMemo(
    () => (data ? stabilityDisplayBuckets(data.buckets, data.window.to + 1, maxCells) : []),
    [data, maxCells],
  );
  const isAggregated = displayCells.some((cell) => cell.span_count > 1);
  const trackStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!isAggregated || displayCells.length === 0) return undefined;
    const spans = displayCells.map((cell) => Math.max(1, cell.end_ms - cell.start_ms));
    if (spans.every((span) => span === spans[0])) return undefined;
    return { gridTemplateColumns: spans.map((span) => `${span}fr`).join(' ') };
  }, [displayCells, isAggregated]);
  // A lane with nothing in it reads as a placeholder, so only the lanes that saw an event are drawn.
  const lanes = React.useMemo(() => (data ? stabilityLanes(displayCells).filter((lane) => lane.total > 0) : []), [data, displayCells]);
  const hasFailureLanes = React.useMemo(() => lanes.some((lane) => isStabilityFailureLane(lane.lane)), [lanes]);

  const isSelectedCellInWindow = Boolean(
    selectedCell && data && selectedCell.end_ms > data.window.from && selectedCell.start_ms <= data.window.to,
  );
  React.useEffect(() => {
    if (selectedCell && data && !isSelectedCellInWindow) {
      // Clear both cell and lane when a selected interval ages completely out of the window so
      // request links never silently widen from one interval to the full window.
      setSelectedCell(null);
      setSelectedLane(null);
    }
  }, [data, isSelectedCellInWindow, selectedCell]);

  const exactDisplayCell = React.useMemo(() => {
    if (!selectedCell || !isSelectedCellInWindow) return null;
    return displayCells.find(
      (cell) => cell.start_ms === selectedCell.start_ms && cell.end_ms === selectedCell.end_ms,
    ) ?? null;
  }, [displayCells, isSelectedCellInWindow, selectedCell]);

  const activeCell = React.useMemo(() => {
    if (!selectedCell || !isSelectedCellInWindow) return null;
    return exactDisplayCell ?? selectedCell;
  }, [exactDisplayCell, isSelectedCellInWindow, selectedCell]);

  const activeLane = React.useMemo(() => {
    if (selectedCell && !isSelectedCellInWindow) return null;
    return selectedLane && lanes.some((lane) => lane.lane === selectedLane) ? selectedLane : null;
  }, [isSelectedCellInWindow, lanes, selectedCell, selectedLane]);

  // Live deployments fetch the exact slice attribution from `/trends/telemetry`; Demo mode reads
  // all requests in the cell from `/usage/events` (successes + failures) so denominators stay honest.
  // Demo list payloads omit `fail_code`, so lanes that depend on it report per-interval unavailable.
  const activeCellSpan = React.useMemo(
    () => (activeCell && data ? stabilityWindowForCell(data.window, activeCell) : null),
    [activeCell, data],
  );
  const isCellSliceUnaddressable = Boolean(activeCell && data && !activeCellSpan);
  const isDemoLaneSliceUnavailable = Boolean(
    isDemo &&
    activeCell &&
    (activeLane === 'stream_truncated' || activeLane === 'force_cooldown' || activeLane === 'other_failures'),
  );
  const sliceTelemetryParams = React.useMemo(
    () => (activeCell && data && !isDemo ? stabilitySliceTelemetryParams(data.window, activeCell, filters) : null),
    [activeCell, data, filters, isDemo],
  );
  const sliceTelemetryQuery = useQuery({
    queryKey: ['trends-telemetry-slice', sliceTelemetryParams],
    queryFn: ({ signal }) => api.getTrendsTelemetry(sliceTelemetryParams!, signal),
    enabled: !isStale && sliceTelemetryParams !== null,
    staleTime: 15_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: isPollingActive && !isDemo && data?.window.open_end ? insightsPollInterval(data.window) : false,
    retry: (count, error) => apiErrorCode(error) !== 'demo_uncaptured' && count < 1,
    meta: { silent: true },
  });

  const demoSliceEventsParams = React.useMemo(() => {
    if (!activeCell || !data || !isDemo || isDemoLaneSliceUnavailable) return null;
    return stabilityDemoSliceEventsQueryString(data.window, filters, activeCell);
  }, [activeCell, data, filters, isDemo, isDemoLaneSliceUnavailable]);
  const demoSliceEventsQuery = useQuery({
    queryKey: ['trends-stability-demo-slice', demoSliceEventsParams],
    queryFn: ({ signal }) => api.getUsageEvents(demoSliceEventsParams!, signal),
    enabled: !isStale && demoSliceEventsParams !== null,
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  const isSliceQueryEnabled = Boolean(
    !isStale && activeCell && !isDemoLaneSliceUnavailable && !isCellSliceUnaddressable && (isDemo ? demoSliceEventsParams !== null : sliceTelemetryParams !== null),
  );
  const isSlicePending = Boolean(
    isSliceQueryEnabled && (isDemo ? demoSliceEventsQuery.isPending : sliceTelemetryQuery.isPending),
  );
  const isSliceFetching = Boolean(
    isSliceQueryEnabled && (isDemo ? demoSliceEventsQuery.isFetching : sliceTelemetryQuery.isFetching),
  );
  const sliceError = isSliceQueryEnabled
    ? (isDemo ? demoSliceEventsQuery.error : sliceTelemetryQuery.error)
    : null;
  const retrySlice = () => {
    if (isDemo) void demoSliceEventsQuery.refetch();
    else void sliceTelemetryQuery.refetch();
  };

  const isDemoSlicePartial = Boolean(
    isDemo &&
    activeCell &&
    demoSliceEventsQuery.data &&
    (demoSliceEventsQuery.data.has_more ||
      (activeCell.total_requests > 0 && demoSliceEventsQuery.data.items.length < activeCell.total_requests)),
  );
  const isFailureGroupsTruncated = Boolean(
    activeCell
      ? (!isDemo && sliceTelemetryQuery.data?.failure_groups_truncated)
      : data?.failure_groups_truncated,
  );
  const isFailureGroupsPartial = isDemoSlicePartial || isFailureGroupsTruncated;

  // Never fall back to whole-window or another cell's attribution while the current cell is pending.
  const activeFailureGroups = React.useMemo(() => {
    if (activeCell) {
      if (isDemoLaneSliceUnavailable || isCellSliceUnaddressable || sliceError) return [];
      if (isDemo) {
        if (!demoSliceEventsQuery.data) return [];
        return deriveFailureGroupsFromEvents(demoSliceEventsQuery.data.items, {
          isCapped: isDemoSlicePartial,
          omitUncategorizedOther: true,
        });
      }
      return sliceTelemetryQuery.data?.failure_groups ?? [];
    }
    return data?.failure_groups ?? [];
  }, [activeCell, data?.failure_groups, demoSliceEventsQuery.data, isCellSliceUnaddressable, isDemo, isDemoLaneSliceUnavailable, isDemoSlicePartial, sliceError, sliceTelemetryQuery.data]);

  const activePairs = React.useMemo(() => {
    if (activeCell) {
      if (isCellSliceUnaddressable || sliceError) return [];
      if (isDemo) {
        if (!demoSliceEventsQuery.data) return [];
        return deriveSubstitutionPairsFromEvents(demoSliceEventsQuery.data.items);
      }
      if (!sliceTelemetryQuery.data) return [];
      return sliceTelemetryQuery.data.substitution_pairs;
    }
    return data?.substitution_pairs ?? [];
  }, [activeCell, data?.substitution_pairs, demoSliceEventsQuery.data, isCellSliceUnaddressable, isDemo, sliceError, sliceTelemetryQuery.data]);

  const activeFailureLane = isStabilityFailureLane(activeLane) ? activeLane : null;
  const attributionRows = React.useMemo(
    () => aggregateStabilityFailures(activeFailureGroups, attributionDim, activeFailureLane, { isPartial: isFailureGroupsPartial }),
    [activeFailureGroups, activeFailureLane, attributionDim, isFailureGroupsPartial],
  );
  const visibleAttributionRows = showAllRows ? attributionRows : attributionRows.slice(0, ATTRIBUTION_LIMIT);

  const rate = data ? successRate(data.summary) : null;
  const bucket = (data?.window.bucket ?? 'day') as InsightsBucket;
  const isDense = displayCells.length > DENSE_BUCKETS || (trackWidth !== null && trackWidth > 0 && displayCells.length * 4 > trackWidth);

  const scale = React.useMemo(() => {
    void timeZone;
    if (displayCells.length === 0) return [];
    const first = displayCells[0]!;
    const last = displayCells[displayCells.length - 1]!;
    if (!isAggregated) {
      const raw = displayCells.length === 1
        ? [first.start_ms]
        : [first.start_ms, displayCells[Math.floor((displayCells.length - 1) / 2)]!.start_ms, last.start_ms];
      return [...new Set(raw.map((ms) => dayjs(ms).format(AXIS_FORMATS[bucket])))];
    }
    const endInstant = bucket === 'hour' ? last.end_ms : Math.max(last.last_start_ms, data?.window.to ?? last.last_start_ms);
    const midInstant = Math.round(first.start_ms + (endInstant - first.start_ms) / 2);
    const raw = displayCells.length === 1
      ? [first.start_ms, endInstant]
      : [first.start_ms, midInstant, endInstant];
    return [...new Set(raw.map((ms) => dayjs(ms).format(AXIS_FORMATS[bucket])))];
  }, [bucket, data?.window.to, displayCells, isAggregated, timeZone]);

  const stepLaneCell = (currentIndex: number, key: string): number | null => {
    const count = displayCells.length;
    if (count === 0) return null;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    if (key === 'ArrowLeft') return Math.max(0, currentIndex - 1);
    if (key === 'ArrowRight') return Math.min(count - 1, currentIndex + 1);
    return null;
  };

  const toggleLane = (lane: StabilityLane) => {
    if (isStale) return;
    setShowAllRows(false);
    if (activeLane === lane && activeCell === null) {
      setSelectedLane(null);
      return;
    }
    setSelectedLane(lane);
    if (activeCell && activeCell[lane] === 0) {
      setSelectedCell(null);
    }
  };

  const toggleCell = (lane: StabilityLane, cell: StabilityDisplayBucket) => {
    if (isStale || cell[lane] <= 0) return;
    setShowAllRows(false);
    if (activeLane === lane && activeCell?.start_ms === cell.start_ms && activeCell?.end_ms === cell.end_ms) {
      setSelectedLane(null);
      setSelectedCell(null);
      return;
    }
    setSelectedLane(lane);
    setSelectedCell(cell);
  };

  const clearFocus = () => {
    setSelectedLane(null);
    setSelectedCell(null);
    setShowAllRows(false);
  };

  const activeCellHeading = activeCell ? formatCellHeading(activeCell, bucket) : undefined;
  const activeScopeCount = React.useMemo(() => {
    if (!data) return undefined;
    if (activeCell && activeLane) {
      // When no current display cell matches the selected endpoints (e.g. after a resize regrouping),
      // read the exact count for the clamped query interval from the matching slice response instead
      // of reusing the stale cell snapshot.
      if (!exactDisplayCell) {
        if (isCellSliceUnaddressable || isDemoLaneSliceUnavailable || sliceError) return undefined;
        if (isDemo) {
          if (!demoSliceEventsQuery.data || isDemoSlicePartial) return undefined;
          if (activeLane === 'model_substituted') {
            return demoSliceEventsQuery.data.items.filter((item) => item.model_substituted).length;
          }
          if (activeLane === 'rate_limited_429') {
            return demoSliceEventsQuery.data.items.filter((item) => item.failed && item.fail_status_code === 429).length;
          }
          if (activeLane === 'upstream_5xx') {
            return demoSliceEventsQuery.data.items.filter((item) => item.failed && (item.fail_status_code ?? 0) >= 500 && (item.fail_status_code ?? 0) < 600).length;
          }
          return undefined;
        }
        return sliceTelemetryQuery.data?.summary[activeLane];
      }
      return exactDisplayCell[activeLane];
    }
    if (activeLane) return lanes.find((entry) => entry.lane === activeLane)?.total;
    return data.summary.failed_requests;
  }, [activeCell, activeLane, data, demoSliceEventsQuery.data, exactDisplayCell, isCellSliceUnaddressable, isDemo, isDemoLaneSliceUnavailable, isDemoSlicePartial, lanes, sliceError, sliceTelemetryQuery.data]);

  const scopedEventsHref = React.useMemo(() => {
    if (!data || isStale) return null;
    return stabilityEventsHref(data.window, filters, { lane: activeLane, cell: activeCell }, { isDemo });
  }, [activeCell, activeLane, data, filters, isDemo, isStale]);

  const openScopeDrawer = () => {
    if (!data || isStale) return;
    setInspectTarget({
      lane: activeLane,
      cell: activeCell,
      cellHeading: activeCellHeading,
      row: null,
      count: activeScopeCount,
      window: data.window,
      filters,
      failureGroups: activeFailureGroups,
    });
  };

  const openRowDrawer = (row: StabilityAttributionRow) => {
    if (!data || isStale) return;
    setInspectTarget({
      lane: activeLane,
      cell: activeCell,
      cellHeading: activeCellHeading,
      row,
      count: row.failures,
      window: data.window,
      filters,
      failureGroups: activeFailureGroups,
    });
  };

  const resolvePairHref = (pair: TrendsSubstitutionPair): string | null => {
    if (!data || isStale) return null;
    if (!activeCell) return pairHref(pair);
    return activeCellSpan ? substitutionEventsHref(activeCellSpan, filters, pair, { isDemo }) : null;
  };

  const rowDisplayName = (row: StabilityAttributionRow) =>
    row.id ? identity.label(row.dimension, { id: row.id, label: row.label }) : t('trends.stability.unassigned_credential');

  const renderPeerContext = (row: StabilityAttributionRow) => {
    if (row.dimension === 'credential') {
      const topModel = row.peers[0];
      const extraModels = row.peers.length - 1;
      const peersTip = row.peers.length > 1
        ? tipCard({
            heading: t('trends.stability.affected_models'),
            rows: row.peers.slice(0, 6).map((peer) => ({
              label: peer.label || t('trends.stability.unknown_model'),
              value: peer.count.toLocaleString('en'),
              tone: 'danger' as const,
            })),
          })
        : undefined;
      return (
        <div role="cell" className={styles['attribution-context']}>
          {row.providerId && (
            <Tag size="small" icon={identity.mark('provider', row.providerId)}>
              {identity.label('provider', { id: row.providerId, label: row.providerLabel })}
            </Tag>
          )}
          {topModel && (
            <span className={styles['attribution-peer']} {...peersTip}>
              <span className={styles['attribution-peer-name']} data-tip={extraModels === 0 ? topModel.label : undefined} data-tip-overflow={extraModels === 0 ? '' : undefined}>
                {topModel.label || t('trends.stability.unknown_model')}
              </span>
              {extraModels > 0 && <span className={styles['attribution-peer-more']}>{`+${extraModels}`}</span>}
            </span>
          )}
        </div>
      );
    }

    const peerDim = row.dimension === 'model' ? 'provider' : 'model';
    const topPeer = row.peers[0];
    if (!topPeer) return <div role="cell" className={styles['attribution-context']} />;
    const extraPeers = row.peers.length - 1;
    const topName = peerDim === 'provider'
      ? identity.label('provider', { id: topPeer.id, label: topPeer.label })
      : (topPeer.label || t('trends.stability.unknown_model'));
    const tipRows: TipRow[] = row.peers.slice(0, 6).map((peer) => ({
      label: peerDim === 'provider'
        ? identity.label('provider', { id: peer.id, label: peer.label })
        : (peer.label || t('trends.stability.unknown_model')),
      value: peer.count.toLocaleString('en'),
      tone: 'danger',
    }));
    const tipNotes = row.credentialCount > 0
      ? [t('trends.stability.affected_credentials', { n: row.credentialCount })]
      : undefined;
    const peersTip = (extraPeers > 0 || row.credentialCount > 0)
      ? tipCard({
          heading: t(peerDim === 'provider' ? 'trends.stability.affected_providers' : 'trends.stability.affected_models'),
          rows: tipRows,
          notes: tipNotes,
        })
      : undefined;

    return (
      <div role="cell" className={styles['attribution-context']} {...peersTip}>
        {peerDim === 'provider' ? (
          <Tag size="small" icon={identity.mark('provider', topPeer.id)}>{topName}</Tag>
        ) : (
          <span className={styles['attribution-peer']}>
            <ModelMark model={topPeer.label} size={14} />
            <span className={styles['attribution-peer-name']} data-tip={extraPeers === 0 ? topName : undefined} data-tip-overflow={extraPeers === 0 ? '' : undefined}>
              {topName}
            </span>
          </span>
        )}
        {extraPeers > 0 && <span className={styles['attribution-peer-more']}>{`+${extraPeers}`}</span>}
      </div>
    );
  };

  const hasFailureRate = visibleAttributionRows.some((row) => row.failureRate !== null);
  const contextColLabel = attributionDim === 'model'
    ? t('trends.stability.dim.provider')
    : attributionDim === 'provider'
      ? t('trends.stability.dim.model')
      : t('trends.stability.col.context');
  const attributionLabelVars = {
    '--attribution-failures-label': JSON.stringify(t('trends.stability.drawer.failures')),
    '--attribution-rate-label': JSON.stringify(t('trends.stability.col.failure_rate')),
  } as React.CSSProperties;

  const showAttribution = hasFailureLanes && activeLane !== 'model_substituted' && (attributionRows.length > 0 || Boolean(activeCell));
  const isSubstitutionSlice = Boolean(activeCell && activeLane === 'model_substituted');
  const showSubstitutions =
    (!activeLane || activeLane === 'model_substituted') &&
    (activePairs.length > 0 || Boolean(isSubstitutionSlice && (isSlicePending || Boolean(sliceError) || isDemoSlicePartial)));

  return (
    <>
      <Panel
        id="trends-stability"
        className={styles.section}
        data-testid="trends-stability"
        title={(
          <PanelTitle extra={rate === null ? undefined : <span className={styles['panel-meta']}>{t('trends.stability.success', { value: formatPercent(rate * 100) })}</span>}>
            {t('trends.stability.title')}
          </PanelTitle>
        )}
      >
        {!data && isUnavailable ? (
          <EmptyState size="compact" title={t('trends.unavailable')} />
        ) : !data ? (
          <div className="chart-placeholder" style={{ height: 180 }} aria-hidden="true" />
        ) : data.summary.total_requests === 0 ? (
          <EmptyState size="compact" title={t('trends.no_usage')} />
        ) : lanes.length === 0 && data.substitution_pairs.length === 0 ? (
          <div className={styles['stability-clear']} data-testid="trends-stability-clear">
            <CheckCircleOutlined className={styles['stability-clear-icon']} aria-hidden="true" />
            <span>{t('trends.stability.clear')}</span>
          </div>
        ) : (
          <div className={styles['panel-body']}>
            {lanes.length > 0 && (
              <div
                className={styles.lanes}
                role="list"
                aria-label={t('trends.stability.title')}
                data-dense={isDense || undefined}
                data-has-selection={activeLane !== null ? 'true' : undefined}
              >
                {lanes.map((lane, laneIndex) => {
                  const laneLabel = t(`trends.stability.lane.${lane.lane}`);
                  const isLaneSelected = activeLane === lane.lane;
                  const activeCellIndex = Math.min(Math.max(0, displayCells.length - 1), Math.max(0, focusedCells[lane.lane] ?? 0));
                  return (
                    <div
                      key={lane.lane}
                      className={styles.lane}
                      role="listitem"
                      data-testid={`trends-lane-${lane.lane}`}
                      data-selected={isLaneSelected || undefined}
                    >
                      <button
                        type="button"
                        className={styles['lane-trigger']}
                        aria-pressed={isLaneSelected}
                        disabled={isStale}
                        onClick={() => toggleLane(lane.lane)}
                        data-testid={`trends-lane-toggle-${lane.lane}`}
                      >
                        {laneLabel}
                      </button>
                      <span
                        ref={laneIndex === 0 ? setTrackNode : undefined}
                        className={styles['lane-cells']}
                        style={trackStyle}
                        role="group"
                        aria-label={laneLabel}
                        onKeyDown={(event) => {
                          const target = (event.target as Element | null)?.closest<HTMLElement>(`.${styles['lane-cell']}`);
                          const currentIndex = target?.dataset.cellIndex !== undefined
                            ? Number(target.dataset.cellIndex)
                            : activeCellIndex;
                          const nextIndex = stepLaneCell(currentIndex, event.key);
                          if (nextIndex === null || nextIndex === currentIndex) return;
                          event.preventDefault();
                          setFocusedCells((curr) => ({ ...curr, [lane.lane]: nextIndex }));
                          cellRefs.current[lane.lane]?.[nextIndex]?.focus();
                        }}
                      >
                        {lane.counts.map((count, index) => {
                          const cell = displayCells[index]!;
                          const weight = count === 0 || lane.max === 0 ? 0 : Math.round(MIN_WEIGHT + (100 - MIN_WEIGHT) * (count / lane.max));
                          const isCellSelected = Boolean(
                            isLaneSelected &&
                            activeCell &&
                            cell.start_ms <= activeCell.start_ms &&
                            cell.end_ms >= activeCell.end_ms,
                          );
                          const cellRate = cell.total_requests > 0 ? cell.success_requests / cell.total_requests : null;
                          const tipRows: TipRow[] = [
                            { label: laneLabel, value: count.toLocaleString('en'), tone: count > 0 ? laneTone(lane.lane) : 'muted' },
                          ];
                          if (cell.total_requests > 0) {
                            tipRows.push({ label: t('trends.metric.requests'), value: cell.total_requests.toLocaleString('en') });
                          }
                          if (cellRate !== null) {
                            tipRows.push({
                              label: t('trends.tile.delivery'),
                              value: formatPercent(cellRate * 100),
                              tone: cellRate < 0.9 ? 'danger' : cellRate < 0.98 ? 'warn' : undefined,
                            });
                          }
                          const tip = tipCard({
                            heading: formatCellHeading(cell, bucket),
                            rows: tipRows,
                          });
                          const isInteractive = count > 0 && !isStale;
                          return (
                            <button
                              key={cell.start_ms}
                              type="button"
                              ref={(node) => {
                                const list = (cellRefs.current[lane.lane] ??= []);
                                list.length = displayCells.length;
                                list[index] = node;
                              }}
                              tabIndex={index === activeCellIndex ? 0 : -1}
                              data-cell-index={index}
                              data-focus-ring="outer"
                              aria-label={tip['data-tip']}
                              aria-disabled={!isInteractive || undefined}
                              aria-pressed={isInteractive ? isCellSelected : undefined}
                              className={styles['lane-cell']}
                              data-tone={count > 0 ? laneTone(lane.lane) : undefined}
                              data-interactive={isInteractive || undefined}
                              data-selected={isCellSelected || undefined}
                              style={{ '--lane-weight': `${weight}%` } as React.CSSProperties}
                              onFocus={() => setFocusedCells((curr) => (curr[lane.lane] === index ? curr : { ...curr, [lane.lane]: index }))}
                              onClick={() => isInteractive && toggleCell(lane.lane, cell)}
                              {...tip}
                            />
                          );
                        })}
                      </span>
                      <span className={styles['lane-total']}>{lane.total.toLocaleString('en')}</span>
                    </div>
                  );
                })}
                {scale.length > 0 && (
                  <div className={styles['lane-scale']} aria-hidden="true">
                    <span className={styles['lane-scale-ticks']}>
                      {scale.map((label, index) => <span key={index}>{label}</span>)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {(activeLane || activeCell) && (
              <div className={styles['stability-scope']} data-testid="trends-stability-scope">
                <MetaLine className={styles['stability-scope-info']}>
                  {activeLane && (
                    <Tag size="small" tone={laneTone(activeLane)}>
                      {t(`trends.stability.lane.${activeLane}`)}
                    </Tag>
                  )}
                  {activeCellHeading && <span className={styles.figure}>{activeCellHeading}</span>}
                  {activeScopeCount !== undefined && (
                    <b className={styles.figure}>{t('trends.stability.pair_count', { n: activeScopeCount })}</b>
                  )}
                </MetaLine>
                <div className={styles['stability-scope-actions']}>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<SearchOutlined />}
                    disabled={isStale || isSlicePending || isDemoLaneSliceUnavailable || isCellSliceUnaddressable}
                    onClick={openScopeDrawer}
                    data-testid="trends-stability-inspect-scope"
                  >
                    {t('trends.stability.inspect_requests')}
                  </Button>
                  <Button
                    size="sm"
                    variant="link"
                    disabled={!scopedEventsHref}
                    onClick={() => scopedEventsHref && onNavigate(scopedEventsHref)}
                    data-testid="trends-stability-scope-events"
                  >
                    {t('trends.view_requests_link')}
                  </Button>
                  <ToolButton
                    size="sm"
                    variant="ghost"
                    icon={<CloseOutlined />}
                    label={t('trends.stability.clear_focus')}
                    onClick={clearFocus}
                    data-testid="trends-stability-clear-focus"
                  />
                </div>
              </div>
            )}

            {showAttribution && (
              <div className={styles['pairs-section']} data-testid="trends-stability-attribution">
                <div className={styles['stability-subhead']}>
                  <div className={styles['stability-subhead-title']}>
                    <h3 className={styles['pairs-heading']}>{t('trends.stability.attribution')}</h3>
                    {isSliceFetching && <Spinner size="small" />}
                  </div>
                  <div className={styles['stability-subhead-tools']}>
                    <Segmented
                      size="small"
                      aria-label={t('trends.stability.attribution_dim')}
                      value={attributionDim}
                      onChange={(value) => {
                        setAttributionDim(value as StabilityAttributionDim);
                        setShowAllRows(false);
                      }}
                      options={STABILITY_ATTRIBUTION_DIMS.map((dim) => ({
                        value: dim,
                        label: t(`trends.stability.dim.${dim}`),
                      }))}
                    />
                    {!activeLane && !activeCell && (
                      <ToolButton
                        size="sm"
                        variant="ghost"
                        className="row-action-btn"
                        icon={<SearchOutlined />}
                        label={t('trends.stability.inspect_requests')}
                        disabled={isStale}
                        onClick={openScopeDrawer}
                        data-testid="trends-stability-inspect-all"
                      />
                    )}
                  </div>
                </div>

                {isDemoLaneSliceUnavailable ? (
                  <p className={styles['stability-empty-slice']}>{t('trends.stability.demo_slice_unavailable')}</p>
                ) : isSlicePending ? (
                  <div className={styles['stability-event-loading']} data-testid="trends-stability-slice-loading">
                    <Spinner size="small" />
                  </div>
                ) : sliceError ? (
                  <LoadFailure
                    tone="warning"
                    title={t('trends.error_title')}
                    error={sliceError}
                    onRetry={retrySlice}
                  />
                ) : visibleAttributionRows.length === 0 ? (
                  <p className={styles['stability-empty-slice']} data-testid={isDemoSlicePartial ? 'trends-attribution-partial' : undefined}>
                    {t(isDemoSlicePartial ? 'trends.stability.demo_slice_partial_failures' : 'trends.stability.slice_empty')}
                  </p>
                ) : (
                  <>
                    <div className={styles['attribution-wrap']}>
                      <div
                        className={styles['attribution-list']}
                        role="table"
                        aria-label={t('trends.stability.attribution')}
                        style={attributionLabelVars}
                        data-no-rate={!hasFailureRate || undefined}
                        data-loading={isSliceFetching || isStale || undefined}
                        data-testid="trends-failure-attribution"
                      >
                        <div className={styles['attribution-head']} role="row">
                          <span role="columnheader">{t(`trends.stability.dim.${attributionDim}`)}</span>
                          <span role="columnheader">{contextColLabel}</span>
                          <span role="columnheader">{t('trends.stability.col.causes')}</span>
                          <span role="columnheader" className={styles['attribution-col-num']}>{t('trends.stability.drawer.failures')}</span>
                          {hasFailureRate && (
                            <span role="columnheader" className={styles['attribution-col-num']}>{t('trends.stability.col.failure_rate')}</span>
                          )}
                          <span role="columnheader" className={styles['attribution-col-actions']}>
                            <span className="sr-only">{t('trends.stability.col.actions')}</span>
                          </span>
                        </div>
                        {visibleAttributionRows.map((row) => {
                          const name = rowDisplayName(row);
                          const canDrill = Boolean(row.id && !row.drillDisabled);
                          const canFilterPage = canDrill && canFilterTrends && !isStale;
                          const signals = rowSignalTags(row, activeLane, t);
                          const shownSignals = signals.slice(0, SIGNAL_TAG_LIMIT);
                          const overflowSignals = signals.slice(SIGNAL_TAG_LIMIT);
                          const rateTone = failureRateTone(row.failureRate);
                          const rowHref = canDrill && !isStale
                            ? stabilityEventsHref(
                                data.window,
                                filters,
                                { lane: activeLane, cell: activeCell, entity: { dimension: row.dimension, id: row.id } },
                                { isDemo },
                              )
                            : null;
                          const manageTarget = canDrill && !isStale && (row.dimension === 'provider' || row.dimension === 'credential')
                            ? identity.manage(row.dimension, row.id)
                            : null;
                          const countTipRows: TipRow[] = [
                            { label: t('trends.stability.drawer.failures'), value: row.failures.toLocaleString('en'), tone: 'danger' },
                          ];
                          if (row.totalRequests > 0) {
                            countTipRows.push({ label: t('trends.metric.requests'), value: row.totalRequests.toLocaleString('en') });
                          }
                          if (row.failureRate !== null) {
                            countTipRows.push({
                              label: t('trends.stability.col.failure_rate'),
                              value: formatPercent(row.failureRate * 100),
                              tone: rateTone,
                            });
                          }
                          if (row.lastFailedAtMs > 0) {
                            countTipRows.push({ label: t('trends.stability.drawer.last_seen'), value: dayjs(row.lastFailedAtMs).format('MM-DD HH:mm:ss') });
                          }
                          const countTip = countTipRows.length > 1 ? tipCard({ heading: name, rows: countTipRows }) : undefined;

                          return (
                            <div
                              key={`${row.dimension}\u0000${row.id}\u0000${row.label}`}
                              className={styles['attribution-row']}
                              role="row"
                              data-testid="trends-failure-row"
                            >
                              <div role="cell" className={styles['attribution-entity']}>
                                {canFilterPage ? (
                                  <button
                                    type="button"
                                    className={styles['mover-name']}
                                    aria-pressed={isEntityFiltered(row.dimension, row.id)}
                                    onClick={() => onToggleFilter(row.dimension, row.id)}
                                  >
                                    <TrendsValue mark={identity.mark(row.dimension, row.id)} name={name} />
                                  </button>
                                ) : (
                                  <TrendsValue
                                    mark={row.id ? identity.mark(row.dimension, row.id) : null}
                                    name={name}
                                    className={row.id ? undefined : styles['tone-muted']}
                                  />
                                )}
                              </div>

                              {renderPeerContext(row)}

                              <div role="cell" className={styles['attribution-signals']}>
                                {shownSignals.map((sig) => (
                                  <Tag key={sig.key} size="small" tone="danger">
                                    {`${sig.label} × ${sig.count}`}
                                  </Tag>
                                ))}
                                {overflowSignals.length > 0 && (
                                  <span
                                    className={styles['attribution-peer-more']}
                                    {...tipCard({
                                      heading: t('trends.stability.drawer.status_codes'),
                                      rows: signals.map((sig) => ({ label: sig.label, value: sig.count.toLocaleString('en'), tone: 'danger' as const })),
                                    })}
                                  >
                                    {`+${overflowSignals.length}`}
                                  </span>
                                )}
                              </div>

                              <div role="cell" className={styles['attribution-count']} {...countTip}>
                                {row.failures.toLocaleString('en')}
                              </div>

                              {hasFailureRate && (
                                <div role="cell" className={styles['attribution-rate']} data-tone={rateTone} {...countTip}>
                                  {row.failureRate !== null ? formatPercent(row.failureRate * 100) : '—'}
                                </div>
                              )}

                              <div role="cell" className={styles['attribution-actions']}>
                                <ToolButton
                                  size="sm"
                                  variant="ghost"
                                  className="row-action-btn"
                                  icon={<SearchOutlined />}
                                  label={t('trends.stability.inspect_of', { name })}
                                  disabled={isStale}
                                  onClick={() => openRowDrawer(row)}
                                  data-testid="trends-failure-inspect"
                                />
                                {manageTarget && (
                                  <ToolButton
                                    size="sm"
                                    variant="ghost"
                                    className="row-action-btn"
                                    icon={<SettingOutlined />}
                                    label={t(manageTarget.target === 'oauth' ? 'trends.stability.manage_oauth_of' : 'trends.stability.manage_provider_of', { name })}
                                    onClick={() => onNavigate(manageTarget.href)}
                                    data-testid="trends-failure-manage"
                                  />
                                )}
                                <ToolButton
                                  size="sm"
                                  variant="ghost"
                                  className="row-action-btn"
                                  icon={<HistoryOutlined />}
                                  label={t('trends.view_requests_of', { name })}
                                  disabled={!rowHref}
                                  onClick={() => rowHref && onNavigate(rowHref)}
                                  data-testid="trends-failure-events"
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {attributionRows.length > ATTRIBUTION_LIMIT && (
                      <Button
                        size="sm"
                        variant="link"
                        className={styles['attribution-more']}
                        onClick={() => setShowAllRows((curr) => !curr)}
                      >
                        {showAllRows
                          ? t('trends.stability.show_less')
                          : t('trends.stability.show_more', { n: attributionRows.length - ATTRIBUTION_LIMIT })}
                      </Button>
                    )}
                    {isFailureGroupsPartial && (
                      <p className={styles['stability-empty-slice']} data-testid="trends-attribution-partial">
                        {isDemoSlicePartial
                          ? t('trends.stability.demo_slice_partial_failures')
                          : t('trends.stability.partial_breakdown', { n: activeFailureGroups.length })}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {showSubstitutions && (
              <div className={styles['pairs-section']}>
                <h3 className={styles['pairs-heading']}>{t('trends.stability.pairs')}</h3>
                {isSubstitutionSlice && isSlicePending ? (
                  <div className={styles['stability-event-loading']}>
                    <Spinner size="small" />
                  </div>
                ) : isSubstitutionSlice && sliceError ? (
                  <LoadFailure
                    tone="warning"
                    title={t('trends.error_title')}
                    error={sliceError}
                    onRetry={retrySlice}
                  />
                ) : (
                  <>
                    {activePairs.length > 0 && (
                      <ul className={styles.pairs} data-testid="trends-substitutions">
                        {activePairs.slice(0, PAIR_LIMIT).map((pair) => {
                          const href = resolvePairHref(pair);
                          return (
                            <li key={`${pair.provider}\u0000${pair.requested_model}\u0000${pair.served_model}`} className={styles['pair-row']}>
                              <span className={styles['pair-models']}>
                                <ModelMark model={pair.requested_model} size={15} />
                                <span className={styles['pair-model']} data-tip={pair.requested_model} data-tip-overflow="">{pair.requested_model}</span>
                                <ArrowRightOutlined className={styles['pair-arrow']} aria-label={t('trends.stability.served_as')} />
                                <ModelMark model={pair.served_model} size={15} />
                                <span className={`${styles['pair-model']} ${styles['pair-served']}`} data-tip={pair.served_model} data-tip-overflow="">{pair.served_model}</span>
                              </span>
                              <span className={styles['pair-provider']}>{pair.provider && <Tag size="small" icon={identity.mark('provider', pair.provider)}>{identity.label('provider', pair.provider)}</Tag>}</span>
                              <span className={styles['pair-count']}>{t('trends.stability.pair_count', { n: pair.count })}</span>
                              <ToolButton
                                size="sm"
                                variant="ghost"
                                icon={<HistoryOutlined />}
                                label={t('trends.view_requests_of', { name: pair.requested_model })}
                                disabled={!href}
                                onClick={() => href && onNavigate(href)}
                                data-testid="trends-substitution-events"
                              />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {isDemoSlicePartial && (
                      <p className={styles['stability-empty-slice']} data-testid="trends-substitutions-partial">
                        {t('trends.stability.demo_slice_partial')}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>

      <StabilityDetailDrawer
        target={inspectTarget}
        isDemo={isDemo}
        canFilterTrends={canFilterTrends}
        identity={identity}
        onClose={() => setInspectTarget(null)}
        isEntityFiltered={isEntityFiltered}
        onFilterEntity={onToggleFilter}
        onNavigate={onNavigate}
      />
    </>
  );
};
