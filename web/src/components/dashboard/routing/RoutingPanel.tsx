import React from 'react';
import clsx from 'clsx';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../../api/client';
import { Panel } from '../../common/Panel';
import { Placeholder } from '../../common/Placeholder';
import { LoadFailure } from '../../feedback';
import { useLiveRevision } from '../../../hooks/useLiveRevision';
import { useProviderBranding } from '../../../hooks/useProviderBranding';
import { useT } from '../../../i18n';
import { EVENT_AUTO_REFRESH_MS } from '../../../types/usageEventCadence';
import { indexCredentialFiles } from '../../../types/usageEventIdentity';
import type { UsageEvent } from '../../../types/usageEvents';
import {
  arrivedRoutes,
  routesFinishedSince,
  buildRoutingModel,
  groupRoutes,
  liveRecords,
  mergeRoutingRecords,
  newestRecordIdOf,
  pruneRoutingRecords,
  type RoutingModel,
  type UsageRoutingCooldown,
  type UsageRoutingResponse,
} from '../../../types/usageRouting';
import { RoutingMap, type RoutingArrivals } from './RoutingMap';
import type { IdentitySources } from './routingIdentity';
import styles from './RoutingPanel.module.css';
import { Tooltip } from '../../common/Tooltip';

const NO_ARRIVALS: RoutingArrivals = { id: 0, routes: [] };
export const ROUTING_WINDOW_CACHE_KEY = ['usage-routing-window'] as const;
export const ROUTING_FETCH_QUERY_KEY = ['usage-routing'] as const;

interface RoutingRead {
  response: UsageRoutingResponse;
  after?: number;
  skewMs: number;
}

export interface RoutingWindow {
  records: Map<number, UsageEvent>;
  cooldowns: UsageRoutingCooldown[];
  windowMs: number;
  skewMs: number;
  after?: number;
}

function useShownSince(hasWarmSnapshot: boolean): React.MutableRefObject<number> {
  const shownSinceRef = React.useRef(
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
      ? Infinity
      : hasWarmSnapshot ? Date.now() : 0,
  );
  React.useEffect(() => {
    const onChange = () => {
      shownSinceRef.current = document.visibilityState === 'visible' ? Date.now() : Infinity;
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return shownSinceRef;
}

/**
 * Computes the exact millisecond delay until the earliest record or cooldown in `rolling` leaves
 * the active window, returning `null` when nothing is waiting to expire.
 *
 * Replacing the unconditional 1-second `setInterval` with an exact-expiry deadline eliminates
 * idle per-second React renders and SVG layout passes when no record ages out of the minute.
 */
export function nextRoutingExpiryDelayMs(rolling: RoutingWindow | undefined, nowServerMs: number): number | null {
  if (!rolling) return null;
  let earliestExpiryMs = Infinity;

  for (const record of rolling.records.values()) {
    const expiresAt = record.timestamp_ms + Math.max(0, record.latency_ms) + rolling.windowMs;
    if (expiresAt > nowServerMs && expiresAt < earliestExpiryMs) {
      earliestExpiryMs = expiresAt;
    }
  }
  for (const cooldown of rolling.cooldowns) {
    if (cooldown.until_at_ms > nowServerMs && cooldown.until_at_ms < earliestExpiryMs) {
      earliestExpiryMs = cooldown.until_at_ms;
    }
  }

  if (!Number.isFinite(earliestExpiryMs)) return null;
  // Coalesce closely-spaced expirations into 250ms buckets so bursts age out smoothly together.
  return Math.max(250, Math.ceil(earliestExpiryMs - nowServerMs) + 25);
}

function useExpiryClock(rolling: RoutingWindow | undefined): number {
  const skewMs = rolling?.skewMs ?? 0;
  const [nowMs, setNowMs] = React.useState(() => Date.now() + skewMs);

  React.useEffect(() => {
    setNowMs(Date.now() + skewMs);
  }, [rolling, skewMs]);

  React.useEffect(() => {
    if (!rolling) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const current = Date.now() + rolling.skewMs;
      const delayMs = nextRoutingExpiryDelayMs(rolling, current);
      if (delayMs === null) return;
      timer = setTimeout(() => {
        timer = undefined;
        setNowMs(Date.now() + rolling.skewMs);
        scheduleNext();
      }, delayMs);
    };

    const onVisibility = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        setNowMs(Date.now() + rolling.skewMs);
        scheduleNext();
      }
    };

    scheduleNext();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [rolling]);

  return nowMs;
}

/**
 * The dashboard's live routing panel: the models called in the last minute, the
 * credentials and providers CPA sent them to, and each new request travelling
 * the map while the reader watches.
 *
 * Persisting the folded `RoutingWindow` in `QueryClient` (`ROUTING_WINDOW_CACHE_KEY`) lets route
 * revisits render the live topology at 0ms without flashing a 260px skeleton or rolling back to
 * an outdated initial read, while `queryClient.clear()` / session sign-out automatically purges it.
 */
export const RoutingPanel = React.memo(function RoutingPanel() {
  const t = useT();
  const queryClient = useQueryClient();

  const cachedWindow = queryClient.getQueryData<RoutingWindow>(ROUTING_WINDOW_CACHE_KEY);
  const [rolling, setRolling] = React.useState<RoutingWindow | undefined>(() => {
    if (!cachedWindow) return undefined;
    const pruned = pruneRoutingRecords(
      cachedWindow.records,
      Date.now() + cachedWindow.skewMs,
      cachedWindow.windowMs,
    );
    return { ...cachedWindow, records: pruned, after: newestRecordIdOf(pruned) ?? cachedWindow.after };
  });
  const rollingRef = React.useRef<RoutingWindow | undefined>(rolling);
  const afterRef = React.useRef<number | undefined>(rolling?.after);

  // On initial page open with no prior window, `shownSince` starts at 0; on warm remount with an
  // existing window, only requests finishing after remount replay as flying packets.
  const shownSinceRef = useShownSince(Boolean(cachedWindow));

  const isFetchingRef = React.useRef(false);
  const { revision, liveState, notifySettled } = useLiveRevision({
    isEnabled: true,
    fallbackPollMs: EVENT_AUTO_REFRESH_MS,
    isBusyRef: isFetchingRef,
  });

  const routing = useQuery<RoutingRead>({
    queryKey: ROUTING_FETCH_QUERY_KEY,
    queryFn: async () => {
      const after = afterRef.current;
      const response = await api.getUsageRouting(after);
      return { response, after, skewMs: response.as_of_ms - Date.now() };
    },
    staleTime: 0,
    gcTime: 2 * 60_000,
    meta: { silent: revision > 0 || Boolean(cachedWindow) },
  });

  const refetchRouting = routing.refetch;
  const lastRevisionRef = React.useRef(revision);
  React.useEffect(() => {
    if (revision === lastRevisionRef.current) return;
    lastRevisionRef.current = revision;
    void refetchRouting();
  }, [revision, refetchRouting]);

  React.useLayoutEffect(() => {
    isFetchingRef.current = routing.isFetching;
    if (!routing.isFetching) notifySettled();
  }, [routing.isFetching, notifySettled]);

  const [arrivals, setArrivals] = React.useState<RoutingArrivals>(NO_ARRIVALS);
  // Ignore any prior mount's incremental `RoutingRead` when no matching folded window survived in cache.
  const foldedRef = React.useRef<RoutingRead | undefined>(
    cachedWindow ? undefined : queryClient.getQueryData<RoutingRead>(ROUTING_FETCH_QUERY_KEY),
  );
  const read = routing.data;

  React.useEffect(() => {
    if (!read || foldedRef.current === read) return;
    foldedRef.current = read;
    const { response, after, skewMs } = read;
    const previous = rollingRef.current;
    // An incremental slice without a base window cannot reconstruct the full minute; reset cursor and re-read full.
    if (!previous && after !== undefined) {
      afterRef.current = undefined;
      void refetchRouting();
      return;
    }
    const isIncremental = previous !== undefined && after !== undefined && !response.has_more;
    const merged = mergeRoutingRecords(previous?.records, response.records, isIncremental);
    const records = pruneRoutingRecords(merged, response.as_of_ms, response.window_ms);
    const nextAfter = newestRecordIdOf(records) ?? after;
    afterRef.current = nextAfter;
    const next: RoutingWindow = {
      records,
      cooldowns: response.cooldowns,
      windowMs: response.window_ms,
      skewMs,
      after: nextAfter,
    };
    rollingRef.current = next;
    queryClient.setQueryData<RoutingWindow>(ROUTING_WINDOW_CACHE_KEY, next);
    setRolling(next);

    if (previous && response.records.length > 0) {
      const seen = newestRecordIdOf(previous.records) ?? 0;
      const shownSinceServerMs = shownSinceRef.current + skewMs;
      const fresh = routesFinishedSince(
        arrivedRoutes(groupRoutes(liveRecords(records, response.as_of_ms, response.window_ms)), seen),
        shownSinceServerMs,
      );
      if (fresh.length > 0) setArrivals((last) => ({ id: last.id + 1, routes: fresh }));
    }
  }, [read, queryClient, refetchRouting, shownSinceRef]);

  const nowMs = useExpiryClock(rolling);
  const model = React.useMemo<RoutingModel | undefined>(
    () => (rolling ? buildRoutingModel(liveRecords(rolling.records, nowMs, rolling.windowMs), rolling.cooldowns, nowMs) : undefined),
    [rolling, nowMs],
  );

  const authFiles = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    staleTime: 60_000,
  });
  const {
    providerIcons,
    pluginLogos,
    multiPortalKeys,
    pluginTitles,
    configuredProviders,
    isProviderCatalogUnknown,
  } = useProviderBranding();
  const credentials = React.useMemo(() => indexCredentialFiles(authFiles.data?.files || []), [authFiles.data]);
  const sources = React.useMemo<IdentitySources>(
    () => ({ credentials, providerIcons, configuredProviders, pluginLogos, multiPortalKeys, pluginTitles, isProviderCatalogUnknown }),
    [credentials, providerIcons, configuredProviders, pluginLogos, multiPortalKeys, pluginTitles, isProviderCatalogUnknown],
  );

  const isLive = liveState === 'live';

  return (
    <Panel className={clsx('dashboard-tile', styles['panel'])} data-testid="dashboard-routing">
      <div className={styles['head']}>
        <span className={styles['title']}>
          <span className="tile-label">{t('routing.title')}</span>
          <Tooltip title={t(isLive ? 'events.live_pushed' : 'events.live_polling')}>
            <span className={styles['live']} data-testid="routing-live">
              <span className={clsx(styles['live-dot'], isLive && styles['live-dot-on'])} aria-hidden="true" />
              {t(isLive ? 'routing.live' : 'routing.polling')}
            </span>
          </Tooltip>
          <span className={styles['window']}>{t('routing.window')}</span>
        </span>
      </div>

      {routing.isError && (
        <LoadFailure
          className={styles['alert']}
          tone={model ? 'warning' : 'error'}
          title={t('routing.load_error')}
          error={routing.error}
          onRetry={() => void routing.refetch()}
        />
      )}
      {!model && !routing.isError && <Placeholder width="100%" height={260} />}
      {model && (
        <RoutingMap
          model={model}
          nowMs={nowMs}
          skewMs={rolling?.skewMs ?? 0}
          sources={sources}
          arrivals={arrivals}
        />
      )}
    </Panel>
  );
});
