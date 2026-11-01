import { formatCurrency, type DisplayCurrency } from '../../types/currencyDisplay';
import type { MessageKey, TFunc } from '../../i18n/catalog';
import { formatCacheRate } from '../../theme/cacheScale';
import { effortBadgeName, effortStep } from '../../theme/effortScale';
import { modelMarkIconId } from '../../types/modelSquare';
import type { BrandMark } from '../../types/brandMark';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { TokenNumberStyle } from '../../types/tokenDisplay';
import { formatTokens } from '../../types/tokenDisplay';
import {
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../../types/usageEventIdentity';
import { eventKeyLabel, eventResultLabelKey, eventUserAgentLabel } from '../../types/usageEventLabels';
import {
  eventCacheRate,
  eventTokensPerSecond,
  formatEventDuration,
  hasMeasurableTTFT,
  isFastTierEvent,
  latencyTone,
  requestTransport,
} from '../../types/usageEventMetrics';
import type { TpsCalculationMode } from '../../types/tpsCalculation';
import type { UsageEvent } from '../../types/usageEvents';
import { maskKeyText } from '../../utils/maskKey';
import {
  REQUEST_COLUMNS,
  REQUEST_GRID_GAP,
  REQUEST_PAD_INLINE,
  type RequestColumnId,
  type RequestColumnWidths,
} from './requestColumns';
import type { RequestMaskId } from './requestSelection';
import { formatRequestTimestamp } from './requestTimestamp';

/**
 * The exported sheet as data: every string and mark the image will carry, laid
 * out in columns, before anything is drawn.
 *
 * The sheet is built here and painted elsewhere for two reasons. Redaction is
 * decided in this module, so a redacted value never reaches the painter at all
 * and "the image cannot contain it" is a property a test can assert on plain
 * data. And painting from data is what keeps a hundred rows instant: there is
 * no document to clone and no style to compute.
 */

export type SheetTone = 'fg' | 'fg2' | 'muted' | 'meta' | 'accent' | 'success' | 'danger' | 'warn' | 'slow';

/** The glyphs a cell uses where the list uses an icon: a marker a reader already knows from the list. */
export type SheetGlyph = 'non_stream' | 'websocket' | 'substituted' | 'routed' | 'fast' | 'model' | 'reasoning';

export type SheetSegment =
  /** Plain text. The first text segment of a line is the one that gives way when the line is too long. */
  | { kind: 'text'; text: string; tone: SheetTone; size: number; weight: 400 | 500 | 600; isMono?: boolean }
  /**
   * A small filled tag: OAuth, a reasoning effort, a preflight. A neutral tone is a wash of the
   * ink, a hued one a tint of its hue. An effort that ranks on the reasoning-effort scale names
   * its step, which outranks the tone.
   */
  | { kind: 'tag'; text: string; tone: SheetTone; effortStep?: number }
  /**
   * A reading led by a round dot: the result, and the cache rate. A washed reading is drawn on a
   * tint of its tone, the way the list sets a failure apart; otherwise only the dot carries the hue
   * unless the word is given a tone of its own.
   */
  | { kind: 'dot'; text: string; tone: SheetTone; textTone?: SheetTone; isWashed?: boolean; cacheRate?: number }
  /** One of the list's own glyphs, boxed when the list draws it as a badge and filled when the list fills it. */
  | { kind: 'glyph'; glyph: SheetGlyph; tone: SheetTone; isBoxed?: boolean; isFilled?: boolean }
  /** A brand mark drawn inline at the text's size: the model's maker. */
  | { kind: 'mark'; mark: SheetMark }
  /** A redaction bar. It carries nothing of the value it stands in for. */
  | { kind: 'mask' };

export type SheetLine = SheetSegment[];

export type SheetMark = BrandMark;

export interface SheetCell {
  /** The provider's mark, drawn on a tile before the cell's lines. */
  mark?: SheetMark;
  lines: SheetLine[];
}

export interface SheetColumn {
  id: RequestColumnId;
  label: string;
  align: 'left' | 'right' | 'center';
  /** Left edge and width in CSS pixels, gaps and padding already applied. */
  x: number;
  width: number;
}

export interface SheetRow {
  height: number;
  cells: Record<RequestColumnId, SheetCell>;
}

export interface RequestSheet {
  width: number;
  caption: string;
  columns: SheetColumn[];
  rows: SheetRow[];
}

/**
 * The narrowest sheet. The list's own floor leaves the flexible columns at
 * their minimum, which truncates most provider and model names; a picture has
 * no column to drag wider, so it starts with room for them.
 */
export const SHEET_MIN_WIDTH = 1480;

export const SHEET_LINE_HEIGHT = 18;
const ROW_MIN_HEIGHT = 72;
const ROW_PAD_BLOCK = 28;

/**
 * resolveSheetColumns turns the list's track definitions into pixel columns the
 * way CSS grid would: a dragged width is taken as it is, a rigid track takes its
 * default, and the flexible tracks share what is left in proportion to their
 * weight, none going below its own minimum.
 */
export function resolveSheetColumns(
  widths: RequestColumnWidths,
  label: (labelKey: MessageKey) => string,
): { columns: SheetColumn[]; width: number } {
  const fixed = REQUEST_COLUMNS.map((column) => {
    const manual = widths[column.id];
    if (manual !== undefined && Number.isFinite(manual)) {
      return Math.round(Math.min(column.maxWidth, Math.max(column.minWidth, manual)));
    }
    return column.flexGrow > 0 ? null : column.defaultWidth;
  });
  const chrome = REQUEST_PAD_INLINE * 2 + REQUEST_GRID_GAP * (REQUEST_COLUMNS.length - 1);
  const rigid = fixed.reduce<number>((sum, width) => sum + (width ?? 0), 0);
  const flexible = REQUEST_COLUMNS.filter((_, index) => fixed[index] === null);
  const flexMinimum = flexible.reduce((sum, column) => sum + column.minWidth, 0);
  const width = Math.max(SHEET_MIN_WIDTH, chrome + rigid + flexMinimum);
  const weight = flexible.reduce((sum, column) => sum + column.flexGrow, 0);
  const spare = width - chrome - rigid - flexMinimum;

  let x = REQUEST_PAD_INLINE;
  const columns = REQUEST_COLUMNS.map((column, index) => {
    const columnWidth = fixed[index] ?? column.minWidth + Math.floor((spare * column.flexGrow) / weight);
    const resolved: SheetColumn = {
      id: column.id,
      label: label(column.labelKey),
      align: column.align,
      x,
      width: columnWidth,
    };
    x += columnWidth + REQUEST_GRID_GAP;
    return resolved;
  });
  return { columns, width };
}

export interface RequestSheetInput {
  currency?: DisplayCurrency;
  rows: readonly UsageEvent[];
  masks: ReadonlySet<RequestMaskId>;
  colWidths: RequestColumnWidths;
  caption: string;
  t: TFunc;
  tokenStyle: TokenNumberStyle;
  tpsMode: TpsCalculationMode;
  modelView?: 'call' | 'model';
  /** The list's own preference: when it draws model marks, so does the picture. */
  showModelIcons?: boolean;
  credentials: CredentialIndex;
  providerIcons?: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  pluginLogos?: PluginOAuthLogos;
  /** The provider catalog read has not settled, so a resolved name is a placeholder for now. */
  isProviderCatalogUnknown?: boolean;
}

const MASK_LINE: SheetLine = [{ kind: 'mask' }];
const MASKED_CELL: SheetCell = { lines: [MASK_LINE] };

const text = (
  value: string,
  tone: SheetTone,
  size: number,
  weight: 400 | 500 | 600 = 400,
  isMono = false,
): SheetSegment => ({ kind: 'text', text: value, tone, size, weight, isMono });


/** buildRequestSheet lays the selected records out as the sheet the painter draws. */
export function buildRequestSheet(input: RequestSheetInput): RequestSheet {
  const { t, masks } = input;
  const { columns, width } = resolveSheetColumns(input.colWidths, (labelKey) => t(labelKey));

  const rows = input.rows.map((event): SheetRow => {
    const provider = resolveProviderInfo(
      event,
      input.credentials,
      input.providerIcons,
      input.configuredProviders,
      input.pluginLogos,
      input.isProviderCatalogUnknown,
    );
    const providerKeyMask = provider.isOAuth ? '' : maskKeyText(event.provider_key_mask);
    const cache = eventCacheRate(event.tokens);
    const latencyBand = latencyTone(event.latency_ms);
    const tps = eventTokensPerSecond(event, input.tpsMode);
    const isCallView = input.modelView === 'call';
    const displayModel = isCallView ? event.model_alias || event.model : event.model;
    const transport = requestTransport(event);
    const modelIcon = displayModel ? modelMarkIconId(displayModel, event.model) : undefined;
    const modelMark: SheetSegment = modelIcon
      ? { kind: 'mark', mark: { iconId: modelIcon } }
      : { kind: 'glyph', glyph: 'model', tone: 'muted' };

    const cells: Record<RequestColumnId, SheetCell> = {
      time: {
        lines: [
          [text(formatRequestTimestamp(event.timestamp_ms).shortTime, 'fg', 12, 500)],
          masks.has('request_id')
            ? MASK_LINE
            : [text(event.request_id || t('events.no_request_id'), 'muted', 11, 400, true)],
        ],
      },
      result: {
        lines: [[
          event.failed
            ? { kind: 'dot', text: t(eventResultLabelKey(event)), tone: 'danger', isWashed: true }
            : { kind: 'dot', text: t(eventResultLabelKey(event)), tone: 'success', textTone: 'fg2' },
        ]],
      },
      provider: {
        mark: { iconId: provider.iconId, logo: provider.logo, fallbackIconId: provider.fallbackIconId, providerKeys: provider.providerKeys },
        lines: [
          [
            text(provider.title, 'fg', 13, 500),
            ...(provider.isOAuth ? [{ kind: 'tag', text: 'OAuth', tone: 'fg2' } as const] : []),
          ],
          // The credential line: an OAuth account - usually an address - or the
          // masked key. Each has its own mask; the provider's name always stays.
          // An unredacted sheet is the operator's explicit disclosure, so it prints
          // the account itself rather than the screen's mask.
          ...(provider.isOAuth && provider.credential
            ? [masks.has('provider_account') ? MASK_LINE : [text(provider.accountIdentity ?? provider.credential, 'muted', 11)]]
            : []),
          ...(providerKeyMask
            ? [masks.has('provider_key') ? MASK_LINE : [text(providerKeyMask, 'muted', 11)]]
            : []),
        ],
      },
      model: {
        lines: [
          [
            ...(input.showModelIcons ? [modelMark] : []),
            text(displayModel || t('events.not_captured'), 'fg', 13, 500),
            ...(!event.generate ? [{ kind: 'tag', text: t('events.preflight'), tone: 'muted' } as const] : []),
          ],
          // A substitution outranks the routed upstream, as it does on the list's second line.
          ...(event.model_substituted && event.response_model
            ? [[{ kind: 'glyph', glyph: 'substituted', tone: 'warn' } as const, text(event.response_model, 'warn', 11)]]
            : isCallView && displayModel !== event.model && event.model
              ? [[{ kind: 'glyph', glyph: 'routed', tone: 'fg2' } as const, text(event.model, 'fg2', 11)]]
              : []),
        ],
      },
      mode: {
        lines: [
          event.reasoning_effort || isFastTierEvent(event) || transport === 'websocket' || transport === 'http'
            ? [
                ...(event.reasoning_effort
                  ? [{ kind: 'tag', text: effortBadgeName(event.reasoning_effort), tone: 'fg2', effortStep: effortStep(event.reasoning_effort) ?? undefined } as const]
                  : []),
                ...(isFastTierEvent(event)
                  ? [{ kind: 'glyph', glyph: 'fast', tone: 'accent', isBoxed: true, isFilled: true } as const]
                  : []),
                ...(transport === 'websocket'
                  ? [{ kind: 'glyph', glyph: 'websocket', tone: 'muted', isBoxed: true } as const]
                  : []),
                ...(transport === 'http'
                  ? [{ kind: 'glyph', glyph: 'non_stream', tone: 'muted', isBoxed: true } as const]
                  : []),
              ]
            : [text('—', 'muted', 12)],
        ],
      },
      latency: {
        lines: [
          // The total keeps the list's latency band; TTFT is detail, and stays muted.
          [
            text(
              formatEventDuration(event.latency_ms),
              latencyBand === 'neutral' ? 'fg' : latencyBand,
              13,
              500,
            ),
          ],
          ...(hasMeasurableTTFT(event)
            ? [[text(`TTFT ${formatEventDuration(event.ttft_ms)}`, 'muted', 11)]]
            : []),
        ],
      },
      tps: { lines: [[tps.basis === null ? text('—', 'muted', 12) : text(tps.formatted, 'fg', 13, 500)]] },
      tokens: {
        lines: [
          [
            text(formatTokens(event.tokens.total, input.tokenStyle), 'fg', 13, 500),
            text('tokens', 'muted', 11),
          ],
          [
            text(`↑ ${formatTokens(event.tokens.input, input.tokenStyle)}`, 'muted', 11),
            text(`↓ ${formatTokens(event.tokens.output, input.tokenStyle)}`, 'muted', 11),
            ...(event.tokens.reasoning > 0
              ? [
                  { kind: 'glyph', glyph: 'reasoning', tone: 'muted' } as const,
                  text(formatTokens(event.tokens.reasoning, input.tokenStyle), 'muted', 11),
                ]
              : []),
          ],
        ],
      },
      cost: {
        lines: [
          [
            event.cost_usd != null
              ? text(formatCurrency(event.cost_usd, input.currency), 'fg', 13, 500)
              : text('—', 'muted', 13),
          ],
        ],
      },
      cache: {
        lines: [
          [
            cache.hasData
              ? { kind: 'dot', text: formatCacheRate(cache.rate), tone: 'success', cacheRate: cache.rate }
              : { kind: 'dot', text: '—', tone: 'muted' },
          ],
        ],
      },
      key: { lines: [[text(eventKeyLabel(event), 'fg2', 12, 500)]] },
      ua: { lines: [[text(eventUserAgentLabel(event), 'muted', 11)]] },
    };

    for (const column of REQUEST_COLUMNS) {
      if (masks.has(column.id)) cells[column.id] = MASKED_CELL;
    }
    const lineCount = Math.max(...REQUEST_COLUMNS.map((column) => cells[column.id].lines.length));
    return { height: Math.max(ROW_MIN_HEIGHT, lineCount * SHEET_LINE_HEIGHT + ROW_PAD_BLOCK), cells };
  });

  return { width, caption: input.caption, columns, rows };
}

/** Every string the sheet will draw, for asserting what an image can and cannot contain. */
export function sheetStrings(sheet: RequestSheet): string[] {
  const strings = [sheet.caption, ...sheet.columns.map((column) => column.label)];
  for (const row of sheet.rows) {
    for (const column of sheet.columns) {
      for (const line of row.cells[column.id].lines) {
        for (const segment of line) {
          if (segment.kind !== 'mask' && segment.kind !== 'glyph' && segment.kind !== 'mark') strings.push(segment.text);
        }
      }
    }
  }
  return strings;
}
