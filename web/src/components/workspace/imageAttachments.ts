import { createID } from '../../utils/ids';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface ImageAttachment { uid: string; name: string; size: number; type: string; url: string }

export async function readImage(file: File): Promise<ImageAttachment> {
  if (!IMAGE_TYPES.includes(file.type) || file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error('invalid_image');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isPNG = header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71;
  const isJPEG = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const text = String.fromCharCode(...header);
  const isWebP = text.startsWith('RIFF') && text.slice(8) === 'WEBP';
  if (!(file.type === 'image/png' && isPNG || file.type === 'image/jpeg' && isJPEG || file.type === 'image/webp' && isWebP)) throw new Error('invalid_image');
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('invalid_image')); reader.readAsDataURL(file);
  });
  const preview = new Image();
  preview.src = url;
  try { await preview.decode(); } catch { throw new Error('invalid_image'); }
  if (!preview.naturalWidth || !preview.naturalHeight || preview.naturalWidth * preview.naturalHeight > 40_000_000) throw new Error('invalid_image');
  return { uid: createID('image'), name: file.name, size: file.size, type: file.type, url };
}

const MAX_AGENT_IMAGE_BYTES = 512 * 1024;

async function encodeAgentImage(image: HTMLImageElement): Promise<Blob> {
  const contextScale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
  for (const edge of [2048, 1600, 1200, 900]) {
    const scale = Math.min(contextScale, edge / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('invalid_image');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.74, 0.62, 0.5]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (!blob) throw new Error('invalid_image');
      if (blob.size <= MAX_AGENT_IMAGE_BYTES) return blob;
      // A browser that cannot encode WebP answers with a PNG, whose size the quality setting cannot
      // change: only a smaller edge can bring it under the bound.
      if (blob.type !== 'image/webp') break;
    }
  }
  throw new Error('invalid_image');
}

/** Agent uploads are normalized before they are retained in history, keeping repeated image context compact. */
export async function readAgentImage(file: File): Promise<ImageAttachment> {
  const source = await readImage(file);
  const image = new Image();
  image.src = source.url;
  try { await image.decode(); } catch { throw new Error('invalid_image'); }
  const blob = await encodeAgentImage(image);
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('invalid_image')); reader.readAsDataURL(blob);
  });
  // The type the encoder produced, not the one it was asked for: a browser without WebP answers
  // with a PNG, and the attachment says what it holds.
  return { ...source, size: blob.size, type: blob.type || source.type, url };
}
