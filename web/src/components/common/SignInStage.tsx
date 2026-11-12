import React from 'react';
import { BrandArtwork } from './BrandArtwork';
import { LobeIcon } from '../LobeIcon';
import { useT } from '../../i18n';
import { isMotionReduced } from '../../utils/motionPreference';
import styles from './SignInStage.module.css';

/**
 * The sign-in page's showcase: what the console is, drawn rather than described. Coding clients
 * on the left send requests into the gateway, which routes each one on to a model provider. The
 * glows follow the dashboard's routing map: opacity-animated overlays and moving strokes, never an
 * animated shadow, and every lane carries its pulse from client to provider without a gap.
 *
 * It is decorative and desktop-only: the parent does not mount it on a narrow viewport, where a
 * reduced copy would only be a crude one, and it is hidden from assistive technology.
 */

// One drawing space shared by the strokes and the nodes laid over them, so the two stay aligned
// at every width: nodes are positioned in percentages of this box.
const VIEW = { width: 640, height: 400 };
const GATEWAY = { x: 320, y: 200, half: 46 };
const NODE_HALF = 22;

const CLIENTS = [
  { iconId: 'ClaudeCode', y: 110 },
  { iconId: 'Codex', y: 200 },
  { iconId: 'Antigravity', y: 290 },
];
const PROVIDERS = [
  { iconId: 'Claude', y: 76 },
  { iconId: 'OpenAI', y: 160 },
  { iconId: 'Gemini', y: 240 },
  { iconId: 'DeepSeek', y: 324 },
];
const CLIENT_X = 76;
const PROVIDER_X = 564;

function inboundPath(y: number): string {
  const startX = CLIENT_X + NODE_HALF;
  const endX = GATEWAY.x - GATEWAY.half;
  const bend = (endX - startX) * 0.55;
  return `M${startX} ${y} C${startX + bend} ${y}, ${endX - bend} ${GATEWAY.y}, ${endX} ${GATEWAY.y}`;
}

function outboundPath(y: number): string {
  const startX = GATEWAY.x + GATEWAY.half;
  const endX = PROVIDER_X - NODE_HALF;
  const bend = (endX - startX) * 0.55;
  return `M${startX} ${GATEWAY.y} C${startX + bend} ${GATEWAY.y}, ${endX - bend} ${y}, ${endX} ${y}`;
}

// A route is one request's journey: in from a client, out to a provider. Both halves share one
// period and one delay; the inbound stroke travels in the first half and the outbound one in the
// second, so the pulse reads as a single request passing through the gateway.
const ROUTES = [
  { client: 0, provider: 0 },
  { client: 1, provider: 2 },
  { client: 2, provider: 1 },
  { client: 0, provider: 3 },
  { client: 1, provider: 0 },
];

export type SignInStageState = 'idle' | 'submitting' | 'failed';

function percent(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}

const gatewayPosition = { left: percent(GATEWAY.x, VIEW.width), top: percent(GATEWAY.y, VIEW.height) };

export const SignInStage: React.FC<{ state: SignInStageState; failures: number }> = ({ state, failures }) => {
  const t = useT();
  const stageRef = React.useRef<HTMLElement>(null);
  const frameRef = React.useRef<number>(0);

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
        <div className={styles['scene']} style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}` }}>
          <svg className={styles['wires']} viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} preserveAspectRatio="xMidYMid meet">
            <g className={styles['orbits']}>
              <circle className={styles['orbit-outer']} cx={GATEWAY.x} cy={GATEWAY.y} r={112} />
              <circle className={styles['orbit-inner']} cx={GATEWAY.x} cy={GATEWAY.y} r={78} />
              {/* Spins only while a sign-in is in flight; paused rather than re-timed, so it
                  starts and stops where it is instead of jumping to a new phase. */}
              <circle className={styles['orbit-boost']} cx={GATEWAY.x} cy={GATEWAY.y} r={64} pathLength={100} />
            </g>
            {CLIENTS.map((client) => <path key={client.iconId} className={styles['track']} d={inboundPath(client.y)} />)}
            {PROVIDERS.map((provider) => <path key={provider.iconId} className={styles['track']} d={outboundPath(provider.y)} />)}
            <g className={styles['flows']}>
              {ROUTES.map((route, index) => {
                const style = { '--route': index } as React.CSSProperties;
                return (
                  <React.Fragment key={index}>
                    <path className={`${styles['flow']} ${styles['flow-in']}`} style={style} pathLength={100} d={inboundPath(CLIENTS[route.client].y)} />
                    <path className={`${styles['flow']} ${styles['flow-out']}`} style={style} pathLength={100} d={outboundPath(PROVIDERS[route.provider].y)} />
                  </React.Fragment>
                );
              })}
            </g>
          </svg>

          {CLIENTS.map((client, index) => (
            <span key={client.iconId} className={styles['node']} style={{ left: percent(CLIENT_X, VIEW.width), top: percent(client.y, VIEW.height), '--order': index } as React.CSSProperties}>
              <LobeIcon iconId={client.iconId} size="50%" />
            </span>
          ))}
          {PROVIDERS.map((provider, index) => (
            <span key={provider.iconId} className={styles['node']} style={{ left: percent(PROVIDER_X, VIEW.width), top: percent(provider.y, VIEW.height), '--order': index + CLIENTS.length } as React.CSSProperties}>
              <LobeIcon iconId={provider.iconId} size="50%" />
            </span>
          ))}

          {/* The halo sits behind the gateway rather than inside it, so it lights the page
              around the tile without tinting the tile itself. */}
          <span className={styles['halo']} style={gatewayPosition}>
            <span className={styles['halo-glow']} />
            {/* A refused key flashes the gateway once; the key restarts the flash per attempt. */}
            {state === 'failed' && <span key={failures} className={styles['halo-alarm']} />}
          </span>
          <span className={styles['gateway']} style={gatewayPosition}>
            <BrandArtwork shape="mark" height={42} />
          </span>
        </div>

        <div className={styles['caption']}>
          <p className={styles['headline']}>{t('auth.stage.title')}</p>
          <p className={styles['body']}>{t('auth.stage.body')}</p>
        </div>
      </div>
    </aside>
  );
};
