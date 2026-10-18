import { MOTION_ROUTE, MOTION_ROUTE_GLOW, MOTION_ROUTE_LAND } from '../../../theme/themeConfig';
import type { RoutingRoute } from '../../../types/usageRouting';

/**
 * The routing map's travelling requests, after Magpie's: a dot leaves the
 * model, passes through the gateway to the credential CPA picked, waits there
 * while that credential answers, and comes back. While a dot is on a lane, or
 * waiting at the end of it, the lane's dashes flow in the direction it travels,
 * so a busy route reads as traffic rather than as a line. The dot and the flow
 * stay in the model's identity colour in both directions; the answer's verdict
 * is carried by the node surfaces, never by the line.
 *
 * The light is continuous from node to node. A dot emerges from a node's port
 * and sinks into the next one rather than appearing on top of it; the node it
 * sinks into lights as it docks and settles back slowly, and a lane brightens
 * behind the dot that crossed it. A node already glowing lights again from where
 * it is, so a second request never blinks it dark first.
 *
 * It is imperative on purpose. A trip lives for about two seconds and carries
 * no state the page reads back, so holding it in React state would re-render
 * the map on every frame for nothing. The dot is moved on animation frames
 * along the lane as it is drawn at that moment, so a row sliding while a dot is
 * on its lane carries the dot's path with it (docs/design.md §7 rule 9).
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
/**
 * The share of a hop over which a dot emerges from the node it leaves, and sinks
 * into the node it reaches: it passes through nodes rather than resting on them.
 */
const PORT_FADE_SHARE = 0.18;
/** How bright a lane is just behind the dot that crossed it, before it settles back. */
const TRAIL_OPACITY = 0.7;

/**
 * How long a credential holds a request before its answer leaves: a hint of the
 * real latency, compressed so a ten-second answer does not hold the map.
 */
export function holdFor(latencyMs: number): number {
  return Math.round(Math.min(480, Math.max(120, latencyMs / 20)));
}

export type PacketTone = 'request' | 'success' | 'failure';

export interface PacketStage {
  /** The positioned layer dots are drawn in; it shares the lanes' coordinates. */
  layer: () => HTMLElement | null;
  path: (key: string) => SVGPathElement | null;
  /** The flowing dashes drawn over a lane while something travels it. */
  flow: (key: string) => SVGPathElement | null;
  /** A node's light: the wash across it, the glow on its edge, and the ring its port sends out. */
  wash: (key: string) => HTMLElement | null;
  halo: (key: string) => HTMLElement | null;
  ring: (key: string) => HTMLElement | null;
  /** The gateway node, marked busy while any request is on the map. */
  gateway: () => HTMLElement | null;
  color: (modelId: string) => string;
  classNames: {
    packet: string;
    packetDot: string;
    flowOn: string;
    flowBack: string;
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

/**
 * The node surfaces that still carry a verdict: the port's ring and the wash spread across the row
 * when it answers or refuses. A lane and the dot on it never take these hues - a green or red line
 * on a routing map reads as the state of the connection, which is not what the line means.
 */
const NODE_TONE_COLORS: Record<Exclude<PacketTone, 'request'>, string> = {
  success: 'var(--success)',
  failure: 'var(--danger)',
};

/** Starts and ends at rest, but leaves and arrives briskly: a cubic lingered at both nodes. */
function easeInOutQuad(progress: number): number {
  return progress < 0.5 ? 2 * progress ** 2 : 1 - (-2 * progress + 2) ** 2 / 2;
}

interface Flight {
  holder: HTMLElement;
  pathKey: string;
  isBack: boolean;
  startedAt: number;
  durationMs: number;
  resolve: (hasArrived: boolean) => void;
}

interface Packet {
  holder: HTMLElement;
  dot: HTMLElement;
}

export function createPacketPlayer(stage: PacketStage) {
  const flights = new Set<Flight>();
  const animations = new Set<Animation>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** Pauses inside a trip, with the resolver that lets a halt end the trip instead of stranding it. */
  const waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  const packets = new Set<Packet>();
  const lit = new Map<string, number>();
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

  /** A lane flows while anything travels it or waits at its end, in the direction of travel. */
  const light = (pathKey: string, color: string, isBack: boolean) => {
    lit.set(pathKey, (lit.get(pathKey) ?? 0) + 1);
    const flow = stage.flow(pathKey);
    if (!flow) return;
    flow.style.stroke = color;
    flow.classList.add(stage.classNames.flowOn);
    flow.classList.toggle(stage.classNames.flowBack, isBack);
  };
  const unlight = (pathKey: string) => {
    const count = (lit.get(pathKey) ?? 1) - 1;
    if (count > 0) {
      lit.set(pathKey, count);
      return;
    }
    lit.delete(pathKey);
    stage.flow(pathKey)?.classList.remove(stage.classNames.flowOn, stage.classNames.flowBack);
  };

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

  /** A lane stays lit behind the dot that crossed it and settles back to its resting weight. */
  const trail = (pathKey: string) => {
    const path = stage.path(pathKey);
    if (!path) return;
    const from = Number(getComputedStyle(path).opacity) || 0;
    for (const running of path.getAnimations()) running.cancel();
    // No closing keyframe: the lane settles to whatever its stylesheet rests it at.
    void track(path.animate(
      [
        { opacity: from, offset: 0, easing: MOTION_ROUTE_LAND.easing },
        { opacity: Math.max(from, TRAIL_OPACITY), offset: 1 / 6, easing: MOTION_ROUTE_GLOW.easing },
      ],
      { duration: MOTION_ROUTE_GLOW.duration },
    ));
  };

  /**
   * A node takes a dot that docked in it: its edge glows and its port sends out a
   * ring, and with `tone` a wash in that tone spreads across it from the port.
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
    const ring = stage.ring(key);
    if (ring) {
      ring.style.setProperty('--ring-color', tone === 'request' ? 'var(--accent)' : NODE_TONE_COLORS[tone]);
      void track(ring.animate(
        [{ transform: 'scale(0.8)', opacity: 0.7 }, { transform: 'scale(2.2)', opacity: 0 }],
        { duration: MOTION_ROUTE_LAND.duration, easing: MOTION_ROUTE_LAND.easing },
      ));
    }
  };

  const tick = (now: number) => {
    frame = 0;
    for (const flight of flights) {
      // The lane is read again every frame: a row that slid or a lane that was
      // redrawn carries the dot with it, and a lane that went away ends the trip.
      const path = stage.path(flight.pathKey);
      const length = path?.getTotalLength() ?? 0;
      if (!path || !(length > 0)) {
        flights.delete(flight);
        flight.resolve(false);
        continue;
      }
      const progress = Math.min(1, Math.max(0, (now - flight.startedAt) / flight.durationMs));
      const eased = easeInOutQuad(progress);
      const point = path.getPointAtLength((flight.isBack ? 1 - eased : eased) * length);
      flight.holder.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
      flight.holder.style.opacity = Math.min(1, progress / PORT_FADE_SHARE, (1 - progress) / PORT_FADE_SHARE).toFixed(3);
      if (progress >= 1) {
        flights.delete(flight);
        flight.resolve(true);
      }
    }
    if (flights.size > 0 && !isDisposed) frame = requestAnimationFrame(tick);
  };

  /** Carries a packet along one lane, forwards or back; false when the lane is not drawn. */
  const fly = (trip: number, packet: Packet, pathKey: string, color: string, isBack: boolean, durationMs: number): Promise<boolean> => {
    if (!isCurrent(trip) || !stage.path(pathKey)) return Promise.resolve(false);
    packet.dot.style.setProperty('--packet-color', color);
    light(pathKey, color, isBack);
    return new Promise<boolean>((resolve) => {
      flights.add({ holder: packet.holder, pathKey, isBack, startedAt: performance.now(), durationMs, resolve });
      if (!frame) frame = requestAnimationFrame(tick);
    }).then((hasArrived) => {
      if (hasArrived) trail(pathKey);
      return hasArrived;
    }).finally(() => unlight(pathKey));
  };


  const launch = (): Packet | undefined => {
    const layer = stage.layer();
    if (!layer) return undefined;
    const holder = document.createElement('span');
    holder.className = stage.classNames.packet;
    // Hidden until its first hop draws it out of the model's port.
    holder.style.opacity = '0';
    const dot = document.createElement('span');
    dot.className = stage.classNames.packetDot;
    holder.appendChild(dot);
    layer.appendChild(holder);
    const packet = { holder, dot };
    packets.add(packet);
    return packet;
  };

  /** The dot has sunk into its last node; only its element is left to remove. */
  const land = (packet: Packet) => {
    packet.holder.remove();
    packets.delete(packet);
  };

  /** Waits at a credential with the lane still flowing towards it, as the request does there. */
  const hold = async (pathKey: string, color: string, ms: number) => {
    light(pathKey, color, false);
    await wait(ms);
    unlight(pathKey);
  };


  const replay = async (route: RoutingRoute) => {
    const trip = generation;
    const packet = launch();
    if (!packet) return;
    inFlight++;
    setBusy();
    try {
      const color = stage.color(route.modelId);
      const home = laneKey(route.modelId);
      acknowledge(route.modelId, 'request');
      if (!(await fly(trip, packet, home, color, false, LANE_HOP_MS))) return;
      acknowledge(GATEWAY_NODE, 'request');

      for (let index = 0; index < route.attempts.length; index++) {
        const attempt = route.attempts[index];
        const edge = edgeKey(attempt.targetId);
        // A credential past the map's limit has no lane; the request ends at the gateway.
        if (!(await fly(trip, packet, edge, color, false, EDGE_HOP_MS))) return;
        // The credential lights as the request docks, and washes in the answer's tone when it answers.
        acknowledge(attempt.targetId, 'request', false);
        await hold(edge, color, holdFor(attempt.event.latency_ms));
        if (!isCurrent(trip)) return;
        const isLast = index === route.attempts.length - 1;
        if (attempt.event.failed) {
          acknowledge(attempt.targetId, 'failure');
          await wait(REFUSAL_PAUSE_MS);
          if (!isCurrent(trip)) return;
          if (!isLast) {
            // Refused: back to the gateway, which sends it on to the next credential.
            if (!(await fly(trip, packet, edge, color, true, REFUSAL_HOP_MS))) return;
            acknowledge(GATEWAY_NODE, 'failure');
            continue;
          }
        } else {
          acknowledge(attempt.targetId, 'success');
        }
        // The answer, or the last refusal, goes home the way it came.
        const tone = attempt.event.failed ? 'failure' : 'success';
        if (!(await fly(trip, packet, edge, color, true, EDGE_HOP_MS))) return;
        acknowledge(GATEWAY_NODE, tone);
        if (!(await fly(trip, packet, home, color, true, LANE_HOP_MS))) return;
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
    for (const key of lit.keys()) stage.flow(key)?.classList.remove(stage.classNames.flowOn, stage.classNames.flowBack);
    lit.clear();
    stage.gateway()?.classList.remove(stage.classNames.gatewayBusy);
  };
  const isPageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const onVisibilityChange = () => {
    if (isPageHidden()) halt();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    /** Replays routes oldest first; a read with more than the cap replays its newest. */
    play(routes: readonly RoutingRoute[]) {
      // Nobody is watching a hidden page, and the trip could not run there anyway.
      if (isDisposed || isPageHidden()) return;
      routes.slice(-MAX_REPLAYED_ROUTES).forEach((route, index) => {
        // Even the first starts on a timer: a model that arrived with this read gets
        // its row and lane in the render after the one that delivered the read.
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (isDisposed || isPageHidden() || inFlight >= MAX_LIVE_PACKETS) return;
          void replay(route);
        }, index * ROUTE_STAGGER_MS);
        timers.add(timer);
      });
    },
    dispose() {
      isDisposed = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      halt();
    },
  };
}
