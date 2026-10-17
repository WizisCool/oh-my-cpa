import React from 'react';
import clsx from 'clsx';
import { Tooltip } from 'antd';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../../api/client';
import { Panel } from '../../common/Panel';
import { Placeholder } from '../../common/Placeholder';
import { LoadFailure } from '../../feedback';
import { useLiveRevision } from '../../../hooks/useLiveRevision';
import { usePluginOAuthLogos } from '../../../hooks/usePluginOAuthLogos';
import { usePreference } from '../../../hooks/usePreference';
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion';
import { useT } from '../../../i18n';
import { EMPTY_PROVIDER_ICONS, PROVIDER_ICONS_PREFERENCE, parseProviderIcons } from '../../../types/providerIcons';
import type { ConfigScalarsResponse } from '../../../types/configManagement';
import { EVENT_AUTO_REFRESH_MS } from '../../../types/usageEventCadence';
import { indexCredentialFiles } from '../../../types/usageEventIdentity';
import type { UsageEvent } from '../../../types/usageEvents';
import {
  allocateSlots,
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
import { seriesColor, type IdentitySources } from './routingIdentity';
import styles from './RoutingPanel.module.css';

const STRATEGY_LABEL_KEYS: Record<string, string> = {
  'round-robin': 'cfg.strategy_round_robin',
  'weighted-round-robin': 'cfg.strategy_wrr',
  'fill-first': 'cfg.strategy_fill_first',
};

const NO_ARRIVALS: RoutingArrivals = { id: 0, routes: [] };
/** The panel's clock: how often attempts are aged out of the minute. */
const CLOCK_MS = 1000;

interface RoutingRead {
  response: UsageRoutingResponse;
  /** The record id the read asked after; undefined for a read of the whole window. */
  after?: number;
  /** Where the browser's clock stood against the server's when the answer arrived. */
  skewMs: number;
}

/**
 * When the reader last started looking at the page, on the browser's clock: Infinity while it is
 * hidden, and zero for a page that opened visible, so every request before the first read counts.
 */
function useShownSince(): React.MutableRefObject<number> {
  const shownSinceRef = React.useRef(typeof document !== 'undefined' && document.visibilityState === 'hidden' ? Infinity : 0);
  React.useEffect(() => {
    const onChange = () => {
      shownSinceRef.current = document.visibilityState === 'visible' ? Date.now() : Infinity;
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return shownSinceRef;
}

interface RoutingWindow {
  records: Map<number, UsageEvent>;
  cooldowns: UsageRoutingCooldown[];
  windowMs: number;
  skewMs: number;
}

/** The server's clock, as the browser best knows it. */
function useServerNow(skewMs: number): number {
  const [now, setNow] = React.useState(() => Date.now() + skewMs);
  React.useEffect(() => {
    setNow(Date.now() + skewMs);
    const timer = setInterval(() => setNow(Date.now() + skewMs), CLOCK_MS);
    return () => clearInterval(timer);
  }, [skewMs]);
  return now;
}

/**
 * The dashboard's live routing panel: the models called in the last minute, the
 * credentials and providers CPA sent them to, and each new request travelling
 * the map while the reader watches.
 *
 * It holds a rolling minute of attempts in the browser. The first read is the
 * whole minute; every live signal after it reads only what was recorded since
 * the newest attempt the panel holds, and a one-second clock ages attempts out,
 * so a model leaves the moment its last request turns a minute old. The window
 * is fixed and the panel sits outside the dashboard's time-range control: it is
 * "now", never a report.
 */
export function RoutingPanel() {
  const t = useT();
  const isReducedMotion = usePrefersReducedMotion();

  const isFetchingRef = React.useRef(false);
  const afterRef = React.useRef<number | undefined>(undefined);
  const shownSinceRef = useShownSince();
  const { revision, liveState, notifySettled } = useLiveRevision({
    isEnabled: true,
    fallbackPollMs: EVENT_AUTO_REFRESH_MS,
    isBusyRef: isFetchingRef,
  });
  const routing = useQuery<RoutingRead>({
    queryKey: ['usage-routing', revision],
    queryFn: async () => {
      const after = afterRef.current;
      const response = await api.getUsageRouting(after);
      return { response, after, skewMs: response.as_of_ms - Date.now() };
    },
    // Each live read is a new key that the window has already folded in.
    gcTime: 15_000,
    // A read the reader did not ask for paints no progress (docs/design.md §7 rule 4).
    meta: { silent: revision > 0 },
  });
  isFetchingRef.current = routing.isFetching;
  React.useEffect(() => {
    if (!routing.isFetching) notifySettled();
  }, [routing.isFetching, notifySettled]);

  // The rolling window, and the requests that reached it since the panel last looked.
  const [rolling, setRolling] = React.useState<RoutingWindow | undefined>(undefined);
  const rollingRef = React.useRef<RoutingWindow | undefined>(undefined);
  const [arrivals, setArrivals] = React.useState<RoutingArrivals>(NO_ARRIVALS);
  const foldedRef = React.useRef<RoutingRead | undefined>(undefined);
  const read = routing.data;
  React.useEffect(() => {
    if (!read || foldedRef.current === read) return;
    foldedRef.current = read;
    const { response, after, skewMs } = read;
    const previous = rollingRef.current;
    // An incremental read that did not fit is a gap: the window starts over from it.
    const isIncremental = after !== undefined && !response.has_more;
    const merged = mergeRoutingRecords(previous?.records, response.records, isIncremental);
    const records = pruneRoutingRecords(merged, response.as_of_ms, response.window_ms);
    afterRef.current = newestRecordIdOf(records) ?? after;
    const next: RoutingWindow = { records, cooldowns: response.cooldowns, windowMs: response.window_ms, skewMs };
    rollingRef.current = next;
    setRolling(next);
    // The first read replays nothing: opening the dashboard is not when those requests ran. Nor does
    // a request that finished while the page was hidden (see `routesFinishedSince`); the rows count it.
    if (previous && response.records.length > 0) {
      const seen = newestRecordIdOf(previous.records) ?? 0;
      const shownSinceServerMs = shownSinceRef.current + skewMs;
      const fresh = routesFinishedSince(
        arrivedRoutes(groupRoutes(liveRecords(records, response.as_of_ms, response.window_ms)), seen),
        shownSinceServerMs,
      );
      if (fresh.length > 0) setArrivals((last) => ({ id: last.id + 1, routes: fresh }));
    }
  }, [read]);

  const nowMs = useServerNow(rolling?.skewMs ?? 0);
  const model = React.useMemo<RoutingModel | undefined>(
    () => (rolling ? buildRoutingModel(liveRecords(rolling.records, nowMs, rolling.windowMs), rolling.cooldowns, nowMs) : undefined),
    [rolling, nowMs],
  );

  // A model keeps its colour for as long as it stays on the panel.
  const slotsRef = React.useRef(new Map<string, number>());
  const slots = React.useMemo(() => {
    const next = allocateSlots(slotsRef.current, model?.models.map((row) => row.id) ?? []);
    slotsRef.current = next;
    return next;
  }, [model]);
  const colorOf = React.useCallback((modelId: string) => {
    const slot = slots.get(modelId);
    return slot === undefined ? 'var(--accent)' : seriesColor(slot);
  }, [slots]);

  const authFiles = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    staleTime: 60_000,
  });
  const providersQuery = useQuery({
    // The sanitized entry, never the providers page's plaintext one.
    queryKey: ['management-providers-sanitized'],
    queryFn: () => api.getManagementProviders(false),
    staleTime: 60_000,
  });
  const configQuery = useQuery<ConfigScalarsResponse>({
    queryKey: ['management-config'],
    queryFn: () => api.getConfigScalars(),
    staleTime: 60_000,
  });
  const { value: providerIcons } = usePreference<Record<string, string>>(
    PROVIDER_ICONS_PREFERENCE,
    EMPTY_PROVIDER_ICONS,
    parseProviderIcons,
  );
  const pluginLogos = usePluginOAuthLogos();
  const credentials = React.useMemo(() => indexCredentialFiles(authFiles.data?.files || []), [authFiles.data]);
  const configuredProviders = providersQuery.data?.providers;
  const sources = React.useMemo<IdentitySources>(
    () => ({ credentials, providerIcons, configuredProviders, pluginLogos }),
    [credentials, providerIcons, configuredProviders, pluginLogos],
  );

  const strategyValue = configQuery.data?.scalars?.routing_strategy;
  const strategy = strategyValue
    ? (STRATEGY_LABEL_KEYS[strategyValue] ? t(STRATEGY_LABEL_KEYS[strategyValue]) : strategyValue)
    : undefined;
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
          colorOf={colorOf}
          nowMs={nowMs}
          strategy={strategy}
          sources={sources}
          arrivals={arrivals}
          isReducedMotion={isReducedMotion}
        />
      )}
    </Panel>
  );
}
