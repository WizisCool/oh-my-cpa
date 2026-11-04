import React from 'react';
import clsx from 'clsx';
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion';
import { isMotionReduced } from '../../../utils/motionPreference';

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

/** How far a row drifts as it enters or leaves the map. */
const PRESENCE_SHIFT_PX = 12;
/** A row arrives from, and leaves towards, its own edge of the map. */
const awayFrom = (side: 1 | -1) => `translateX(${side * PRESENCE_SHIFT_PX}px)`;
/** The rows of the map's first paint arrive one after another, this far apart. */
const ENTER_STAGGER_MS = 40;
/** How long lanes are redrawn every frame after rows enter, leave or slide. */
const TRACKING_MS = MOTION_ROUTE_ENTER.duration + MAX_DRAWN_MODELS * ENTER_STAGGER_MS + 80;
/** Past this many rows in a column the rows tighten to a list. */
const DENSE_ROWS = 4;
/** The key of the placeholder rows an empty minute draws, which no model or credential id can take. */
const GHOST = '\u0000ghost';
/** The orbits drawn around the gateway tile, in the drawing's own pixels. */
const ORBIT_BOX = 184;

/** A lane: level where it leaves a tile and where it reaches the next, bending between. */
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

/** A lane's motion: it fades in once its row has begun to arrive, and out as the row leaves. */
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
  /** Changes on every read that brought arrivals, so a repeat of the same routes still plays. */
  id: number;
  routes: RoutingRoute[];
}

export interface RoutingMapProps {
  model: RoutingModel;
  nowMs: number;
  sources: IdentitySources;
  arrivals: RoutingArrivals;
}

const modelKey = (row: RoutingModelRow) => row.id;
const targetKey = (target: RoutingTarget) => target.id;
const ghostKey = (key: string) => key;

/**
 * The routing map: the models called in the last minute on the left, the
 * gateway, and the credentials and providers that answered on the right - the
 * sign-in showcase's drawing, fed by real traffic. Every row faces the gateway
 * with a tile, and its label reads outward, so the lanes run tile to tile. A
 * model has one lane into the gateway and a credential one lane out of it, so
 * the drawing stays legible with seven of each; which model went where is what
 * the travelling requests show.
 *
 * Rows sit in ordinary layout and the lanes are drawn over them from measured
 * anchors, so rows wrap, localise and resize like any list and the drawing
 * follows. While a row enters, leaves or slides, the lanes are re-drawn every
 * frame from the rows' transformed boxes, so a lane never detaches from the row
 * it joins. The drawing is written to the DOM directly rather than through
 * React state, which would re-render the whole map sixty times a second.
 */
export function RoutingMap({ model, nowMs, sources, arrivals }: RoutingMapProps) {
  const t = useT();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const layerRef = React.useRef<SVGGElement>(null);
  const hubRef = React.useRef<HTMLDivElement>(null);
  const gatewayRef = React.useRef<HTMLSpanElement>(null);
  const paths = useRegistry<SVGPathElement>();
  const washes = useRegistry<HTMLElement>();
  const halos = useRegistry<HTMLElement>();

  const isReducedMotion = usePrefersReducedMotion();
  const exitMs = isReducedMotion ? 0 : MOTION_ROUTE_EXIT.duration;
  const isEmpty = model.models.length === 0;
  const models = usePresence(model.models, modelKey, exitMs);
  const targets = usePresence(model.targets, targetKey, exitMs);
  // An empty minute keeps the map's shape with a placeholder row on each side, which
  // leaves as the first request's rows arrive rather than being swapped out.
  const ghostItems = React.useMemo(() => (isEmpty ? [GHOST] : []), [isEmpty]);
  const ghosts = usePresence(ghostItems, ghostKey, exitMs);

  const draw = React.useCallback(() => {
    const container = containerRef.current;
    const gateway = gatewayRef.current;
    if (!container || !gateway) return;
    const box = container.getBoundingClientRect();
    const anchorsOf = (attribute: 'routeModel' | 'routeTarget', selector: string, edge: 'left' | 'right') => {
      const anchors = new Map<string, Point>();
      container.querySelectorAll<HTMLElement>(selector).forEach((element) => {
        const rect = element.getBoundingClientRect();
        anchors.set(element.dataset[attribute] as string, { x: rect[edge] - box.left, y: rect.top + rect.height / 2 - box.top });
      });
      return anchors;
    };
    const modelAnchors = anchorsOf('routeModel', '[data-route-model]', 'right');
    const targetAnchors = anchorsOf('routeTarget', '[data-route-target]', 'left');
    const node = gateway.getBoundingClientRect();
    // Every lane meets the gateway at the middle of its side, as the sign-in drawing's do.
    const middle = node.top + node.height / 2 - box.top;
    container.querySelectorAll<SVGPathElement>('path[data-model], path[data-target]').forEach((path) => {
      const { model: modelId, target: targetId } = path.dataset;
      let d = '';
      if (modelId) {
        const from = modelAnchors.get(modelId);
        if (from) d = curve(from, { x: node.left - box.left, y: middle });
      } else if (targetId) {
        const to = targetAnchors.get(targetId);
        if (to) d = curve({ x: node.right - box.left, y: middle }, to);
      }
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    });
  }, []);

  // Drawn after every render (a count can widen a row without resizing the map),
  // and on every frame while rows are entering, leaving or sliding.
  React.useLayoutEffect(draw);
  const presenceSignature = [models, targets, ghosts]
    .map((list) => list.map((entry) => `${entry.key}:${entry.phase}`).join(','))
    .join('|');
  React.useLayoutEffect(() => {
    if (isReducedMotion) return;
    const until = performance.now() + TRACKING_MS;
    let frame = 0;
    const tick = () => {
      draw();
      if (performance.now() < until) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [presenceSignature, draw, isReducedMotion]);
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  // Created in the effect rather than memoised, so a remount (StrictMode runs one in
  // development) gets a live player instead of the one its cleanup disposed.
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
  // The map's first rows arrive one after another; later arrivals come as they happen.
  const isFirstPaintRef = React.useRef(true);
  React.useEffect(() => { isFirstPaintRef.current = false; }, []);
  const enterDelay = (index: number) => (isFirstPaintRef.current ? index * ENTER_STAGGER_MS : 0);

  return (
    <div ref={containerRef} className={clsx(styles['map'], isDense && styles['map-dense'], isEmpty && styles['map-idle'])} data-testid="routing-map">
      <svg className={styles['map-edges']} aria-hidden="true">
        {ghosts.map(({ key, phase }) => (
          <React.Fragment key={key}>
            <GhostLane phase={phase} modelId={GHOST} />
            <GhostLane phase={phase} targetId={GHOST} />
          </React.Fragment>
        ))}
        {models.map(({ key, item, phase }, index) => (
          <Lane
            key={`in:${key}`}
            phase={phase}
            delayMs={enterDelay(index)}
            modelId={key}
            isFailing={item.failures === item.requests}
            pathRef={paths.ref(laneKey(key))}
          />
        ))}
        {targets.map(({ key, item, phase }, index) => (
          <Lane
            key={`out:${key}`}
            phase={phase}
            delayMs={enterDelay(index)}
            targetId={key}
            isFailing={item.failures === item.attempts}
            isResting={Boolean(item.cooldown)}
            pathRef={paths.ref(edgeKey(key))}
          />
        ))}
        <g ref={layerRef} data-testid="routing-packets" />
      </svg>

      <div className={clsx(styles['map-column'], styles['column-models'])} role="list" aria-label={t('routing.models')}>
        <ColumnHead label={t('routing.models')} containerRef={containerRef} />
        {ghosts.map(({ key, phase }) => (
          <GhostNode key={key} side={-1} phase={phase} containerRef={containerRef}
            title={t('routing.empty')} hint={t('routing.empty_hint')} testId="routing-empty" />
        ))}
        {models.map(({ key, item, phase }, index) => (
          <ModelNode
            key={key}
            row={item}
            phase={phase}
            delayMs={enterDelay(index)}
            containerRef={containerRef}
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
          {/* The orbits and the glow light the page around the tile without tinting it. */}
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
        <ColumnHead label={t('routing.credentials')} containerRef={containerRef} />
        {ghosts.map(({ key, phase }) => (
          <GhostNode key={key} side={1} phase={phase} containerRef={containerRef}
            title={t('routing.empty_credentials')} hint={t('routing.empty_credentials_hint')} />
        ))}
        {targets.map(({ key, item, phase }, index) => (
          <TargetNode
            key={key}
            target={item}
            phase={phase}
            delayMs={enterDelay(index)}
            containerRef={containerRef}
            nowMs={nowMs}
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
}

interface ColumnHeadProps {
  label: string;
  containerRef: React.RefObject<HTMLElement | null>;
}

/** A column's heading slides with its rows when the column re-centres. */
function ColumnHead({ label, containerRef }: ColumnHeadProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFlip(ref, containerRef);
  return <div ref={ref} className={styles['column-head']}>{label}</div>;
}

interface LaneProps {
  phase: PresencePhase;
  delayMs: number;
  /** A model's lane into the gateway, or a credential's lane out of it. */
  modelId?: string;
  targetId?: string;
  isFailing: boolean;
  /** A credential inside its cooldown: the lane rests, and says so with a dash rather than a hue. */
  isResting?: boolean;
  pathRef: (element: SVGPathElement | null) => void;
}

/** One lane: a hairline track the requests travel along. */
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

/** The dashed lane an empty minute draws between a placeholder row and the gateway. */
function GhostLane({ phase, modelId, targetId }: { phase: PresencePhase; modelId?: string; targetId?: string }) {
  const groupRef = React.useRef<SVGGElement>(null);
  useLaneMotion(groupRef, phase, 0);
  return (
    <g ref={groupRef}>
      <path data-model={modelId} data-target={targetId} className={clsx(styles['edge'], styles['edge-ghost'])} />
    </g>
  );
}

interface GhostNodeProps {
  side: 1 | -1;
  phase: PresencePhase;
  containerRef: React.RefObject<HTMLElement | null>;
  title: string;
  hint: string;
  testId?: string;
}

/** A placeholder row: where the models or the credentials of the minute will be. */
function GhostNode({ side, phase, containerRef, title, hint, testId }: GhostNodeProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(side), delayMs: 0 });
  // The tile faces the gateway on either side, so a model's placeholder reads label first.
  const tile = (
    <span
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

/** The light routingPackets.ts plays on a tile as a request docks in it. */
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
}

function ModelNode({ row, phase, delayMs, containerRef, washRef, haloRef }: ModelNodeProps) {
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(-1), delayMs });
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
      <span className={styles['tile']} data-route-model={row.id}>
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
  nowMs: number;
  sources: IdentitySources;
}

function TargetNode({ target, phase, delayMs, containerRef, nowMs, sources, washRef, haloRef }: TargetNodeProps) {
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(1), delayMs });
  const identity = targetIdentity(target.sample, sources);
  return (
    <div
      ref={ref}
      role="listitem"
      className={clsx(styles['node'], target.cooldown && styles['node-resting'])}
      data-testid="routing-target"
      data-phase={phase}
    >
      <span className={styles['tile']} data-route-target={target.id}>
        <TileLight washRef={washRef} haloRef={haloRef} />
        <ProviderBrandIcon mark={identity} size={20} />
      </span>
      {/* Two lines, as on a model's row, so both sides of the gateway weigh the same: who answered,
          then which credential. Only trouble earns a state: a rest CPA reported, or refusals. */}
      <span className={styles['row-text']}>
        <span className={styles['row-title']}>
          <span className={styles['row-name']}>{identity.title}</span>
          {target.cooldown && <CooldownLabel cooldown={target.cooldown} nowMs={nowMs} />}
        </span>
        <span className={styles['row-meta']} title={identity.credential || undefined}>
          {identity.credential || target.sample.model || '—'}
          {target.failures > 0 && <span className={styles['row-failures']}> · {t('routing.failed_count', { count: target.failures })}</span>}
        </span>
      </span>
    </div>
  );
}
