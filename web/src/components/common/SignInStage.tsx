import React from 'react';
import clsx from 'clsx';
import { BrandArtwork } from './BrandArtwork';
import { LobeIcon } from '../LobeIcon';
import { isMotionReduced } from '../../utils/motionPreference';
import { GATEWAY_NODE, createPacketPlayer, edgeKey, laneKey, type PacketRoute } from '../dashboard/routing/routingPackets';
import routeStyles from '../dashboard/routing/RoutingPanel.module.css';
import styles from './SignInStage.module.css';

/**
 * The sign-in page's showcase: what the console is, drawn rather than described. Coding clients
 * on the left send requests into the gateway, which routes each one on to a model provider. It is
 * the dashboard's live routing map with a scripted minute: the same tiles, gateway, lanes and
 * travelling requests (its stylesheet and packet player), only without labels or real traffic.
 * It carries no caption: the form beside it names the product, and the drawing shows what it does.
 *
 * It is decorative and desktop-only: the parent does not mount it on a narrow viewport, where a
 * reduced copy would only be a crude one, and it is hidden from assistive technology.
 */

// One drawing space shared by the lanes and the nodes laid over them, so the two stay aligned at
// every width: nodes are positioned in percentages of this box. Its width is the scene's widest,
// so at full size a unit is a pixel and the tiles take the live map's sizes; narrower, the whole
// scene scales down together (see `.scene`).
const VIEW = { width: 600, height: 376 };
const GATEWAY = { x: 300, y: 188, half: 40 };
const NODE_HALF = 20;
const CLIENT_X = 72;
const PROVIDER_X = 528;

const CLIENTS = [
  { iconId: 'ClaudeCode', y: 104 },
  { iconId: 'Codex', y: 188 },
  { iconId: 'Antigravity', y: 272 },
];
const PROVIDERS = [
  { iconId: 'Claude', y: 72 },
  { iconId: 'OpenAI', y: 150 },
  { iconId: 'Gemini', y: 226 },
  { iconId: 'DeepSeek', y: 304 },
];

// The live map's lane: a horizontal-tangent S-curve from a tile's gateway-facing edge.
function curve(fromX: number, fromY: number, toX: number, toY: number): string {
  const dx = (toX - fromX) * 0.55;
  return `M${fromX} ${fromY} C${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`;
}

const inboundPath = (y: number) => curve(CLIENT_X + NODE_HALF, y, GATEWAY.x - GATEWAY.half, GATEWAY.y);
const outboundPath = (y: number) => curve(GATEWAY.x + GATEWAY.half, GATEWAY.y, PROVIDER_X - NODE_HALF, y);

const answered = (targetId: string, latencyMs: number) => ({ targetId, event: { latency_ms: latencyMs, failed: false } });

// The scripted traffic, replayed in turn: every request is answered, so the only red on the page
// stays the sign-in's own.
const ROUTES: PacketRoute[] = [
  { modelId: 'ClaudeCode', attempts: [answered('Claude', 4200)] },
  { modelId: 'Codex', attempts: [answered('Gemini', 2600)] },
  { modelId: 'Antigravity', attempts: [answered('OpenAI', 3400)] },
  { modelId: 'ClaudeCode', attempts: [answered('DeepSeek', 1800)] },
  { modelId: 'Codex', attempts: [answered('Claude', 5200)] },
];
const ROUTE_INTERVAL_MS = 1100;

export type SignInStageState = 'idle' | 'submitting' | 'failed';

function percent(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}

const gatewayPosition = { left: percent(GATEWAY.x, VIEW.width), top: percent(GATEWAY.y, VIEW.height) };

/** Elements by key, for the packet player; the showcase's nodes never change, so neither do these. */
function useElements<T extends Element>() {
  return React.useMemo(() => {
    const elements = new Map<string, T>();
    return {
      get: (key: string) => elements.get(key) ?? null,
      ref: (key: string) => (element: T | null) => {
        if (element) elements.set(key, element);
        else elements.delete(key);
      },
    };
  }, []);
}

function TileLight({ id, washes, halos }: { id: string; washes: ReturnType<typeof useElements<HTMLElement>>; halos: ReturnType<typeof useElements<HTMLElement>> }) {
  return (
    <>
      <span ref={halos.ref(id)} className={routeStyles['halo']} />
      <span ref={washes.ref(id)} className={routeStyles['wash']} />
    </>
  );
}

export const SignInStage: React.FC<{ state: SignInStageState; failures: number }> = ({ state, failures }) => {
  const stageRef = React.useRef<HTMLElement>(null);
  const frameRef = React.useRef<number>(0);
  const layerRef = React.useRef<SVGGElement>(null);
  const hubRef = React.useRef<HTMLDivElement>(null);
  const paths = useElements<SVGPathElement>();
  const washes = useElements<HTMLElement>();
  const halos = useElements<HTMLElement>();

  React.useEffect(() => {
    const player = createPacketPlayer({
      layer: () => layerRef.current,
      path: paths.get,
      wash: washes.get,
      halo: halos.get,
      gateway: () => hubRef.current,
      classNames: {
        packet: routeStyles['packet'],
        packetHead: routeStyles['packet-head'],
        packetTail: routeStyles['packet-tail'],
        gatewayBusy: routeStyles['hub-busy'],
        washRequest: routeStyles['wash-request'],
        washSuccess: routeStyles['wash-success'],
        washFailure: routeStyles['wash-failure'],
      },
    });
    let next = 0;
    const send = () => {
      player.play([ROUTES[next]]);
      next = (next + 1) % ROUTES.length;
    };
    send();
    const timer = window.setInterval(send, ROUTE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      player.dispose();
    };
  }, [paths, washes, halos]);

  // The scene leans a few pixels toward the pointer: a hand-driven move, so it eases after the
  // hand and settles back with the console's spring when the pointer leaves. Written straight to
  // custom properties so following the pointer never re-renders React.
  const lean = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || isMotionReduced()) return;
    const stage = event.currentTarget;
    const { clientX, clientY } = event;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const box = stage.getBoundingClientRect();
      stage.style.setProperty('--lean-x', (((clientX - box.left) / box.width) * 2 - 1).toFixed(3));
      stage.style.setProperty('--lean-y', (((clientY - box.top) / box.height) * 2 - 1).toFixed(3));
      stage.dataset.leaning = 'true';
    });
  }, []);
  const settle = React.useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    const stage = stageRef.current;
    if (!stage) return;
    delete stage.dataset.leaning;
    stage.style.setProperty('--lean-x', '0');
    stage.style.setProperty('--lean-y', '0');
  }, []);
  React.useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  return (
    <aside ref={stageRef} className={styles['stage']} data-state={state} aria-hidden="true" onPointerMove={lean} onPointerLeave={settle}>
      <div className={styles['grid']} />
      <div className={`${styles['aurora']} ${styles['aurora-a']}`} />
      <div className={`${styles['aurora']} ${styles['aurora-b']}`} />

      <div className={styles['content']}>
        <div className={clsx(routeStyles['wire'], styles['scene'])} style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}` }}>
          <svg className={styles['wires']} viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} preserveAspectRatio="xMidYMid meet">
            {CLIENTS.map((client) => (
              <path key={client.iconId} ref={paths.ref(laneKey(client.iconId))} className={routeStyles['edge']} d={inboundPath(client.y)} />
            ))}
            {PROVIDERS.map((provider) => (
              <path key={provider.iconId} ref={paths.ref(edgeKey(provider.iconId))} className={routeStyles['edge']} d={outboundPath(provider.y)} />
            ))}
            <g ref={layerRef} />
          </svg>

          {[...CLIENTS.map((node) => ({ ...node, x: CLIENT_X })), ...PROVIDERS.map((node) => ({ ...node, x: PROVIDER_X }))].map((node, index) => (
            <span
              key={node.iconId}
              className={styles['anchor']}
              style={{ left: percent(node.x, VIEW.width), top: percent(node.y, VIEW.height), '--order': index } as React.CSSProperties}
            >
              <span className={routeStyles['tile']}>
                <TileLight id={node.iconId} washes={washes} halos={halos} />
                <LobeIcon iconId={node.iconId} size="50%" />
              </span>
            </span>
          ))}

          <span className={clsx(styles['anchor'], styles['hub-anchor'])} style={gatewayPosition}>
            <div ref={hubRef} className={routeStyles['hub']}>
              <svg className={clsx(routeStyles['orbits'], styles['orbits'])} viewBox="0 0 184 184">
                <circle className={routeStyles['orbit-outer']} cx={92} cy={92} r={91} />
                <circle className={routeStyles['orbit-inner']} cx={92} cy={92} r={66} />
              </svg>
              <span className={clsx(routeStyles['hub-glow'], styles['hub-glow'])} />
              {/* A refused key flashes the gateway once; the key restarts the flash per attempt. */}
              {state === 'failed' && <span key={failures} className={styles['hub-alarm']} />}
              <span className={clsx(routeStyles['tile'], routeStyles['gateway'])}>
                <TileLight id={GATEWAY_NODE} washes={washes} halos={halos} />
                <BrandArtwork shape="mark" height={30} />
              </span>
            </div>
          </span>
        </div>
      </div>
    </aside>
  );
};
