import { embeddedCJKFontCSS } from '../../../theme/cjkFont';
import { embeddedFontCSS } from '../../../theme/sarasaFont';
import { RECEIPT_CSS } from './receiptStyles';

/** The ground the paper lies on in the picture, and how much of it shows around the paper. */
const BACKDROP = 'linear-gradient(160deg, #e9e6df, #d9d5cc)';
const MARGIN = 40;
const SCALE = 2;
const FAMILY = 'OMC Receipt';

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('the receipt could not be drawn'));
    image.src = url;
  });
}

/**
 * Draws the receipt element into a PNG.
 *
 * The element is cloned into a standalone SVG document with the receipt's own stylesheet and the
 * console's face embedded for exactly the characters it prints, then drawn onto a canvas at twice
 * its size. Its marks are already data URIs, so the document reaches nothing outside itself.
 */
export async function receiptImage(paper: HTMLElement): Promise<Blob> {
  const width = Math.ceil(paper.offsetWidth) + MARGIN * 2;
  // The torn foot hangs below the element's box.
  const height = Math.ceil(paper.offsetHeight) + MARGIN * 2 + 8;
  const text = paper.textContent ?? '';
  const [latin, cjk] = await Promise.all([
    embeddedFontCSS(text, FAMILY),
    embeddedCJKFontCSS(text, `${FAMILY} CJK`).catch(() => ''),
  ]);

  const clone = paper.cloneNode(true) as HTMLElement;
  clone.style.setProperty('--receipt-font', `"${FAMILY}", "${FAMILY} CJK", monospace`);
  clone.style.width = `${paper.offsetWidth}px`;
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.cssText = `width:${width}px;height:${height}px;padding:${MARGIN}px;box-sizing:border-box;background:${BACKDROP}`;
  const style = document.createElement('style');
  style.textContent = `${latin}${cjk}${RECEIPT_CSS}.omc-receipt{filter:drop-shadow(0 14px 28px rgba(40,32,20,.18)) drop-shadow(0 1px 2px rgba(40,32,20,.08))}`;
  wrapper.append(style, clone);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrapper)}</foreignObject></svg>`;
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement('canvas');
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('the receipt could not be drawn');
  context.scale(SCALE, SCALE);
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('the receipt could not be encoded');
  return blob;
}
