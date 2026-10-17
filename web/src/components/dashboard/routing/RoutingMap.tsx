import React from 'react';
import clsx from 'clsx';

import { BrandArtwork } from '../../common/BrandArtwork';
import { ProviderBrandIcon } from '../../LobeIcon';
import { ModelMark } from '../../ModelMark';
import { StatusLabel } from '../../common/StatusLabel';
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
import { formatLatency, targetIdentity, type IdentitySources } from './routingIdentity';
import { CooldownLabel } from './CooldownLabel';
import { usePresence } from './usePresence';
import { useFlip, useRowMotion } from './rowMotion';
import styles from './RoutingPanel.module.css';

interface Point { x: number; y: number }

/** Vertical spacing of the lanes where they meet the gateway. */
const FAN_GAP = 8;
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

function curve(from: Point, to: Point): string {
  const dx = (to.x - from.x) / 2;
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
function useLaneMotion(ref: React.RefObject<SVGGElement | null>, phase: PresencePhase, delayMs: number, isReducedMotion: boolean) {
  React.useLayoutEffect(() => {
    if (phase !== 'entering' || isReducedMotion) return;
    ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: MOTION_ROUTE_PRESENCE.duration, easing: MOTION_ROUTE_PRESENCE.easing,
      delay: delayMs + MOTION_ROUTE_ENTER.duration / 3, fill: 'backwards',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useLayoutEffect(() => {
    if (phase !== 'exiting' || isReducedMotion) return;
    const animation = ref.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: MOTION_ROUTE_EXIT.duration, easing: MOTION_ROUTE_EXIT.easing, fill: 'forwards',
    });
    return () => animation?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isReducedMotion]);
}

export interface RoutingArrivals {
  /** Changes on every read that brought arrivals, so a repeat of the same routes still plays. */
  id: number;
  routes: RoutingRoute[];
}

export interface RoutingMapProps {
  model: RoutingModel;
  colorOf: (modelId: string) => string;
  nowMs: number;
  strategy?: string;
  sources: IdentitySources;
  arrivals: RoutingArrivals;
  isReducedMotion: boolean;
}

const modelKey = (row: RoutingModelRow) => row.id;
const targetKey = (target: RoutingTarget) => target.id;
const ghostKey = (key: string) => key;

/**
 * The routing map: the models called in the last minute on the left, the
 * gateway, and the credentials and providers that answered on the right. A
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
export function RoutingMap({ model, colorOf, nowMs, strategy, sources, arrivals, isReducedMotion }: RoutingMapProps) {
  const t = useT();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const layerRef = React.useRef<HTMLDivElement>(null);
  const gatewayRef = React.useRef<HTMLDivElement>(null);
  const paths = useRegistry<SVGPathElement>();
  const flows = useRegistry<SVGPathElement>();
  const washes = useRegistry<HTMLElement>();
  const halos = useRegistry<HTMLElement>();
  const rings = useRegistry<HTMLElement>();

  const isEmpty = model.models.length === 0;
  const exitMs = isReducedMotion ? 0 : MOTION_ROUTE_EXIT.duration;
  const models = usePresence(model.models, modelKey, exitMs);
  const targets = usePresence(model.targets, targetKey, exitMs);
  // An empty minute keeps the map's shape with a placeholder row on each side, which
  // leaves as the first request's rows arrive rather than being swapped out.
  const ghostItems = React.useMemo(() => (isEmpty ? [GHOST] : []), [isEmpty]);
  const ghosts = usePresence(ghostItems, ghostKey, exitMs);

  // A leaving row keeps the colour it had; the panel may already have given its slot away.
  const colorsRef = React.useRef(new Map<string, string>());
  const colorFor = (modelId: string) => {
    const color = model.models.some((row) => row.id === modelId) ? colorOf(modelId) : colorsRef.current.get(modelId) ?? colorOf(modelId);
    colorsRef.current.set(modelId, color);
    return color;
  };

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
    const middle = node.top + node.height / 2 - box.top;
    const limit = Math.max(0, node.height / 2 - 18);
    // The lanes meet the gateway side by side, in their rows' order, so none crosses another there.
    const fan = (order: string[], id: string) => {
      const index = order.indexOf(id);
      if (index < 0) return 0;
      return Math.max(-limit, Math.min(limit, (index - (order.length - 1) / 2) * FAN_GAP));
    };
    const modelOrder = [...modelAnchors.keys()];
    const targetOrder = [...targetAnchors.keys()];
    // The gateway's rails span exactly the fan the lanes dock into on each side.
    const extentOf = (count: number) => Math.min(limit, (Math.max(1, count) - 1) / 2 * FAN_GAP);
    gateway.style.setProperty('--rail-in', `${extentOf(modelOrder.length)}px`);
    gateway.style.setProperty('--rail-out', `${extentOf(targetOrder.length)}px`);
    container.querySelectorAll<SVGPathElement>('path[data-model], path[data-target]').forEach((path) => {
      const { model: modelId, target: targetId } = path.dataset;
      let d = '';
      if (modelId) {
        const from = modelAnchors.get(modelId);
        if (from) d = curve(from, { x: node.left - box.left, y: middle + fan(modelOrder, modelId) });
      } else if (targetId) {
        const to = targetAnchors.get(targetId);
        if (to) d = curve({ x: node.right - box.left, y: middle + fan(targetOrder, targetId) }, to);
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

  const colorRef = React.useRef(colorFor);
  colorRef.current = colorFor;
  // Created in the effect rather than memoised, so a remount (StrictMode runs one in
  // development) gets a live player instead of the one its cleanup disposed.
  const playerRef = React.useRef<ReturnType<typeof createPacketPlayer> | undefined>(undefined);
  React.useEffect(() => {
    const player = createPacketPlayer({
      layer: () => layerRef.current,
      path: paths.get,
      flow: flows.get,
      wash: washes.get,
      halo: halos.get,
      ring: rings.get,
      gateway: () => gatewayRef.current,
      color: (modelId) => colorRef.current(modelId),
      classNames: {
        packet: styles['packet'],
        packetDot: styles['packet-dot'],
        flowOn: styles['edge-flow-on'],
        flowBack: styles['edge-flow-back'],
        gatewayBusy: styles['gateway-busy'],
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
  }, [paths, flows, washes, halos, rings]);
  React.useEffect(() => {
    if (isReducedMotion || arrivals.routes.length === 0) return;
    playerRef.current?.play(arrivals.routes);
  }, [arrivals, isReducedMotion]);

  const maxModel = Math.max(1, ...model.models.map((row) => row.requests));
  const maxTarget = Math.max(1, ...model.targets.map((target) => target.attempts));
  const strokeFor = (ratio: number) => 1.25 + 1.75 * Math.sqrt(ratio);
  const latestTargetId = model.targets.reduce<RoutingTarget | undefined>(
    (latest, target) => (!latest || target.lastAtMs > latest.lastAtMs ? target : latest), undefined,
  )?.id;
  const isDense = Math.max(models.length, targets.length) > DENSE_ROWS;
  // The map's first rows arrive one after another; later arrivals come as they happen.
  const isFirstPaintRef = React.useRef(true);
  React.useEffect(() => { isFirstPaintRef.current = false; }, []);
  const enterDelay = (index: number) => (isFirstPaintRef.current ? index * ENTER_STAGGER_MS : 0);

  return (
    <div ref={containerRef} className={clsx(styles['map'], isDense && styles['map-dense'])} data-testid="routing-map">
      <svg className={styles['map-edges']} aria-hidden="true">
        {ghosts.map(({ key, phase }) => (
          <React.Fragment key={key}>
            <GhostLane phase={phase} isReducedMotion={isReducedMotion} modelId={GHOST} />
            <GhostLane phase={phase} isReducedMotion={isReducedMotion} targetId={GHOST} />
          </React.Fragment>
        ))}
        {models.map(({ key, item, phase }, index) => (
          <Lane
            key={`in:${key}`}
            phase={phase}
            delayMs={enterDelay(index)}
            isReducedMotion={isReducedMotion}
            modelId={key}
            color={colorFor(key)}
            width={strokeFor(item.requests / maxModel)}
            isFailing={item.failures === item.requests}
            pathRef={paths.ref(laneKey(key))}
            flowRef={flows.ref(laneKey(key))}
          />
        ))}
        {targets.map(({ key, item, phase }, index) => (
          <Lane
            key={`out:${key}`}
            phase={phase}
            delayMs={enterDelay(index)}
            isReducedMotion={isReducedMotion}
            targetId={key}
            color={item.cooldown ? 'var(--warn)' : item.failures === item.attempts ? 'var(--danger)' : 'var(--fg-2)'}
            width={strokeFor(item.attempts / maxTarget)}
            isFailing={item.failures === item.attempts}
            pathRef={paths.ref(edgeKey(key))}
            flowRef={flows.ref(edgeKey(key))}
          />
        ))}
      </svg>

      <div className={styles['map-column']} role="list" aria-label={t('routing.models')}>
        <ColumnHead label={t('routing.models')} count={model.models.length} containerRef={containerRef} isReducedMotion={isReducedMotion} />
        {ghosts.map(({ key, phase }) => (
          <GhostNode key={key} side={-1} phase={phase} containerRef={containerRef} isReducedMotion={isReducedMotion}
            title={t('routing.empty')} hint={t('routing.empty_hint')} testId="routing-empty" />
        ))}
        {models.map(({ key, item, phase }, index) => (
          <ModelNode
            key={key}
            row={item}
            phase={phase}
            delayMs={enterDelay(index)}
            containerRef={containerRef}
            color={colorFor(key)}
            isReducedMotion={isReducedMotion}
            washRef={washes.ref(key)}
            haloRef={halos.ref(key)}
            ringRef={rings.ref(key)}
          />
        ))}
        {model.hiddenModels > 0 && (
          <div className={styles['column-more']}>{t('routing.more_models', { count: model.hiddenModels })}</div>
        )}
      </div>

      <div className={styles['map-center']}>
        <div
          ref={gatewayRef}
          className={clsx(styles['gateway'], isEmpty && styles['gateway-idle'])}
          data-testid="routing-gateway"
        >
          <span ref={halos.ref(GATEWAY_NODE)} className={styles['halo']} aria-hidden="true" />
          <span ref={washes.ref(GATEWAY_NODE)} className={clsx(styles['wash'], styles['wash-centre'])} aria-hidden="true" />
          <span className={clsx(styles['gateway-rail'], styles['gateway-rail-in'])} aria-hidden="true" />
          <span className={clsx(styles['gateway-rail'], styles['gateway-rail-out'])} aria-hidden="true" />
          <span className={styles['gateway-mark']} aria-hidden="true"><BrandArtwork shape="mark" height={22} /></span>
          <span className={styles['gateway-name']}>{t('routing.gateway')}</span>
          {strategy && <span className={styles['gateway-strategy']}>{strategy}</span>}
          <span className={styles['gateway-meta']}>
            {isEmpty ? t('routing.waiting') : t('routing.attempts_count', { count: model.attempts.toLocaleString() })}
          </span>
        </div>
      </div>

      <div className={styles['map-column']} role="list" aria-label={t('routing.credentials')}>
        <ColumnHead label={t('routing.credentials')} count={model.targets.length} containerRef={containerRef} isReducedMotion={isReducedMotion} />
        {ghosts.map(({ key, phase }) => (
          <GhostNode key={key} side={1} phase={phase} containerRef={containerRef} isReducedMotion={isReducedMotion}
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
            isLatest={key === latestTargetId}
            isReducedMotion={isReducedMotion}
            sources={sources}
            washRef={washes.ref(key)}
            haloRef={halos.ref(key)}
            ringRef={rings.ref(key)}
          />
        ))}
        {model.hiddenTargets > 0 && (
          <div className={styles['column-more']}>{t('routing.more_credentials', { count: model.hiddenTargets })}</div>
        )}
      </div>

      <div ref={layerRef} className={styles['packet-layer']} aria-hidden="true" data-testid="routing-packets" />
    </div>
  );
}

interface ColumnHeadProps {
  label: string;
  count: number;
  containerRef: React.RefObject<HTMLElement | null>;
  isReducedMotion: boolean;
}

/** A column's heading slides with its rows when the column re-centres. */
function ColumnHead({ label, count, containerRef, isReducedMotion }: ColumnHeadProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFlip(ref, containerRef, isReducedMotion);
  return (
    <div ref={ref} className={styles['column-head']}>
      <span>{label}</span>
      <span className={styles['column-count']}>{count}</span>
    </div>
  );
}

interface LaneProps {
  phase: PresencePhase;
  isReducedMotion: boolean;
  delayMs: number;
  /** A model's lane into the gateway, or a credential's lane out of it. */
  modelId?: string;
  targetId?: string;
  color: string;
  width: number;
  isFailing: boolean;
  pathRef: (element: SVGPathElement | null) => void;
  flowRef: (element: SVGPathElement | null) => void;
}

/** One lane: its resting stroke, and the dashes that flow over it while a request travels it. */
function Lane({ phase, isReducedMotion, delayMs, modelId, targetId, color, width, isFailing, pathRef, flowRef }: LaneProps) {
  const groupRef = React.useRef<SVGGElement>(null);
  useLaneMotion(groupRef, phase, delayMs, isReducedMotion);
  return (
    <g ref={groupRef} data-testid="routing-lane">
      <path
        ref={pathRef}
        data-model={modelId}
        data-target={targetId}
        className={clsx(styles['edge'], isFailing && styles['edge-failing'])}
        style={{ stroke: color, strokeWidth: width }}
      />
      <path ref={flowRef} data-model={modelId} data-target={targetId} className={styles['edge-flow']} style={{ strokeWidth: width + 1.5 }} />
    </g>
  );
}

/** The dashed lane an empty minute draws between a placeholder row and the gateway. */
function GhostLane({ phase, isReducedMotion, modelId, targetId }: { phase: PresencePhase; isReducedMotion: boolean; modelId?: string; targetId?: string }) {
  const groupRef = React.useRef<SVGGElement>(null);
  useLaneMotion(groupRef, phase, 0, isReducedMotion);
  return (
    <g ref={groupRef}>
      <path data-model={modelId} data-target={targetId} className={clsx(styles['edge'], styles['edge-ghost'])} style={{ strokeWidth: 1.25 }} />
    </g>
  );
}

interface GhostNodeProps {
  side: 1 | -1;
  phase: PresencePhase;
  containerRef: React.RefObject<HTMLElement | null>;
  isReducedMotion: boolean;
  title: string;
  hint: string;
  testId?: string;
}

/** A placeholder row: where the models or the credentials of the minute will be. */
function GhostNode({ side, phase, containerRef, isReducedMotion, title, hint, testId }: GhostNodeProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(side), delayMs: 0, isReducedMotion });
  return (
    <div
      ref={ref}
      className={clsx(styles['node'], styles['node-ghost'])}
      data-route-model={side < 0 ? GHOST : undefined}
      data-route-target={side > 0 ? GHOST : undefined}
      data-testid={testId}
    >
      <span className={clsx(styles['port'], styles['port-ghost'], side < 0 ? styles['port-out'] : styles['port-in'])} aria-hidden="true" />
      <span className={styles['ghost-text']}>
        <span className={styles['row-name']}>{title}</span>
        <span className={styles['ghost-hint']}>{hint}</span>
      </span>
    </div>
  );
}

interface ModelNodeProps {
  row: RoutingModelRow;
  phase: PresencePhase;
  delayMs: number;
  containerRef: React.RefObject<HTMLElement | null>;
  color: string;
  isReducedMotion: boolean;
  washRef: (element: HTMLElement | null) => void;
  haloRef: (element: HTMLElement | null) => void;
  ringRef: (element: HTMLElement | null) => void;
}

function ModelNode({ row, phase, delayMs, containerRef, color, isReducedMotion, washRef, haloRef, ringRef }: ModelNodeProps) {
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(-1), delayMs, isReducedMotion });
  return (
    <div
      ref={ref}
      role="listitem"
      className={styles['node']}
      data-route-model={row.id}
      data-testid="routing-model"
      data-phase={phase}
      style={{ '--route-color': color } as React.CSSProperties}
    >
      <span ref={haloRef} className={styles['halo']} aria-hidden="true" />
      <span ref={washRef} className={clsx(styles['wash'], styles['wash-right'])} aria-hidden="true" />
      <span className={styles['node-mark']} aria-hidden="true"><ModelMark model={row.name} size={18} /></span>
      <span className={styles['row-text']}>
        <span className={styles['row-name']} title={row.name}>{row.name}</span>
        <span className={styles['row-meta']}>
          {t('routing.requests_count', { count: row.requests.toLocaleString() })} · {formatLatency(row.latencyMs)}
          {row.failures > 0 && <span className={styles['row-failures']}> · {t('routing.failed_count', { count: row.failures })}</span>}
        </span>
      </span>
      <span className={clsx(styles['port'], styles['port-out'])} aria-hidden="true">
        <span ref={ringRef} className={styles['ring']} />
      </span>
    </div>
  );
}

interface TargetNodeProps {
  target: RoutingTarget;
  phase: PresencePhase;
  delayMs: number;
  containerRef: React.RefObject<HTMLElement | null>;
  nowMs: number;
  isLatest: boolean;
  isReducedMotion: boolean;
  sources: IdentitySources;
  washRef: (element: HTMLElement | null) => void;
  haloRef: (element: HTMLElement | null) => void;
  ringRef: (element: HTMLElement | null) => void;
}

function TargetNode({ target, phase, delayMs, containerRef, nowMs, isLatest, isReducedMotion, sources, washRef, haloRef, ringRef }: TargetNodeProps) {
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  useRowMotion(ref, containerRef, { phase, away: awayFrom(1), delayMs, isReducedMotion });
  const identity = targetIdentity(target.sample, sources);
  return (
    <div
      ref={ref}
      role="listitem"
      className={clsx(styles['node'], target.cooldown && styles['node-resting'])}
      data-route-target={target.id}
      data-testid="routing-target"
      data-phase={phase}
      style={{ '--route-color': target.cooldown ? 'var(--warn)' : 'var(--accent)' } as React.CSSProperties}
    >
      <span ref={haloRef} className={styles['halo']} aria-hidden="true" />
      <span ref={washRef} className={clsx(styles['wash'], styles['wash-left'])} aria-hidden="true" />
      <span className={clsx(styles['port'], styles['port-in'])} aria-hidden="true">
        <span ref={ringRef} className={styles['ring']} />
      </span>
      <span className={styles['node-mark']} aria-hidden="true">
        <ProviderBrandIcon iconId={identity.iconId} logo={identity.logo} size={18} />
      </span>
      <span className={styles['row-text']}>
        <span className={styles['row-name']}>{identity.title}</span>
        <span className={styles['row-meta']} title={identity.credential || undefined}>{identity.credential || target.sample.model || '—'}</span>
      </span>
      <span className={styles['node-state']}>
        {target.cooldown ? (
          <CooldownLabel cooldown={target.cooldown} nowMs={nowMs} />
        ) : isLatest ? (
          <StatusLabel tone="accent">{t('routing.answered_last')}</StatusLabel>
        ) : (
          <span className={styles['row-meta']}>
            {t('routing.requests_count', { count: target.attempts.toLocaleString() })} · {formatLatency(target.latencyMs)}
          </span>
        )}
        {target.failures > 0 && (
          <span className={clsx(styles['node-figure'], styles['row-failures'])}>{t('routing.failed_count', { count: target.failures })}</span>
        )}
      </span>
    </div>
  );
}
