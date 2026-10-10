import { brandDataUri, brandDrawing } from '../../assets/brand/markup';
import type { ThemePalette } from '../../theme/palette';
import { exportPixelRatio } from './requestSelection';
import {
  SHEET_LINE_HEIGHT,
  type RequestSheet,
  type SheetCell,
  type SheetColumn,
  type SheetGlyph,
  type SheetMark,
  type SheetSegment,
  type SheetTone,
} from './requestSheetModel';

/**
 * Draws a request sheet on a canvas.
 *
 * Drawn rather than captured from the page: a capture has to clone every
 * element of every row and compute its style, which for a hundred rows is
 * several thousand nodes on the main thread and long enough to hang the tab.
 * Drawing the same hundred rows is a few thousand text calls.
 */

const BRAND_BAND_HEIGHT = 52;
const BRAND_HEIGHT = 18;
const HEADER_HEIGHT = 38;
const PAD_INLINE = 12;
const SEGMENT_GAP = 6;
const GLYPH_SIZE = 12;
const GLYPH_BOX = 18;
/**
 * The stroke paths of the glyphs the list draws as icons, on Lucide's 24-unit
 * grid: `RadioOff` for a non-streaming response, `ArrowLeftRight` for a
 * substituted model and `Zap` for the fast lane, the same three
 * `components/icons` gives the row.
 */
const GLYPH_PATHS: Record<SheetGlyph, readonly string[]> = {
  non_stream: [
    'M13.414 13.414a2 2 0 1 1-2.828-2.828',
    'M16.247 7.761a6 6 0 0 1 1.744 4.572',
    'M19.075 4.933a10 10 0 0 1 2.234 10.72',
    'm2 2 20 20',
    'M4.925 19.067a10 10 0 0 1 0-14.134',
    'M7.753 16.239a6 6 0 0 1 0-8.478',
  ],
  substituted: ['M8 3 4 7l4 4', 'M4 7h16', 'm16 21 4-4-4-4', 'M20 17H4'],
  fast: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
};
const MARK_BOX = 26;
const MARK_SIZE = 20;
const MARK_GAP = 10;
const MASK_WIDTH = 96;
const MASK_HEIGHT = 10;

export interface SheetStyle {
  palette: ThemePalette;
  fontSans: string;
  fontMono: string;
}

/** Artwork for a provider mark, or null when there is none to draw. */
export type MarkResolver = (mark: SheetMark) => { url: string; isMono: boolean } | null;

const toneColor = (palette: ThemePalette, tone: SheetTone): string =>
  ({
    fg: palette.fg,
    fg2: palette.fg2,
    muted: palette.muted,
    meta: palette.meta,
    accent: palette.accent,
    success: palette.success,
    danger: palette.danger,
    warn: palette.warn,
  })[tone];

/**
 * Loads an image without tainting the canvas it will be drawn on.
 *
 * The bytes are fetched and wrapped in a same-origin object URL, because one
 * cross-origin logo drawn directly would make the whole canvas unreadable and
 * the export would fail at the last step. A mark that cannot be fetched is left
 * out, and its row is drawn with the neutral box.
 */
async function loadImage(url: string): Promise<HTMLImageElement | null> {
  let objectUrl = '';
  try {
    let source = url;
    if (!url.startsWith('data:')) {
      const response = await fetch(url);
      if (!response.ok) return null;
      objectUrl = URL.createObjectURL(await response.blob());
      source = objectUrl;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    await image.decode();
    return image;
  } catch {
    return null;
  } finally {
    // The decoded bitmap outlives the URL it was read from.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/** A monochrome mark is a silhouette; it is filled with the theme's foreground, as the list draws it. */
function tintMark(image: HTMLImageElement, color: string, ratio: number): HTMLCanvasElement {
  const tinted = document.createElement('canvas');
  tinted.width = tinted.height = Math.ceil(MARK_SIZE * ratio);
  const context = tinted.getContext('2d')!;
  context.drawImage(image, 0, 0, tinted.width, tinted.height);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = color;
  context.fillRect(0, 0, tinted.width, tinted.height);
  return tinted;
}

/** Images already decoded, so toggling a redaction redraws without fetching anything again. */
export type SheetImageCache = Map<string, Promise<HTMLImageElement | null>>;

export function sheetHeight(sheet: RequestSheet): number {
  return BRAND_BAND_HEIGHT + HEADER_HEIGHT + sheet.rows.reduce((sum, row) => sum + row.height, 0);
}

/**
 * paintRequestSheet draws the sheet and resolves once every mark is on it.
 *
 * `isCurrent` is asked after each wait: a redaction toggled while the marks of
 * an older sheet were loading must not have that older sheet painted over it.
 */
export async function paintRequestSheet(
  canvas: HTMLCanvasElement,
  sheet: RequestSheet,
  style: SheetStyle,
  resolveMark: MarkResolver,
  images: SheetImageCache,
  isCurrent: () => boolean,
): Promise<void> {
  const { palette } = style;
  const load = (url: string) => {
    let pending = images.get(url);
    if (!pending) {
      pending = loadImage(url);
      images.set(url, pending);
      // A failed fetch is forgotten, so the next export asks again instead of
      // drawing the neutral box for the rest of the page's life.
      void pending.then((image) => {
        if (!image && images.get(url) === pending) images.delete(url);
      });
    }
    return pending;
  };

  const brandUrl = brandDataUri('wordmark', { ink: palette.fg, accent: palette.accent });
  const marks = new Map<string, { url: string; isMono: boolean }>();
  for (const row of sheet.rows) {
    const mark = row.cells.provider.mark;
    const artwork = mark ? resolveMark(mark) : null;
    if (artwork) marks.set(artwork.url, artwork);
  }
  const [brand] = await Promise.all([load(brandUrl), ...[...marks.keys()].map(load), document.fonts.ready]);
  const loaded = new Map<string, HTMLImageElement | null>();
  for (const url of marks.keys()) loaded.set(url, await load(url));
  if (!isCurrent()) return;

  const height = sheetHeight(sheet);
  const ratio = exportPixelRatio(sheet.width, height);
  canvas.width = Math.round(sheet.width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d')!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.textBaseline = 'middle';

  const font = (size: number, weight: number, isMono = false) =>
    `${weight} ${size}px ${isMono ? style.fontMono : style.fontSans}`;
  const tinted = new Map<string, HTMLCanvasElement>();

  const fillRound = (x: number, y: number, width: number, boxHeight: number, radius: number) => {
    context.beginPath();
    context.roundRect(x, y, width, boxHeight, radius);
    context.fill();
  };
  const strokeRound = (x: number, y: number, width: number, boxHeight: number, radius: number) => {
    context.beginPath();
    context.roundRect(x + 0.5, y + 0.5, width - 1, boxHeight - 1, radius);
    context.stroke();
  };

  /** The longest prefix that fits, closed with an ellipsis, as `text-overflow` would leave it. */
  const fit = (value: string, maxWidth: number): string => {
    if (context.measureText(value).width <= maxWidth) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (context.measureText(`${value.slice(0, middle)}…`).width <= maxWidth) low = middle;
      else high = middle - 1;
    }
    return low > 0 ? `${value.slice(0, low)}…` : '';
  };

  const segmentFont = (segment: SheetSegment): string =>
    segment.kind === 'text'
      ? font(segment.size, segment.weight, segment.isMono)
      : segment.kind === 'tag'
        ? font(10, 600, true)
        : font(11, 600);

  const segmentWidth = (segment: SheetSegment, available: number): number => {
    if (segment.kind === 'mask') return Math.min(MASK_WIDTH, available);
    if (segment.kind === 'glyph') return segment.isBoxed ? GLYPH_BOX : GLYPH_SIZE;
    context.font = segmentFont(segment);
    const textWidth = context.measureText(segment.text).width;
    if (segment.kind === 'tag') return textWidth + 12;
    if (segment.kind === 'pill') return textWidth + 28;
    return textWidth;
  };

  const pillColor = (segment: Extract<SheetSegment, { kind: 'pill' }>): string => {
    if (segment.cacheRate === undefined) return toneColor(palette, segment.tone);
    // The same OKLCH mix the list's badge asks CSS for. An engine that cannot
    // parse it keeps the green end it was given first.
    context.fillStyle = palette.cacheRateGreen;
    const share = Math.min(100, Math.max(0, 100 - segment.cacheRate));
    context.fillStyle = `color-mix(in oklch, ${palette.cacheRateYellow} ${share}%, ${palette.cacheRateGreen})`;
    return String(context.fillStyle);
  };

  const drawSegment = (segment: SheetSegment, x: number, centreY: number, width: number) => {
    if (segment.kind === 'mask') {
      context.globalAlpha = 0.2;
      context.fillStyle = palette.fg;
      fillRound(x, centreY - MASK_HEIGHT / 2, width, MASK_HEIGHT, 2);
      context.globalAlpha = 1;
      return;
    }
    if (segment.kind === 'glyph') {
      const color = toneColor(palette, segment.tone);
      if (segment.isBoxed) {
        context.fillStyle = color;
        context.globalAlpha = 0.1;
        fillRound(x, centreY - GLYPH_BOX / 2, GLYPH_BOX, GLYPH_BOX, 4);
        context.globalAlpha = 1;
      }
      const scale = GLYPH_SIZE / 24;
      context.save();
      context.translate(x + (width - GLYPH_SIZE) / 2, centreY - GLYPH_SIZE / 2);
      context.scale(scale, scale);
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.fillStyle = color;
      for (const path of GLYPH_PATHS[segment.glyph]) {
        const outline = new Path2D(path);
        if (segment.isFilled) context.fill(outline);
        context.stroke(outline);
      }
      context.restore();
      return;
    }
    context.font = segmentFont(segment);
    context.textAlign = 'left';
    if (segment.kind === 'text') {
      context.fillStyle = toneColor(palette, segment.tone);
      context.fillText(fit(segment.text, width), x, centreY);
      return;
    }
    // An effort step below 1 is `none`, which the list also leaves at the neutral tone.
    const color =
      segment.kind === 'pill'
        ? pillColor(segment)
        : (segment.effortStep && palette.effort[segment.effortStep - 1]) || toneColor(palette, segment.tone);
    const boxHeight = segment.kind === 'pill' ? 18 : 15;
    context.fillStyle = color;
    context.strokeStyle = color;
    context.globalAlpha = 0.12;
    fillRound(x, centreY - boxHeight / 2, width, boxHeight, 4);
    context.globalAlpha = 0.3;
    context.lineWidth = 1;
    strokeRound(x, centreY - boxHeight / 2, width, boxHeight, 4);
    context.globalAlpha = 1;
    if (segment.kind === 'pill') {
      fillRound(x + 8, centreY - 3.5, 7, 7, 2);
      context.fillText(segment.text, x + 21, centreY + 0.5);
    } else {
      context.fillText(segment.text, x + 6, centreY + 0.5);
    }
  };

  const drawCell = (cell: SheetCell, column: SheetColumn, top: number, rowHeight: number) => {
    let left = column.x;
    let available = column.width;
    if (cell.mark) {
      const boxTop = top + (rowHeight - MARK_BOX) / 2;
      context.fillStyle = palette.surface;
      fillRound(left, boxTop, MARK_BOX, MARK_BOX, 4);
      context.strokeStyle = palette.borderSoft;
      context.lineWidth = 1;
      strokeRound(left, boxTop, MARK_BOX, MARK_BOX, 4);
      const artwork = resolveMark(cell.mark);
      const image = artwork ? loaded.get(artwork.url) : null;
      if (artwork && image) {
        const inset = (MARK_BOX - MARK_SIZE) / 2;
        let source: CanvasImageSource = image;
        if (artwork.isMono) {
          source = tinted.get(artwork.url) ?? tintMark(image, palette.fg, ratio);
          tinted.set(artwork.url, source as HTMLCanvasElement);
        }
        context.drawImage(source, left + inset, boxTop + inset, MARK_SIZE, MARK_SIZE);
      }
      left += MARK_BOX + MARK_GAP;
      available -= MARK_BOX + MARK_GAP;
    }

    const blockHeight = cell.lines.length * SHEET_LINE_HEIGHT;
    let centreY = top + (rowHeight - blockHeight) / 2 + SHEET_LINE_HEIGHT / 2;
    for (const line of cell.lines) {
      const widths = line.map((segment) => segmentWidth(segment, available));
      const gaps = SEGMENT_GAP * (line.length - 1);
      const overflow = widths.reduce((sum, width) => sum + width, 0) + gaps - available;
      if (overflow > 0) {
        // The first text gives way, as the list's ellipsised name does; tags and pills keep their size.
        const flexible = line.findIndex((segment) => segment.kind === 'text');
        if (flexible >= 0) widths[flexible] = Math.max(0, widths[flexible] - overflow);
      }
      const total = widths.reduce((sum, width) => sum + width, 0) + gaps;
      let x =
        column.align === 'right'
          ? left + available - total
          : column.align === 'center'
            ? left + (available - total) / 2
            : left;
      line.forEach((segment, index) => {
        drawSegment(segment, x, centreY, widths[index]);
        x += widths[index] + SEGMENT_GAP;
      });
      centreY += SHEET_LINE_HEIGHT;
    }
  };

  context.fillStyle = palette.bg;
  context.fillRect(0, 0, sheet.width, height);

  // The band that says where the picture came from.
  if (brand) {
    const drawing = brandDrawing('wordmark');
    const brandWidth = (BRAND_HEIGHT * drawing.width) / drawing.height;
    context.drawImage(brand, PAD_INLINE, (BRAND_BAND_HEIGHT - BRAND_HEIGHT) / 2, brandWidth, BRAND_HEIGHT);
  }
  context.font = font(12, 400);
  context.fillStyle = palette.muted;
  context.textAlign = 'right';
  context.fillText(sheet.caption, sheet.width - PAD_INLINE, BRAND_BAND_HEIGHT / 2);

  context.fillStyle = palette.surface;
  context.fillRect(0, BRAND_BAND_HEIGHT, sheet.width, HEADER_HEIGHT);
  context.fillStyle = palette.border;
  context.fillRect(0, BRAND_BAND_HEIGHT - 1, sheet.width, 1);
  context.fillRect(0, BRAND_BAND_HEIGHT + HEADER_HEIGHT - 1, sheet.width, 1);
  context.font = font(11, 600);
  for (const column of sheet.columns) {
    context.fillStyle = palette.muted;
    context.textAlign = column.align;
    const anchor =
      column.align === 'right' ? column.x + column.width : column.align === 'center' ? column.x + column.width / 2 : column.x;
    context.fillText(fit(column.label, column.width), anchor, BRAND_BAND_HEIGHT + HEADER_HEIGHT / 2);
  }

  let top = BRAND_BAND_HEIGHT + HEADER_HEIGHT;
  sheet.rows.forEach((row, index) => {
    for (const column of sheet.columns) drawCell(row.cells[column.id], column, top, row.height);
    top += row.height;
    if (index < sheet.rows.length - 1) {
      context.fillStyle = palette.borderSoft;
      context.fillRect(0, top - 1, sheet.width, 1);
    }
  });

  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.strokeRect(0.5, 0.5, sheet.width - 1, height - 1);
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the sheet produced no image'))), 'image/png');
  });
}
