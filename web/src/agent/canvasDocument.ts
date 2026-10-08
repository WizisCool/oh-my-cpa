/**
 * The document a canvas runs in (ADR 0072).
 *
 * A canvas is markup the model wrote, so it is never part of the console's own document. It is
 * given a document of its own, shown in a frame sandboxed to scripts only: no origin, so no
 * session, storage or access to the console; and a policy, stated before any of the model's
 * markup is parsed, under which nothing loads from the network. The console's frame policy stops
 * the frame from navigating itself elsewhere. What the canvas does get is the theme, as the same
 * CSS variables the console uses, the rows it asked for, and the kit that draws and formats them
 * (`canvasKit.ts`).
 */
import { THREAD_RADII } from '../theme/palette';
import { isEmbeddedIcon } from './uiAssets';
import type { UIIconAssets } from './uiAssets';
import { CANVAS_CAPTURE_REPLY, CANVAS_KIT, CANVAS_KIT_CSS } from './canvasKit';

export const CANVAS_TOKENS = [
  'bg', 'surface', 'hover', 'fg', 'fg-2', 'muted', 'meta', 'border', 'border-soft', 'accent', 'success', 'warn', 'danger',
  'series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6',
] as const;

export const CANVAS_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
export const CANVAS_SANDBOX = 'allow-scripts';
export const CANVAS_MIN_HEIGHT = 48;
// Dashboards scroll with the transcript up to the same bounded height as a saved image.
// The cap still prevents untrusted frame messages from allocating an unbounded layout.
export const CANVAS_MAX_HEIGHT = 16384;
/** A saved picture is bounded like any other input from the frame: the canvas chose these numbers. */
export const CANVAS_IMAGE_MAX_WIDTH = 4096;
export const CANVAS_IMAGE_MAX_HEIGHT = 16384;
export const CANVAS_IMAGE_MAX_BYTES = 8 << 20;
export const CANVAS_MESSAGE = 'omc-canvas-height';

// A picture of a canvas may be as large as the frame's own bound, and a raster twice that size is
// beyond what browsers draw: Safari refuses a surface over 16,777,216 pixels and Chrome refuses a
// side over 32767, and `toBlob` answers neither with a picture. The wanted scale is lowered to
// whatever fits, so a tall figure is saved smaller rather than not at all.
export const MAX_RASTER_SIDE = 16384;
export const MAX_RASTER_AREA = 16_777_216;
export function canvasRasterScale(width: number, height: number, wanted: number): number {
  return Math.min(wanted, MAX_RASTER_SIDE / width, MAX_RASTER_SIDE / height, Math.sqrt(MAX_RASTER_AREA / (width * height)));
}

const BASE_CSS = [
  `:root{${Object.entries(THREAD_RADII).map(([name, radius]) => `--radius-${name}:${radius}px`).join(';')}}`,
  '*{box-sizing:border-box}',
  'html,body{margin:0}',
  // Only a canvas taller than the frame's cap scrolls, and then on a slim bar.
  'html{scrollbar-width:thin}',
  'body{padding:0;background:var(--surface);color:var(--fg);font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
  'a{color:var(--accent)}',
  'button,input,select,textarea{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-control);padding:6px 10px;max-width:100%}',
  'button{cursor:pointer}button:hover{background:var(--hover)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
  'table{border-collapse:collapse}',
  // Nothing a canvas draws may be wider than the frame: media shrinks to it and preformatted
  // text scrolls inside its own block, so the page itself never scrolls sideways.
  'svg,img,canvas,video{max-width:100%}',
  'pre{max-width:100%;overflow:auto}',
  CANVAS_KIT_CSS,
].join('');

// Overflow may change without resizing the root box (positioned content, SVG marks or a
// trailing margin). Observe document mutations as well as layout and coalesce reports into
// one frame; including the viewport in the measurement would prevent shrinking after filters.
//
// Content sized from the frame itself (`min-height:100vh`, `height:100%`) is as tall as the frame
// after every growth, so it carries the same overflow into the next report. A report that only a
// layout change produced and that repeats the last overflow therefore has no content behind it:
// sending it would grow the frame into blank space, without end. A content mutation always
// reports, so a canvas that is still being written keeps growing.
export const CANVAS_HEIGHT_REPORTER = `(function(){var pending=false,hasMutation=false,lastHeight=-1,lastOverflow=null;function report(){pending=false;var wasMutation=hasMutation;hasMutation=false;var viewport=Math.round(window.innerHeight);var height=Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height,document.body?document.body.scrollHeight:0));var overflow=Math.max(0,height-viewport);if(!wasMutation&&overflow>0&&overflow===lastOverflow)return;lastOverflow=overflow;if(height===lastHeight)return;lastHeight=height;parent.postMessage({type:${JSON.stringify(CANVAS_MESSAGE)},height:height},'*')}function schedule(fromContent){if(fromContent)hasMutation=true;if(!pending){pending=true;requestAnimationFrame(report)}}addEventListener('load',function(){schedule(false)});addEventListener('resize',function(){schedule(false)});if(window.ResizeObserver)new ResizeObserver(function(){schedule(false)}).observe(document.documentElement);if(window.MutationObserver)new MutationObserver(function(){schedule(true)}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true})})();`;

/** Keeps a JSON document from ending the script element it sits in. */
function scriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** How the kit formats: the console's token unit style, number locale and calendar zone. */
export interface CanvasFormat {
  tokenStyle?: string;
  locale?: string;
  timeZone?: string;
  emptyLabel?: string;
}

export interface CanvasDocumentOptions {
  html: string;
  icons?: UIIconAssets;
  rows: readonly unknown[];
  /** Resolved theme values keyed by token name without the leading dashes. */
  variables: Record<string, string>;
  isDark: boolean;
  /** Drawn straight on the conversation: the page takes the conversation's ground, not a card's. */
  isFrameless?: boolean;
  language: string;
  format?: CanvasFormat;
}

export function canvasDocument({ html, rows, variables, isDark, isFrameless = false, language, format = {}, icons = {} }: CanvasDocumentOptions): string {
  // Token values come from the console's own stylesheet, but they are still interpolated into CSS.
  const declarations = CANVAS_TOKENS
    .filter(token => /^[#a-z0-9.,()%\s-]+$/i.test(variables[token] ?? ''))
    .map(token => `--${token}:${variables[token]}`).join(';');
  return `<!doctype html><html lang="${language.replace(/[^a-zA-Z-]/g, '')}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${CANVAS_POLICY}">`
    + `<style>:root{color-scheme:${isDark ? 'dark' : 'light'};${declarations}}${BASE_CSS}${isFrameless ? 'body{background:var(--bg)}' : ''}</style>`
    + `<script>window.OMC_ICONS=${scriptJSON(Object.fromEntries(Object.entries(icons).filter(([, asset]) => isEmbeddedIcon(asset))))};window.OMC_DATA=${scriptJSON(rows)};window.OMC_CONFIG=${scriptJSON(format)};${CANVAS_HEIGHT_REPORTER}${CANVAS_KIT}</script>`
    + `</head><body>${html}</body></html>`;
}

export const CANVAS_DRAFT_MESSAGE = 'omc-canvas-draft';

// The parser drops unfinished tags and keeps inserted script elements inert. The draft
// policy separately blocks event handlers, so a partial document cannot execute model code.
const DRAFT_RECEIVER = `addEventListener('message',function(event){if(event.source!==parent||!event.data||event.data.type!==${JSON.stringify(CANVAS_DRAFT_MESSAGE)}||typeof event.data.html!=='string')return;document.body.innerHTML=event.data.html});`;

/**
 * The page a canvas is previewed in while the model is still writing it (ADR 0085): the same
 * sandbox, network policy, tokens and components, with a stricter script policy for the draft. The
 * console posts the markup it has so far; what the canvas computes - a chart, a diagram, the
 * state of a control - appears when the finished canvas takes this frame's place.
 */
export function canvasDraftDocument({ variables, isDark, isFrameless = false, language }: Pick<CanvasDocumentOptions, 'variables' | 'isDark' | 'isFrameless' | 'language'>): string {
  // innerHTML leaves script elements inert, but not event handlers or javascript: URLs.
  // Only the host's bootstrap gets a fresh nonce; generated markup cannot execute in a draft.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const policy = CANVAS_POLICY.replace("script-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`);
  const declarations = CANVAS_TOKENS
    .filter(token => /^[#a-z0-9.,()%\s-]+$/i.test(variables[token] ?? ''))
    .map(token => `--${token}:${variables[token]}`).join(';');
  return `<!doctype html><html lang="${language.replace(/[^a-zA-Z-]/g, '')}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${policy}">`
    + `<style>:root{color-scheme:${isDark ? 'dark' : 'light'};${declarations}}${BASE_CSS}${isFrameless ? 'body{background:var(--bg)}' : ''}</style>`
    + `<script nonce="${nonce}">${CANVAS_HEIGHT_REPORTER}${DRAFT_RECEIVER}</script></head><body></body></html>`;
}

/** The height a frame takes from a canvas's report, or nothing when the report is not one. */
export function canvasHeight(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, height } = message as { type?: unknown; height?: unknown };
  if (type !== CANVAS_MESSAGE || typeof height !== 'number' || !Number.isFinite(height)) return undefined;
  return Math.min(CANVAS_MAX_HEIGHT, Math.max(CANVAS_MIN_HEIGHT, Math.ceil(height)));
}

export interface CanvasImage {
  svg: string;
  width: number;
  height: number;
}

/** A wire bound counts bytes, not the UTF-16 units `length` reports. */
function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The picture a canvas sent back for one capture request, or nothing when the message is not it. */
export function canvasImage(message: unknown, id: string): CanvasImage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, id: replyID, svg, width, height } = message as Record<string, unknown>;
  if (type !== CANVAS_CAPTURE_REPLY || replyID !== id) return undefined;
  if (typeof svg !== 'string' || svg.length === 0 || encodedBytes(svg) > CANVAS_IMAGE_MAX_BYTES) return undefined;
  if (typeof width !== 'number' || typeof height !== 'number' || !(width >= 1) || !(height >= 1)) return undefined;
  return { svg, width: Math.min(CANVAS_IMAGE_MAX_WIDTH, Math.ceil(width)), height: Math.min(CANVAS_IMAGE_MAX_HEIGHT, Math.ceil(height)) };
}

export const UI_COMPOSE_MESSAGE = 'omc-ui-compose';
export function uiComposeMessage(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as Record<string, unknown>;
  return record.type === UI_COMPOSE_MESSAGE && typeof record.message === 'string'
    && record.message.trim().length > 0 && encodedBytes(record.message) <= 48 * 1024 ? record.message : undefined;
}
