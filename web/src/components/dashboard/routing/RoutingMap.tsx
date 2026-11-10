import React from 'react';
import clsx from 'clsx';
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion';
import { isMotionReduced } from '../../../utils/motionPreference';
import { sharedResizeObserverHub } from '../../../performance/resizeObserverHub';

import { BrandArtwork } from '../../common/BrandArtwork';
import { ProviderBrandIcon } from '../../LobeIcon';
import { ModelMark } from '../../ModelMark';
import { useT } from '../../../i18n';
import { MOTION_ROUTE_ENTER, MOTION_ROUTE_EXIT, MOTION_ROUTE_PRESENCE } from '../../../theme/themeConfig';
import {
  MAX_DRAWN_MODELS,
  type PresencePhase,
  type RoutingModel,
  type RoutingModelRow,
  type RoutingRoute,
  type RoutingTarget,
} from '../../../types/usageRouting';
import { GATEWAY_NODE, createPacketPlayer, edgeKey, laneKey } from './routingPackets';
import { targetIdentity, type IdentitySources } from './routingIdentity';
import { CooldownLabel } from './CooldownLabel';
import { usePresence } from './usePresence';
import { useFlip, useRowMotion } from './rowMotion';
import styles from './RoutingPanel.module.css';

interface Point { x: number; y: number }

const PRESENCE_SHIFT_PX = 12;
const COMPACT_SPINE_MAX_WIDTH = 620;
const awayFrom = (side: 1 | -1, container: HTMLElement | null) => {
  const panel = container?.closest<HTMLElement>('[data-testid="dashboard-routing"]') ?? container;
  const effectiveSide = side === 1 && panel && panel.clientWidth > 0 && panel.clientWidth <= COMPACT_SPINE_MAX_WIDTH
    ? -1
    : side;
  return `translateX(${effectiveSide * PRESENCE_SHIFT_PX}px)`;
};
const ENTER_STAGGER_MS = 40;
const TRACKING_MS = MOTION_ROUTE_ENTER.duration + MAX_DRAWN_MODELS * ENTER_STAGGER_MS + 80;
const DENSE_ROWS = 4;
const GHOST = '\u0000ghost';
const ORBIT_BOX = 184;

function curve(from: Point, to: Point): string {
  const dx = (to.x - from.x) * 0.55;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${(from.x + dx).toFixed(1)} ${from.y.toFixed(1)}, ${(to.x - dx).toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

/** Elements registered by key, with ref callbacks that keep their identity across renders. */
function useRegistry<T extends Element>() {
  return React.useMemo(() => {
    const elements = new Map<string, T>();
    const callbacks = new Map<string, (element: T | null) => void>();
    return {
      entries: () => elements.entries(),
      get: (key: string) => elements.get(key) ?? null,
      ref: (key: string) => {
        let callback = callbacks.get(key);
        if (!callback) {
          callback = (element: T | null) => {
            if (element) elements.set(key, element);
            else elements.delete(key);
          };
          callbacks.set(key, callback);
        }
        return callback;
      },
    };
  }, []);
}

function useLaneMotion(ref: React.RefObject<SVGGElement | null>, phase: PresencePhase, delayMs: number) {
  const isReducedMotion = usePrefersReducedMotion();
  const entranceRef = React.useRef<Animation>();
  React.useLayoutEffect(() => {
    if (phase !== 'entering' || isMotionReduced()) return;
    entranceRef.current = ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: MOTION_ROUTE_PRESENCE.duration, easing: MOTION_ROUTE_PRESENCE.easing,
      delay: delayMs + MOTION_ROUTE_ENTER.duration / 3, fill: 'backwards',
    });
    return () => entranceRef.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useLayoutEffect(() => {
    if (isReducedMotion) entranceRef.current?.cancel();
  }, [isReducedMotion]);
  React.useLayoutEffect(() => {
    if (phase !== 'exiting' || isReducedMotion) return;
    const animation = ref.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: MOTION_ROUTE_EXIT.duration, easing: MOTION_ROUTE_EXIT.easing, fill: 'forwards',
    });
    return () => animation?.cancel();
  }, [phase, isReducedMotion, ref]);
}

export interface RoutingArrivals {
  id: number;
  routes: RoutingRoute[];
}

export interface RoutingMapProps {
  model: RoutingModel;
  nowMs: number;
  skewMs?: number;
  sources: IdentitySources;
  arrivals: RoutingArrivals;
}

const modelKey = (row: RoutingModelRow) => row.id;
const targetKey = (target: RoutingTarget) => target.id;
const ghostKey = (key: string) => key;

export const RoutingMap = React.memo(function RoutingMap({
  model,
  nowMs,
  skewMs = 0,
  sources,
  arrivals,
}: RoutingMapProps) {
  const t = useT();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const layerRef = React.useRef<SVGGElement>(null);
  const hubRef = React.useRef<HTMLDivElement>(null);
  const gatewayRef = React.useRef<HTMLSpanElement>(null);
  const paths = useRegistry<SVGPathElement>();
  const modelTiles = useRegistry<HTMLElement>();
  const targetTiles = useRegistry<HTMLElement>();
  const washes = useRegistry<HTMLElement>();
  const halos = useRegistry<HTMLElement>();

  const isReducedMotion = usePrefersReducedMotion();
  const exitMs = isReducedMotion ? 0 : MOTION_ROUTE_EXIT.duration;
  const isEmpty = model.models.length === 0;
  const models = usePresence(model.models, modelKey, exitMs);
  const targets = usePresence(model.targets, targetKey, exitMs);
  const ghostItems = React.useMemo(() => (isEmpty ? [GHOST] : []), [isEmpty]);
  const ghosts = usePresence(ghostItems, ghostKey, exitMs);

  const draw = React.useCallback(() => {
    const container = containerRef.current;
    const gateway = gatewayRef.current;
    if (!container || !gateway) return;

    // Phase 1: Batch all DOM geometry reads up front without `querySelectorAll` scans.
    const box = container.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return;
    const node = gateway.getBoundingClientRect();
    const middle = node.top + node.height / 2 - box.top;
    const gatewayLeftX = node.left - box.left;
    const gatewayRightX = node.right - box.left;
    const gatewayMidX = gatewayLeftX + node.width / 2;

    const modelAnchors = new Map<string, Point>();
    for (const [id, element] of modelTiles.entries()) {
      const rect = element.getBoundingClientRect();
      modelAnchors.set(id, { x: rect.right - box.left, y: rect.top + rect.height / 2 - box.top });
    }

    let isSpineLayout = false;
    const targetAnchors = new Map<string, Point>();
    for (const [id, element] of targetTiles.entries()) {
      const rect = element.getBoundingClientRect();
      const targetMidX = rect.left - box.left + rect.width / 2;
      const isLeftOfGateway = targetMidX < gatewayMidX;
      if (isLeftOfGateway) isSpineLayout = true;
      targetAnchors.set(id, {
        x: (isLeftOfGateway ? rect.right : rect.left) - box.left,
        y: rect.top + rect.height / 2 - box.top,
      });
    }

    // On narrow/mobile containers, both columns sit on the left with their tiles facing the right
    // gateway corridor; separating inbound (upper-left) and outbound (lower-left) ports keeps S-curves
    // untangled inside the open corridor.
    const portSpread = Math.min(10, node.height * 0.16);
    const hubIn: Point = isSpineLayout
      ? { x: gatewayLeftX, y: middle - portSpread }
      : { x: gatewayLeftX, y: middle };
    const hubOut: Point = isSpineLayout
      ? { x: gatewayLeftX, y: middle + portSpread }
      : { x: gatewayRightX, y: middle };

    // Phase 2: Write only changed SVG path strings.
    for (const [key, path] of paths.entries()) {
      let d = '';
      if (key.startsWith('in:')) {
        const from = modelAnchors.get(key.slice(3));
        if (from) d = curve(from, hubIn);
      } else if (key.startsWith('out:')) {
        const to = targetAnchors.get(key.slice(4));
        if (to) d = curve(hubOut, to);
      }
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    }
  }, [modelTiles, targetTiles, paths]);

  // Synchronously align SVG lane endpoints after every committed `RoutingMap` render before paint.
  React.useLayoutEffect(() => {
    draw();
  });

  // Deadline-extending frame tracker: runs `draw()` on `requestAnimationFrame` strictly while rows
  // are animating (enter/exit/FLIP), never cancelling mid-flight when presence settles from
  // `'entering'` to `'present'`, and remaining completely dormant at 0fps when idle.
  const trackingUntilRef = React.useRef(0);
  const trackingFrameRef = React.useRef(0);
  const settleFrameRef = React.useRef(0);

  const stopTracking = React.useCallback(() => {
    if (trackingFrameRef.current) {
      cancelAnimationFrame(trackingFrameRef.current);
      trackingFrameRef.current = 0;
    }
    if (settleFrameRef.current) {
      cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = 0;
    }
    trackingUntilRef.current = 0;
  }, []);

  const extendTracking = React.useCallback((durationMs: number = TRACKING_MS) => {
    if (isMotionReduced()) return;
    trackingUntilRef.current = Math.max(trackingUntilRef.current, performance.now() + durationMs);
    if (trackingFrameRef.current) return;
    const step = (now: number) => {
      draw();
      if (now < trackingUntilRef.current && !isMotionReduced()) {
        trackingFrameRef.current = requestAnimationFrame(step);
      } else {
        trackingFrameRef.current = 0;
        trackingUntilRef.current = 0;
        settleFrameRef.current = requestAnimationFrame(() => {
          settleFrameRef.current = 0;
          draw();
        });
      }
    };
    trackingFrameRef.current = requestAnimationFrame(step);
  }, [draw]);

  React.useEffect(() => () => stopTracking(), [stopTracking]);
  React.useLayoutEffect(() => {
    if (isReducedMotion) stopTracking();
  }, [isReducedMotion, stopTracking]);

  const notifyRowMotion = React.useCallback(() => {
    extendTracking(TRACKING_MS);
  }, [extendTracking]);

  const keysSignature = `${models.map((e) => e.key).join(',')}|${targets.map((e) => e.key).join(',')}|${ghosts.map((e) => e.key).join(',')}`;
  const prevKeysRef = React.useRef(keysSignature);
  const hasTransientPhase = models.some((e) => e.phase !== 'present')
    || targets.some((e) => e.phase !== 'present')
    || ghosts.some((e) => e.phase !== 'present');

  React.useLayoutEffect(() => {
    const keysChanged = prevKeysRef.current !== keysSignature;
    prevKeysRef.current = keysSignature;
    if (!isReducedMotion && (hasTransientPhase || keysChanged)) {
      extendTracking(TRACKING_MS);
    }
  }, [keysSignature, hasTransientPhase, isReducedMotion, extendTracking]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    return sharedResizeObserverHub.observe(container, () => draw(), { freezeOnTransition: false });
  }, [draw]);

  const playerRef = React.useRef<ReturnType<typeof createPacketPlayer> | undefined>(undefined);
  React.useEffect(() => {
    const player = createPacketPlayer({
      layer: () => layerRef.current,
      path: paths.get,
      wash: washes.get,
      halo: halos.get,
      gateway: () => hubRef.current,
      classNames: {
        packet: styles['packet'],
        packetHead: styles['packet-head'],
        packetTail: styles['packet-tail'],
        gatewayBusy: styles['hub-busy'],
        washRequest: styles['wash-request'],
        washSuccess: styles['wash-success'],
        washFailure: styles['wash-failure'],
      },
    });
    playerRef.current = player;
    return () => {
      player.dispose();
      playerRef.current = undefined;
    };
  }, [paths, washes, halos]);

  React.useEffect(() => {
    if (arrivals.routes.length === 0) return;
    playerRef.current?.play(arrivals.routes);
  }, [arrivals]);

  const isDense = Math.max(models.length, targets.length) > DENSE_ROWS;

  return (
    <div
      ref={containerRef}
      className={clsx(styles['map'], isDense && styles['map-dense'], isEmpty && styles['map-idle'])}
      data-testid="routing-map"
      data-routing-map=""
    >
      <svg className={styles['map-edges']} aria-hidden="true">
        {ghosts.map(({ key, phase }) => (
          <React.Fragment key={key}>
            <GhostLane phase={phase} modelId={GHOST} pathRef={paths.ref(laneKey(GHOST))} />
            <GhostLane phase={phase} targetId={GHOST} pathRef={paths.ref(edgeKey(GHOST))} />
          </React.Fragment>
        ))}
        {models.map(({ key, item, phase }) => (
          <Lane
            key={`in:${key}`}
            phase={phase}
            delayMs={0}
            modelId={key}
            isFailing={item.failures === item.requests}
            pathRef={paths.ref(laneKey(key))}
          />
        ))}
        {targets.map(({ key, item, phase }) => (
          <Lane
            key={`out:${key}`}
            phase={phase}
            delayMs={0}
            targetId={key}
            isFailing={item.failures === item.attempts}
            isResting={Boolean(item.cooldown)}
            pathRef={paths.ref(edgeKey(key))}
          />
        ))}
        <g ref={layerRef} data-testid="routing-packets" />
      </svg>

      <div className={clsx(styles['map-column'], styles['column-models'])} role="list" aria-label={t('routing.models')}>
        <ColumnHead label={t('routing.models')} containerRef={containerRef} onMotion={notifyRowMotion} />
        {ghosts.map(({ key, phase }) => (
          <GhostNode
            key={key}
            side={-1}
            phase={phase}
            containerRef={containerRef}
            onMotion={notifyRowMotion}
            tileRef={modelTiles.ref(GHOST)}
            title={t('routing.empty')}
            hint={t('routing.empty_hint')}
            testId="routing-empty"
          />
        ))}
        {models.map(({ key, item, phase }) => (
          <ModelNode
            key={key}
            row={item}
            phase={phase}
            delayMs={0}
            containerRef={containerRef}
            onMotion={notifyRowMotion}
            tileRef={modelTiles.ref(key)}
            washRef={washes.ref(key)}
            haloRef={halos.ref(key)}
          />
        ))}
        {model.hiddenModels > 0 && (
          <div className={styles['column-more']}>{t('routing.more_models', { count: model.hiddenModels })}</div>
        )}
      </div>

      <div className={styles['map-center']}>
        <div ref={hubRef} className={styles['hub']} data-testid="routing-gateway">
          <svg className={styles['orbits']} viewBox={`0 0 ${ORBIT_BOX} ${ORBIT_BOX}`} aria-hidden="true">
            <circle className={styles['orbit-outer']} cx={ORBIT_BOX / 2} cy={ORBIT_BOX / 2} r={ORBIT_BOX / 2 - 1} />
            <circle className={styles['orbit-inner']} cx={ORBIT_BOX / 2} cy={ORBIT_BOX / 2} r={ORBIT_BOX / 2 - 26} />
          </svg>
          <span className={styles['hub-glow']} aria-hidden="true" />
          <span ref={gatewayRef} className={clsx(styles['tile'], styles['gateway'])} data-route-hub="" role="img" aria-label={t('routing.gateway')}>
            <span ref={halos.ref(GATEWAY_NODE)} className={styles['halo']} aria-hidden="true" />
            <span ref={washes.ref(GATEWAY_NODE)} className={styles['wash']} aria-hidden="true" />
            <BrandArtwork shape="mark" height={30} />
          </span>
        </div>
      </div>

      <div className={clsx(styles['map-column'], styles['column-targets'])} role="list" aria-label={t('routing.credentials')}>
        <ColumnHead label={t('routing.credentials')} containerRef={containerRef} onMotion={notifyRowMotion} />
        {ghosts.map(({ key, phase }) => (
          <GhostNode
            key={key}
            side={1}
            phase={phase}
            containerRef={containerRef}
            onMotion={notifyRowMotion}
            tileRef={targetTiles.ref(GHOST)}
            title={t('routing.empty_credentials')}
            hint={t('routing.empty_credentials_hint')}
          />
        ))}
        {targets.map(({ key, item, phase }) => (
          <TargetNode
            key={key}
            target={item}
            phase={phase}
            delayMs={0}
            containerRef={containerRef}
            onMotion={notifyRowMotion}
            tileRef={targetTiles.ref(key)}
            nowMs={nowMs}
            skewMs={skewMs}
            sources={sources}
            washRef={washes.ref(key)}
            haloRef={halos.ref(key)}
          />
        ))}
        {model.hiddenTargets > 0 && (
          <div className={styles['column-more']}>{t('routing.more_credentials', { count: model.hiddenTargets })}</div>
        )}
      </div>
    </div>
  );
});

interface ColumnHeadProps {
  label: string;
  containerRef: React.RefObject<HTMLElement | null>;
  onMotion: () => void;
}

function ColumnHead({ label, containerRef, onMotion }: ColumnHeadProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFlip(ref, containerRef, onMotion);
  return <div ref={ref} className={styles['column-head']}>{label}</div>;
}

interface LaneProps {
  phase: PresencePhase;
  delayMs: number;
  modelId?: string;
  targetId?: string;
  isFailing: boolean;
  isResting?: boolean;
  pathRef: (element: SVGPathElement | null) => void;
}

function Lane({ phase, delayMs, modelId, targetId, isFailing, isResting = false, pathRef }: LaneProps) {
  const groupRef = React.useRef<SVGGElement>(null);
  useLaneMotion(groupRef, phase, delayMs);
  return (
    <g ref={groupRef} data-testid="routing-lane">
      <path
        ref={pathRef}
        data-model={modelId}
        data-target={targetId}
        className={clsx(styles['edge'], isFailing && styles['edge-failing'], isResting && styles['edge-resting'])}
      />
    </g>
  );
}

function GhostLane({
  phase,
  modelId,
  targetId,
  pathRef,
}: {
  phase: PresencePhase;
  modelId?: string;
  targetId?: string;
  pathRef: (element: SVGPathElement | null) => void;
}) {
  const groupRef = React.useRef<SVGGElement>(null);
  useLaneMotion(groupRef, phase, 0);
  return (
    <g ref={groupRef}>
      <path ref={pathRef} data-model={modelId} data-target={targetId} className={clsx(styles['edge'], styles['edge-ghost'])} />
    </g>
  );
}

interface GhostNodeProps {
  side: 1 | -1;
  phase: PresencePhase;
  containerRef: React.RefObject<HTMLElement | null>;
  onMotion: () => void;
  tileRef: (element: HTMLElement | null) => void;
  title: string;
  hint: string;
  testId?: string;
}

function GhostNode({ side, phase, containerRef, onMotion, tileRef, title, hint, testId }: GhostNodeProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(side, containerRef.current), delayMs: 0, onMotion });
  const tile = (
    <span
      ref={tileRef}
      className={clsx(styles['tile'], styles['tile-ghost'])}
      data-route-model={side < 0 ? GHOST : undefined}
      data-route-target={side > 0 ? GHOST : undefined}
      aria-hidden="true"
    />
  );
  return (
    <div ref={ref} className={clsx(styles['node'], styles['node-ghost'])} data-testid={testId}>
      {side > 0 && tile}
      <span className={styles['row-text']}>
        <span className={styles['row-name']}>{title}</span>
        <span className={styles['row-meta']}>{hint}</span>
      </span>
      {side < 0 && tile}
    </div>
  );
}

interface TileLightProps {
  washRef: (element: HTMLElement | null) => void;
  haloRef: (element: HTMLElement | null) => void;
}

function TileLight({ washRef, haloRef }: TileLightProps) {
  return (
    <>
      <span ref={haloRef} className={styles['halo']} aria-hidden="true" />
      <span ref={washRef} className={styles['wash']} aria-hidden="true" />
    </>
  );
}

interface ModelNodeProps extends TileLightProps {
  row: RoutingModelRow;
  phase: PresencePhase;
  delayMs: number;
  containerRef: React.RefObject<HTMLElement | null>;
  onMotion: () => void;
  tileRef: (element: HTMLElement | null) => void;
}

function ModelNode({ row, phase, delayMs, containerRef, onMotion, tileRef, washRef, haloRef }: ModelNodeProps) {
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(-1, containerRef.current), delayMs, onMotion });
  return (
    <div
      ref={ref}
      role="listitem"
      className={styles['node']}
      data-testid="routing-model"
      data-phase={phase}
    >
      <span className={styles['row-text']}>
        <span className={styles['row-name']} title={row.name}>{row.name}</span>
        <span className={styles['row-meta']}>
          {t('routing.requests_count', { count: row.requests.toLocaleString() })}
          {row.failures > 0 && <span className={styles['row-failures']}> · {t('routing.failed_count', { count: row.failures })}</span>}
        </span>
      </span>
      <span ref={tileRef} className={styles['tile']} data-route-model={row.id}>
        <TileLight washRef={washRef} haloRef={haloRef} />
        <ModelMark model={row.name} size={20} />
      </span>
    </div>
  );
}

interface TargetNodeProps extends TileLightProps {
  target: RoutingTarget;
  phase: PresencePhase;
  delayMs: number;
  containerRef: React.RefObject<HTMLElement | null>;
  onMotion: () => void;
  tileRef: (element: HTMLElement | null) => void;
  nowMs: number;
  skewMs: number;
  sources: IdentitySources;
}

function TargetNode({ target, phase, delayMs, containerRef, onMotion, tileRef, nowMs, skewMs, sources, washRef, haloRef }: TargetNodeProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(1, containerRef.current), delayMs, onMotion });
  const identity = targetIdentity(target.sample, sources);
  return (
    <div
      ref={ref}
      role="listitem"
      className={clsx(styles['node'], target.cooldown && styles['node-resting'])}
      data-testid="routing-target"
      data-phase={phase}
    >
      <span ref={tileRef} className={styles['tile']} data-route-target={target.id}>
        <TileLight washRef={washRef} haloRef={haloRef} />
        <ProviderBrandIcon mark={identity} size={20} />
      </span>
      <span className={styles['row-text']}>
        <span className={styles['row-title']}>
          <span className={styles['row-name']}>{identity.title}</span>
          {target.cooldown && <CooldownLabel cooldown={target.cooldown} nowMs={nowMs} skewMs={skewMs} />}
        </span>
        <span className={styles['row-meta']} title={identity.credential || undefined}>
          {identity.credential || target.sample.model || '—'}
        </span>
      </span>
    </div>
  );
}
