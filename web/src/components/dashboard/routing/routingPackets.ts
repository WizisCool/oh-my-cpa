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
 * A stroke is a dash on a copy of the lane, so it is drawn out of the tile it
 * leaves and sinks into the next one rather than appearing on top of it. The
 * tile it reaches lights as it docks and settles back slowly; a tile already
 * lit rises again from where it is, so a second request never blinks it dark.
 *
 * It is imperative on purpose. A trip lives for about two seconds and carries
 * no state the page reads back, so holding it in React state would re-render
 * the map on every frame for nothing. The stroke copies its lane as it is drawn
 * at that moment, on every frame, so a row sliding while a request is on its
 * lane carries the request with it.
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

/**
 * How long a credential holds a request before its answer leaves: a hint of the
 * real latency, compressed so a ten-second answer does not hold the map.
 */
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

/** A credential's one lane out of the gateway, which every model's requests to it share. */
export function edgeKey(targetId: string): string {
  return `out:${targetId}`;
}

export const GATEWAY_NODE = 'gateway';

/** Starts and ends at rest, but leaves and arrives briskly: a cubic lingered at both nodes. */
function easeInOutQuad(progress: number): number {
  return progress < 0.5 ? 2 * progress ** 2 : 1 - (-2 * progress + 2) ** 2 / 2;
}

/** The light a request sets out in, defined on the map. */
const REQUEST_COLOR = 'var(--map-light)';
/** What a request carries home: an answer, or the refusal it was given. */
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
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const STROKE_PX = [HEAD_PX, TAIL_PX];

export function createPacketPlayer(stage: PacketStage) {
  const flights = new Set<Flight>();
  const animations = new Set<Animation>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** Pauses inside a trip, with the resolver that lets a halt end the trip instead of stranding it. */
  const waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  const packets = new Set<Packet>();
  let frame = 0;
  let inFlight = 0;
  let isDisposed = false;
  /** Bumped by every halt: a trip started before it ends at its next step rather than resuming. */
  let generation = 0;
  const isCurrent = (trip: number) => !isDisposed && trip === generation;

  const track = (animation: Animation): Promise<void> => {
    animations.add(animation);
    // A cancelled animation rejects; a halt is the only canceller.
    return animation.finished.then(() => { animations.delete(animation); }, () => { animations.delete(animation); });
  };
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { waits.delete(timer); resolve(); }, ms);
    waits.set(timer, resolve);
  });

  const setBusy = () => stage.gateway()?.classList.toggle(stage.classNames.gatewayBusy, inFlight > 0 && !isDisposed);

  /**
   * Lights an element and lets it settle back over the glow beat, starting from
   * whatever light it still has: a node lit again while it glows rises from
   * there instead of dropping dark and starting over.
   */
  const glow = (element: HTMLElement, peak: number) => {
    const from = Number(getComputedStyle(element).opacity) || 0;
    for (const running of element.getAnimations()) running.cancel();
    void track(element.animate(
      [
        { opacity: from, easing: MOTION_ROUTE_LAND.easing },
        { opacity: Math.max(from, peak), offset: 1 / 6, easing: MOTION_ROUTE_GLOW.easing },
        { opacity: 0 },
      ],
      { duration: MOTION_ROUTE_GLOW.duration },
    ));
  };

  /**
   * A tile takes a request that docked in it: its edge brightens, and with `tone` a wash in that
   * tone spreads across it.
   */
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

  const tick = (now: number) => {
    frame = 0;
    for (const flight of flights) {
      // The lane is read again every frame: a row that slid or a lane that was
      // redrawn carries the request with it, and a lane that went away ends the trip.
      const path = stage.path(flight.pathKey);
      const d = path?.getAttribute('d') ?? '';
      const length = d ? path?.getTotalLength() ?? 0 : 0;
      if (!path || !(length > 0)) {
        flights.delete(flight);
        flight.resolve(false);
        continue;
      }
      const progress = Math.min(1, Math.max(0, (now - flight.startedAt) / flight.durationMs));
      // The head runs from the lane's start until the whole tail has sunk past its end, so the
      // stroke is drawn out of one tile and into the next by the lane's own ends.
      const travelled = easeInOutQuad(progress) * (length + TAIL_PX);
      flight.packet.strokes.forEach((stroke, index) => {
        const dash = STROKE_PX[index];
        if (stroke.getAttribute('d') !== d) stroke.setAttribute('d', d);
        stroke.style.strokeDasharray = `${dash} ${(length + 2 * TAIL_PX).toFixed(1)}`;
        // Forwards the dash spans [travelled - dash, travelled]; back it spans the mirror of that.
        const offset = flight.isBack ? travelled - length : dash - travelled;
        stroke.style.strokeDashoffset = offset.toFixed(1);
      });
      if (progress >= 1) {
        flights.delete(flight);
        flight.resolve(true);
      }
    }
    if (flights.size > 0 && !isDisposed) frame = requestAnimationFrame(tick);
  };

  /** Carries a packet along one lane, forwards or back, in `color`; false when the lane is not drawn. */
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
    // Drawn tail first, so the head lies over it. Each starts with no lane, so nothing shows
    // until its first hop draws it out of the model's tile.
    const strokes = [stage.classNames.packetHead, stage.classNames.packetTail].map((className) => {
      const stroke = document.createElementNS(SVG_NS, 'path');
      stroke.setAttribute('class', className);
      return stroke;
    });
    holder.append(strokes[1], strokes[0]);
    layer.appendChild(holder);
    const packet = { holder, strokes };
    packets.add(packet);
    return packet;
  };

  /** The request has sunk into its last tile; only its element is left to remove. */
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
        // A credential past the map's limit has no lane; the request ends at the gateway.
        if (!(await fly(trip, packet, edge, REQUEST_COLOR, false, EDGE_HOP_MS))) return;
        // The credential lights as the request docks, and washes in the answer's tone when it answers.
        acknowledge(attempt.targetId, 'request', false);
        await wait(holdFor(attempt.event.latency_ms));
        if (!isCurrent(trip)) return;
        const isLast = index === route.attempts.length - 1;
        if (attempt.event.failed) {
          acknowledge(attempt.targetId, 'failure');
          await wait(REFUSAL_PAUSE_MS);
          if (!isCurrent(trip)) return;
          if (!isLast) {
            // Refused: back to the gateway, which sends it on to the next credential.
            if (!(await fly(trip, packet, edge, VERDICT_COLORS.failure, true, REFUSAL_HOP_MS))) return;
            acknowledge(GATEWAY_NODE, 'failure');
            continue;
          }
        } else {
          acknowledge(attempt.targetId, 'success');
        }
        // The answer, or the last refusal, goes home the way it came.
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

  /**
   * Ends every trip and clears the map back to rest, without retiring the player.
   *
   * A hidden page runs no animation frames and throttles its timers, so a trip left running there
   * does not pause: its clock keeps going, and on return every hop it missed would complete in one
   * frame each - the map would replay the whole time away at speed. Nothing on the map is worth
   * resuming, because what a trip shows is "this is happening now".
   */
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
    /** Replays routes oldest first; a read with more than the cap replays its newest. */
    play(routes: readonly RoutingRoute[]) {
      // Nobody is watching a hidden page, and the trip could not run there anyway.
      if (isDisposed || isPageHidden() || isMotionReduced()) return;
      routes.slice(-MAX_REPLAYED_ROUTES).forEach((route, index) => {
        // Even the first starts on a timer: a model that arrived with this read gets
        // its row and lane in the render after the one that delivered the read.
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
