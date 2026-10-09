import { CANVAS_MAX_HEIGHT, CANVAS_SANDBOX, canvasHeight, canvasImage, canvasRasterScale } from './canvasDocument';
import type { CanvasImage } from './canvasDocument';
import { CANVAS_CAPTURE_REQUEST } from './canvasKit';
import { createID } from '../utils/ids';

/**
 * Pictures of a canvas (ADR 0072).
 *
 * A canvas runs in a frame with no origin, so the console cannot read what it drew: only the
 * canvas can describe itself, which the kit does on request by posting back an SVG image of its
 * own document. Saving one figure and saving a whole conversation as an image both go through
 * here, so a conversation's picture shows its generated interfaces as the figure's own "save as
 * image" would have drawn them.
 */
const CAPTURE_TIMEOUT_MS = 5000;
/** How long a canvas is given to load, draw and report a height before its picture is given up on. */
const DRAW_TIMEOUT_MS = 8000;
/** A canvas has finished drawing when it has reported no new height for this long. */
const DRAW_SETTLE_MS = 180;

/** Asks a mounted canvas for a picture of itself. */
export function requestCanvasPicture(target: Window, timeoutMS = CAPTURE_TIMEOUT_MS): Promise<CanvasImage> {
  // `crypto.randomUUID` exists only on secure origins; the console is also served over plain HTTP.
  const id = createID('capture');
  return new Promise<CanvasImage>((resolve, reject) => {
    const timer = window.setTimeout(() => { window.removeEventListener('message', onReply); reject(new Error('canvas did not answer')); }, timeoutMS);
    function onReply(event: MessageEvent) {
      // The frame has no origin to check, so the sender is identified by its window.
      if (event.source !== target) return;
      const image = canvasImage(event.data, id);
      if (!image) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onReply);
      resolve(image);
    }
    window.addEventListener('message', onReply);
    target.postMessage({ type: CANVAS_CAPTURE_REQUEST, id }, '*');
  });
}

/** Rasterises the picture a canvas sent of itself. It is only ever decoded as an image. */
export async function rasterizeCanvasPicture({ svg, width, height }: CanvasImage, wantedScale: number): Promise<HTMLCanvasElement | undefined> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('canvas image unavailable'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const scale = canvasRasterScale(width, height, wantedScale);
  const surface = document.createElement('canvas');
  surface.width = Math.max(1, Math.floor(width * scale));
  surface.height = Math.max(1, Math.floor(height * scale));
  const context = surface.getContext('2d');
  if (!context) return undefined;
  // Filled exactly, rather than by the wanted scale: a lowered scale is fractional, and rounding it
  // down would leave a sliver of the surface unpainted.
  context.scale(surface.width / width, surface.height / height);
  context.drawImage(image, 0, 0);
  return surface;
}

export interface CanvasPicture {
  /** A PNG, as a data URL. */
  url: string;
  width: number;
  height: number;
}

/**
 * Draws a canvas document at a given width and returns a picture of it.
 *
 * The document runs in the same sandbox a canvas on the page does - scripts only, no origin - and
 * what comes back is treated as the kit's reply always is: bounded, and only ever decoded as an
 * image. The frame is as tall as the canvas reports, so the picture holds the whole figure and
 * not the part a default height would show.
 */
export async function drawCanvasPicture(frameDocument: string, width: number, scale: number): Promise<CanvasPicture> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', CANVAS_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // It has to sit inside the viewport to be drawn at all: the canvas reports its height from a
  // `requestAnimationFrame` callback, and a frame the browser has scrolled out of view never gets
  // one, so a capture frame parked off screen would time out with nothing to photograph. It is
  // made invisible rather than moved away, and the app underneath stays clickable.
  frame.style.cssText = `position:fixed;left:0;top:0;width:${Math.ceil(width)}px;height:160px;border:0;pointer-events:none;opacity:0`;
  let settle: (() => void) | undefined;
  let settleTimer: number | undefined;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const reported = canvasHeight(event.data);
    if (reported === undefined) return;
    frame.style.height = `${Math.min(CANVAS_MAX_HEIGHT, reported)}px`;
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => settle?.(), DRAW_SETTLE_MS);
  };
  window.addEventListener('message', onMessage);
  let drawTimer: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      settle = resolve;
      drawTimer = window.setTimeout(() => reject(new Error('canvas did not draw')), DRAW_TIMEOUT_MS);
      frame.srcdoc = frameDocument;
      document.body.append(frame);
    });
    const target = frame.contentWindow;
    if (!target) throw new Error('canvas frame unavailable');
    const picture = await requestCanvasPicture(target);
    const surface = await rasterizeCanvasPicture(picture, scale);
    if (!surface) throw new Error('canvas image not encoded');
    const url = surface.toDataURL('image/png');
    surface.width = surface.height = 0;
    return { url, width: picture.width, height: picture.height };
  } finally {
    window.clearTimeout(drawTimer);
    window.clearTimeout(settleTimer);
    window.removeEventListener('message', onMessage);
    frame.remove();
  }
}
