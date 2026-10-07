import regularFontURL from '../assets/fonts/sarasa-mono-sc-regular.woff2?url';
import boldFontURL from '../assets/fonts/sarasa-mono-sc-bold.woff2?url';
import { saveBlob } from '../utils/download';
import { exportFileName } from './export';
import { conversationHTML } from './conversationHtml';
import type { SnapshotDocumentOptions } from './conversationHtml';
import { SNAPSHOT_IMAGE_SCALE, SNAPSHOT_IMAGE_WIDTH, snapshotImageSlices } from './conversationSnapshot';

const SNAPSHOT_LOAD_TIMEOUT_MS = 15_000;

function readDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function embeddedFont(url: string, weight: number): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Snapshot font unavailable');
  const dataURL = await readDataURL(new Blob([await response.arrayBuffer()], { type: 'font/woff2' }));
  return `@font-face{font-family:"OMC Snapshot";src:url("${dataURL}") format("woff2");font-weight:${weight};font-style:normal}`;
}
let fontCSSPromise: Promise<string> | undefined;
async function snapshotFontCSS(): Promise<string> {
  if (!fontCSSPromise) fontCSSPromise = Promise.all([embeddedFont(regularFontURL, 400), embeddedFont(boldFontURL, 700)])
    .then(fonts => fonts.join('')).catch(error => { fontCSSPromise = undefined; throw error; });
  return fontCSSPromise;
}
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Snapshot image unavailable'));
    image.src = url;
  });
}

/** Render a separate, script-disabled document so scrolling and disclosures in the app stay untouched. */
async function snapshotImages(html: string): Promise<Blob[]> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${SNAPSHOT_IMAGE_WIDTH}px;height:1px;border:0;pointer-events:none`;
  // A document that never loads must fail the export; a pending promise would keep the menu disabled until a reload.
  let loadTimer: number | undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve();
    loadTimer = window.setTimeout(() => reject(new Error('Snapshot document timed out')), SNAPSHOT_LOAD_TIMEOUT_MS);
  });
  frame.srcdoc = html.replace(/<script>[\s\S]*?<\/script>/g, '');
  document.body.append(frame);
  try {
    await loaded;
    const snapshotDocument = frame.contentDocument;
    if (!snapshotDocument) throw new Error('Snapshot document unavailable');
    snapshotDocument.body.classList.add('image-capture');
    // A picture has no disclosure to open: the capability chain is shown, and reasoning stays out.
    snapshotDocument.querySelectorAll<HTMLDetailsElement>('details.chain').forEach(chain => { chain.open = true; });
    await snapshotDocument.fonts.ready;
    await Promise.all(Array.from(snapshotDocument.images).map(image => image.decode()));
    const height = Math.ceil(snapshotDocument.body.getBoundingClientRect().height);
    const blocks = snapshotDocument.querySelectorAll('.turn, .answer > *, .answer > .markdown > *, .fold-body > *, .snapshot-foot, tbody tr');
    // Half the gap above a block belongs to the page before it, so neither side of a cut looks cropped.
    const slices = snapshotImageSlices(height, Array.from(blocks, block => block.getBoundingClientRect().top - 6));
    const body = snapshotDocument.body;
    const stylesheet = snapshotDocument.querySelector('style')!.textContent!;
    const blobs: Blob[] = [];
    for (const slice of slices) {
      const wrapper = snapshotDocument.createElement('div');
      wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      wrapper.style.cssText = `width:${SNAPSHOT_IMAGE_WIDTH}px;height:${slice.height}px;overflow:hidden;background:var(--bg)`;
      const clonedBody = body.cloneNode(true) as HTMLBodyElement;
      clonedBody.style.cssText = `margin:0;transform:translateY(-${slice.top}px)`;
      wrapper.append(clonedBody);
      const style = snapshotDocument.createElement('style');
      style.textContent = stylesheet;
      wrapper.prepend(style);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SNAPSHOT_IMAGE_WIDTH}" height="${slice.height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrapper)}</foreignObject></svg>`;
      const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const canvas = document.createElement('canvas');
      canvas.width = SNAPSHOT_IMAGE_WIDTH * SNAPSHOT_IMAGE_SCALE;
      canvas.height = slice.height * SNAPSHOT_IMAGE_SCALE;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Snapshot canvas unavailable');
      context.scale(SNAPSHOT_IMAGE_SCALE, SNAPSHOT_IMAGE_SCALE);
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error('Snapshot encoding failed');
      blobs.push(blob);
    }
    return blobs;
  } finally { window.clearTimeout(loadTimer); frame.remove(); }
}

export async function downloadConversation(options: SnapshotDocumentOptions, format: 'html' | 'image', prefix: string): Promise<void> {
  const fontCSS = await snapshotFontCSS();
  const html = conversationHTML({ ...options, appearance: { ...options.appearance, fontCSS } });
  if (format === 'html') {
    saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), exportFileName(prefix, 'html', options.exportedAt));
    return;
  }
  // All pages must encode successfully before any download: a failed last page cannot look complete.
  const images = await snapshotImages(html);
  images.forEach((image, index) => saveBlob(image, exportFileName(
    images.length > 1 ? `${prefix}-${String(index + 1).padStart(3, '0')}` : prefix, 'png', options.exportedAt)));
}
