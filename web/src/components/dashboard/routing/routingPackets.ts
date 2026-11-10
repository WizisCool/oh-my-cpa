import { isMotionReduced, subscribeMotionPreference } from '../../../utils/motionPreference';

import { MOTION_ROUTE, MOTION_ROUTE_GLOW, MOTION_ROUTE_LAND } from '../../../theme/themeConfig';
import type { RoutingRoute } from '../../../types/usageRouting';

/**
 * The routing map's travelling requests: a short stroke of light leaves the
 * model, passes through the gateway to the credential CPA picked, waits there
 * while that credential answers, and comes back - the sign-in showcase's pulse,
 * driven by real traffic. Every request sets out in the map's one light, and
 * what comes back is the verdict - green for an answer, red for a refusal. The
 * lanes themselves stay neutral: the colour belongs to what travels them, never
 * to the connection.
 *
 * Performance invariants:
 * - Node glow interpolation tracks active keyframes in memory rather than calling
 *   `getComputedStyle(element).opacity`, avoiding synchronous style recalculation on packet dock.
 * - SVG lane lengths (`path.getTotalLength()`) and dasharray strings are cached per path `d`
 *   attribute so steady-state 60fps animation frames perform zero SVG geometry layout queries and
 *   zero redundant attribute/dasharray writes.
 */

/** At most this many requests replay from one read; the rest are already counted on the rows. */
export const MAX_REPLAYED_ROUTES = 8;
/** Requests on the map at once. A burst past it is skipped, never queued. */
export const MAX_LIVE_PACKETS = 16;
/** The gap between two requests of one read, so a burst reads as a sequence without lagging it. */
const ROUTE_STAGGER_MS = 70;
/** A hop from a model to the gateway, or back. */
const LANE_HOP_MS = Math.round(MOTION_ROUTE.duration * 0.85);
/** A hop from the gateway to a credential, or back. */
const EDGE_HOP_MS = MOTION_ROUTE.duration;
/** A refused request returns to the gateway quicker than an answer: nothing is carried back. */
const REFUSAL_HOP_MS = Math.round(MOTION_ROUTE.duration * 0.75);
/** How long a refusal shows at the credential before the request moves on. */
const REFUSAL_PAUSE_MS = 180;
/** The bright head of a travelling request, and the fainter tail it draws behind it, in pixels. */
const HEAD_PX = 18;
const TAIL_PX = 56;

export function holdFor(latencyMs: number): number {
  return Math.round(Math.min(480, Math.max(120, latencyMs / 20)));
}

export type PacketTone = 'request' | 'success' | 'failure';

export interface PacketStage {
  /** The SVG group travelling requests are drawn in; it shares the lanes' coordinates. */
  layer: () => SVGGElement | null;
  path: (key: string) => SVGPathElement | null;
  /** A tile's light: the wash across it and the edge that brightens. */
  wash: (key: string) => HTMLElement | null;
  halo: (key: string) => HTMLElement | null;
  /** The gateway node, marked busy while any request is on the map. */
  gateway: () => HTMLElement | null;
  classNames: {
    packet: string;
    packetHead: string;
    packetTail: string;
    gatewayBusy: string;
    washRequest: string;
    washSuccess: string;
    washFailure: string;
  };
}

export function laneKey(modelId: string): string {
  return `in:${modelId}`;
}

export function edgeKey(targetId: string): string {
  return `out:${targetId}`;
}

export const GATEWAY_NODE = 'gateway';

function easeInOutQuad(progress: number): number {
  return progress < 0.5 ? 2 * progress ** 2 : 1 - (-2 * progress + 2) ** 2 / 2;
}

const REQUEST_COLOR = 'var(--map-light)';
const VERDICT_COLORS: Record<Exclude<PacketTone, 'request'>, string> = {
  success: 'var(--success)',
  failure: 'var(--danger)',
};

interface Flight {
  packet: Packet;
  pathKey: string;
  isBack: boolean;
  startedAt: number;
  durationMs: number;
  resolve: (hasArrived: boolean) => void;
}

interface Packet {
  holder: SVGGElement;
  strokes: SVGPathElement[];
  appliedD: string;
  appliedDashKey: string;
}

interface GlowTrack {
  startedAt: number;
  from: number;
  peak: number;
}

interface PathGeometryCache {
  d: string;
  length: number;
  dashHead: string;
  dashTail: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const STROKE_PX = [HEAD_PX, TAIL_PX] as const;

function currentGlowOpacity(track: GlowTrack | undefined, now: number): number {
  if (!track) return 0;
  const elapsed = now - track.startedAt;
  const total = MOTION_ROUTE_GLOW.duration;
  if (!(elapsed > 0) || elapsed >= total) return 0;
  const riseEnd = total / 6;
  if (elapsed <= riseEnd) {
    const t = elapsed / riseEnd;
    return track.from + (track.peak - track.from) * t;
  }
  const decayT = (elapsed - riseEnd) / (total - riseEnd);
  return track.peak * (1 - decayT);
}

export function createPacketPlayer(stage: PacketStage) {
  const flights = new Set<Flight>();
  const animations = new Set<Animation>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  const packets = new Set<Packet>();
  const glowTracks = new WeakMap<HTMLElement, GlowTrack>();
  const pathGeometry = new WeakMap<SVGPathElement, PathGeometryCache>();

  let frame = 0;
  let inFlight = 0;
  let isDisposed = false;
  let generation = 0;
  const isCurrent = (trip: number) => !isDisposed && trip === generation;

  const track = (animation: Animation): Promise<void> => {
    animations.add(animation);
    return animation.finished.then(() => { animations.delete(animation); }, () => { animations.delete(animation); });
  };
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { waits.delete(timer); resolve(); }, ms);
    waits.set(timer, resolve);
  });

  const setBusy = () => stage.gateway()?.classList.toggle(stage.classNames.gatewayBusy, inFlight > 0 && !isDisposed);

  const glow = (element: HTMLElement, peak: number) => {
    const now = performance.now();
    const from = currentGlowOpacity(glowTracks.get(element), now);
    const targetPeak = Math.max(from, peak);
    glowTracks.set(element, { startedAt: now, from, peak: targetPeak });
    for (const running of element.getAnimations()) running.cancel();
    void track(element.animate(
      [
        { opacity: from, easing: MOTION_ROUTE_LAND.easing },
        { opacity: targetPeak, offset: 1 / 6, easing: MOTION_ROUTE_GLOW.easing },
        { opacity: 0 },
      ],
      { duration: MOTION_ROUTE_GLOW.duration },
    ));
  };

  const acknowledge = (key: string, tone: PacketTone, isWashed = true) => {
    const halo = stage.halo(key);
    if (halo) glow(halo, 0.85);
    const wash = stage.wash(key);
    if (wash && isWashed) {
      const { washRequest, washSuccess, washFailure } = stage.classNames;
      wash.classList.remove(washRequest, washSuccess, washFailure);
      wash.classList.add(tone === 'success' ? washSuccess : tone === 'failure' ? washFailure : washRequest);
      wash.dataset.tone = tone;
      glow(wash, 1);
    }
  };

  const measurePath = (path: SVGPathElement): PathGeometryCache | null => {
    const d = path.getAttribute('d') ?? '';
    if (!d) return null;
    const cached = pathGeometry.get(path);
    if (cached && cached.d === d) return cached;
    const length = path.getTotalLength();
    if (!(length > 0)) return null;
    const gap = (length + 2 * TAIL_PX).toFixed(1);
    const entry: PathGeometryCache = {
      d,
      length,
      dashHead: `${HEAD_PX} ${gap}`,
      dashTail: `${TAIL_PX} ${gap}`,
    };
    pathGeometry.set(path, entry);
    return entry;
  };

  const tick = (now: number) => {
    frame = 0;
    for (const flight of flights) {
      const path = stage.path(flight.pathKey);
      const geometry = path ? measurePath(path) : null;
      if (!geometry) {
        flights.delete(flight);
        flight.resolve(false);
        continue;
      }
      const { d, length, dashHead, dashTail } = geometry;
      const progress = Math.min(1, Math.max(0, (now - flight.startedAt) / flight.durationMs));
      const travelled = easeInOutQuad(progress) * (length + TAIL_PX);
      const packet = flight.packet;
      if (packet.appliedD !== d) {
        packet.strokes[0].setAttribute('d', d);
        packet.strokes[1].setAttribute('d', d);
        packet.appliedD = d;
      }
      if (packet.appliedDashKey !== dashHead) {
        packet.strokes[0].style.strokeDasharray = dashHead;
        packet.strokes[1].style.strokeDasharray = dashTail;
        packet.appliedDashKey = dashHead;
      }
      for (let index = 0; index < STROKE_PX.length; index++) {
        const dash = STROKE_PX[index];
        const offset = flight.isBack ? travelled - length : dash - travelled;
        packet.strokes[index].style.strokeDashoffset = offset.toFixed(1);
      }
      if (progress >= 1) {
        flights.delete(flight);
        flight.resolve(true);
      }
    }
    if (flights.size > 0 && !isDisposed) frame = requestAnimationFrame(tick);
  };

  const fly = (trip: number, packet: Packet, pathKey: string, color: string, isBack: boolean, durationMs: number): Promise<boolean> => {
    if (!isCurrent(trip) || !stage.path(pathKey)) return Promise.resolve(false);
    packet.holder.style.setProperty('--packet-color', color);
    return new Promise<boolean>((resolve) => {
      flights.add({ packet, pathKey, isBack, startedAt: performance.now(), durationMs, resolve });
      if (!frame) frame = requestAnimationFrame(tick);
    });
  };

  const launch = (): Packet | undefined => {
    const layer = stage.layer();
    if (!layer) return undefined;
    const holder = document.createElementNS(SVG_NS, 'g');
    holder.setAttribute('class', stage.classNames.packet);
    const strokes = [stage.classNames.packetHead, stage.classNames.packetTail].map((className) => {
      const stroke = document.createElementNS(SVG_NS, 'path');
      stroke.setAttribute('class', className);
      return stroke;
    });
    holder.append(strokes[1], strokes[0]);
    layer.appendChild(holder);
    const packet: Packet = { holder, strokes, appliedD: '', appliedDashKey: '' };
    packets.add(packet);
    return packet;
  };

  const land = (packet: Packet) => {
    packet.holder.remove();
    packets.delete(packet);
  };

  const replay = async (route: RoutingRoute) => {
    const trip = generation;
    const packet = launch();
    if (!packet) return;
    inFlight++;
    setBusy();
    try {
      const home = laneKey(route.modelId);
      acknowledge(route.modelId, 'request');
      if (!(await fly(trip, packet, home, REQUEST_COLOR, false, LANE_HOP_MS))) return;
      acknowledge(GATEWAY_NODE, 'request');

      for (let index = 0; index < route.attempts.length; index++) {
        const attempt = route.attempts[index];
        const edge = edgeKey(attempt.targetId);
        if (!(await fly(trip, packet, edge, REQUEST_COLOR, false, EDGE_HOP_MS))) return;
        acknowledge(attempt.targetId, 'request', false);
        await wait(holdFor(attempt.event.latency_ms));
        if (!isCurrent(trip)) return;
        const isLast = index === route.attempts.length - 1;
        if (attempt.event.failed) {
          acknowledge(attempt.targetId, 'failure');
          await wait(REFUSAL_PAUSE_MS);
          if (!isCurrent(trip)) return;
          if (!isLast) {
            if (!(await fly(trip, packet, edge, VERDICT_COLORS.failure, true, REFUSAL_HOP_MS))) return;
            acknowledge(GATEWAY_NODE, 'failure');
            continue;
          }
        } else {
          acknowledge(attempt.targetId, 'success');
        }
        const tone = attempt.event.failed ? 'failure' : 'success';
        if (!(await fly(trip, packet, edge, VERDICT_COLORS[tone], true, EDGE_HOP_MS))) return;
        acknowledge(GATEWAY_NODE, tone);
        if (!(await fly(trip, packet, home, VERDICT_COLORS[tone], true, LANE_HOP_MS))) return;
        acknowledge(route.modelId, tone);
        break;
      }
    } finally {
      inFlight--;
      setBusy();
      land(packet);
    }
  };

  const halt = () => {
    generation++;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const flight of flights) flight.resolve(false);
    flights.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const [timer, resolve] of waits) {
      clearTimeout(timer);
      resolve();
    }
    waits.clear();
    for (const animation of animations) animation.cancel();
    animations.clear();
    for (const packet of packets) packet.holder.remove();
    packets.clear();
    stage.gateway()?.classList.remove(stage.classNames.gatewayBusy);
  };
  const isPageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const onVisibilityChange = () => {
    if (isPageHidden()) halt();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  const unsubscribeMotion = subscribeMotionPreference(() => {
    if (isMotionReduced()) halt();
  });

  return {
    play(routes: readonly RoutingRoute[]) {
      if (isDisposed || isPageHidden() || isMotionReduced()) return;
      routes.slice(-MAX_REPLAYED_ROUTES).forEach((route, index) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (isDisposed || isPageHidden() || isMotionReduced() || inFlight >= MAX_LIVE_PACKETS) return;
          void replay(route);
        }, index * ROUTE_STAGGER_MS);
        timers.add(timer);
      });
    },
    dispose() {
      isDisposed = true;
      unsubscribeMotion();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      halt();
    },
  };
}
