/**
 * The document a canvas runs in (ADR 0072).
 *
 * A canvas is markup the model wrote, so it is never part of the console's own document. It is
 * given a document of its own, shown in a frame sandboxed to scripts only: no origin, so no
 * session, storage or access to the console; and a policy, stated before any of the model's
 * markup is parsed, under which nothing loads from the network. The console's frame policy stops
 * the frame from navigating itself elsewhere. What the canvas does get is the theme, as the same
 * CSS variables the console uses, and the rows it asked for, as `window.OMC_DATA`.
 */
export const CANVAS_TOKENS = [
  'bg', 'surface', 'hover', 'fg', 'fg-2', 'muted', 'meta', 'border', 'border-soft', 'accent', 'success', 'warn', 'danger',
  'series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6',
] as const;

export const CANVAS_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
export const CANVAS_SANDBOX = 'allow-scripts';
export const CANVAS_MIN_HEIGHT = 48;
export const CANVAS_MAX_HEIGHT = 720;
export const CANVAS_MESSAGE = 'omc-canvas-height';

const BASE_CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0}',
  'body{padding:0;background:var(--surface);color:var(--fg);font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
  'a{color:var(--accent)}',
  'table{border-collapse:collapse}',
  'svg{max-width:100%}',
].join('');

// Reports the content height so the frame can fit it; the console clamps what it is told.
const HEIGHT_REPORTER = `(function(){function report(){parent.postMessage({type:${JSON.stringify(CANVAS_MESSAGE)},height:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*')}addEventListener('load',report);if(window.ResizeObserver)new ResizeObserver(report).observe(document.documentElement)})();`;

/** Keeps a JSON document from ending the script element it sits in. */
function scriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export interface CanvasDocumentOptions {
  html: string;
  rows: readonly unknown[];
  /** Resolved theme values keyed by token name without the leading dashes. */
  variables: Record<string, string>;
  isDark: boolean;
  language: string;
}

export function canvasDocument({ html, rows, variables, isDark, language }: CanvasDocumentOptions): string {
  // Token values come from the console's own stylesheet, but they are still interpolated into CSS.
  const declarations = CANVAS_TOKENS
    .filter(token => /^[#a-z0-9.,()%\s-]+$/i.test(variables[token] ?? ''))
    .map(token => `--${token}:${variables[token]}`).join(';');
  return `<!doctype html><html lang="${language.replace(/[^a-zA-Z-]/g, '')}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${CANVAS_POLICY}">`
    + `<style>:root{color-scheme:${isDark ? 'dark' : 'light'};${declarations}}${BASE_CSS}</style>`
    + `<script>window.OMC_DATA=${scriptJSON(rows)};${HEIGHT_REPORTER}</script>`
    + `</head><body>${html}</body></html>`;
}

/** The height a frame takes from a canvas's report, or nothing when the report is not one. */
export function canvasHeight(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, height } = message as { type?: unknown; height?: unknown };
  if (type !== CANVAS_MESSAGE || typeof height !== 'number' || !Number.isFinite(height)) return undefined;
  return Math.min(CANVAS_MAX_HEIGHT, Math.max(CANVAS_MIN_HEIGHT, Math.ceil(height)));
}
