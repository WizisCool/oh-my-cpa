import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from 'antd';
import { Tooltip } from '../../common/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { useCustomIcons } from '../../../hooks/useCustomIcons';
import { useT } from '../../../i18n';
import { decodeInsightsCube } from '../../../types/insightsCube';
import { formatChange, formatLatency } from '../../../types/insightsFormat';
import { useInsightsLabels } from '../../../hooks/useInsightsLabels';
import { useSwrQuery } from '../../../performance/swrContract';
import { resolveMarkArtworks } from '../../../types/brandMark';
import { isCalendarPreset } from '../../../types/calendarPresets';
import { useDisplayCurrency } from '../../../types/CurrencyDisplayContext';
import { formatCurrency } from '../../../types/currencyDisplay';
import { dashboardRangeParams, type DashboardRange, type DashboardResponse } from '../../../types/dashboard';
import { modelMarkIconId } from '../../../types/modelSquare';
import { formatTokens } from '../../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import dayjs, { formatTimeZoneOffset } from '../../../utils/time';
import { isMotionReduced } from '../../../utils/motionPreference';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { ToolButton } from '../../common/ToolButton';
import { useToast } from '../../feedback';
import { CloseOutlined, CopyOutlined, DownloadOutlined } from '../../icons';
import { canCopyImage, copyImage, downloadBlob } from '../../usage/requestExportImage';
import { dashboardWindowSwr } from '../dashboardQueries';
import { dashboardPresetLabel } from '../TimeRangeControl';
import { buildReceiptLedger, isReceiptFinal, receiptCubeParams, type ReceiptAmount, type ReceiptLedger } from './receiptModel';
import { ReceiptPaper, type ReceiptMarkSource, type ReceiptRow, type ReceiptSheet } from './ReceiptPaper';
import { receiptImage } from './receiptImage';
import { RECEIPT_CSS } from './receiptStyles';
import './ReceiptShowcase.css';

export interface ReceiptShowcaseProps {
  /** The dashboard's window, which the receipt opens on. */
  range: DashboardRange;
  /** The key the dashboard is filtered by, and the name it is shown under. */
  keyFilter?: { id: string; label: string };
  onClose: () => void;
}

const COUNT = new Intl.NumberFormat('en');
const STAMP = 'YYYY-MM-DD HH:mm';
const EXIT_MS = 120;
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Reads each model's mark once, as a data URI, so the exported picture carries it without a fetch. */
function useReceiptMarks(models: readonly string[]): ReadonlyMap<string, ReceiptMarkSource> {
  const { data: customIcons } = useCustomIcons();
  const cache = React.useRef(new Map<string, Promise<ReceiptMarkSource | undefined>>());
  const [marks, setMarks] = React.useState<ReadonlyMap<string, ReceiptMarkSource>>(new Map());
  const key = models.join('\n');
  React.useEffect(() => {
    let isCurrent = true;
    const read = async (model: string): Promise<ReceiptMarkSource | undefined> => {
      const iconId = modelMarkIconId(model, model);
      if (!iconId) return undefined;
      const artworks = resolveMarkArtworks({ iconId }, { baseURL: import.meta.env.BASE_URL, customIconURL: api.customIconURL, customIcons });
      for (const artwork of artworks) {
        try {
          const response = await fetch(artwork.url);
          if (!response.ok) continue;
          const blob = await response.blob();
          const src = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          return { src, isMono: artwork.isMono };
        } catch {
          // The next candidate, or the neutral dot.
        }
      }
      return undefined;
    };
    void Promise.all(models.map(async (model) => {
      let pending = cache.current.get(model);
      if (!pending) {
        pending = read(model);
        cache.current.set(model, pending);
      }
      return [model, await pending] as const;
    })).then((entries) => {
      if (!isCurrent) return;
      const next = new Map<string, ReceiptMarkSource>();
      for (const [model, source] of entries) if (source) next.set(model, source);
      setMarks(next);
    });
    return () => {
      isCurrent = false;
    };
    // `key` stands for the model list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, customIcons]);
  return marks;
}

/**
 * The receipt for the dashboard's window, shown on its own over a softened dashboard: it feeds out
 * of a printer's mouth, which lifts away once the slip is out; its two actions - copy and export
 * the picture - then come up under the paper, and closing sits at the stage's corner.
 *
 * It is a stage rather than a dialog. The receipt is the thing being looked at, so it is not framed
 * by a dialog's chrome; the actions belong to the paper and arrive and leave with it.
 */
export default function ReceiptShowcase({ range, keyFilter, onClose }: ReceiptShowcaseProps) {
  const t = useT();
  const toast = useToast();
  const zone = useTimeZone();
  const { currency } = useDisplayCurrency();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const [isLeaving, setIsLeaving] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<'copy' | 'download' | null>(null);
  const [issuedAt] = React.useState(() => Date.now());
  const paperRef = React.useRef<HTMLElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const close = React.useCallback(() => {
    if (isLeaving) return;
    setIsLeaving(true);
    window.setTimeout(onClose, isMotionReduced() ? 0 : EXIT_MS);
  }, [isLeaving, onClose]);
  const closeRef = React.useRef(close);
  React.useLayoutEffect(() => {
    closeRef.current = close;
  }, [close]);

  // Modal for as long as it is open: focus moves in, Tab cycles within, and the control that opened
  // it takes focus back once it has gone.
  React.useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current;
    root?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !root) return;
      const stops = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey ? active === first || active === root || !root.contains(active) : active === last || !root.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, []);

  const rangeQuery = dashboardRangeParams(range);
  const query = keyFilter ? `${rangeQuery}&api_key=${encodeURIComponent(keyFilter.id)}` : rangeQuery;
  const dashboard = useSwrQuery(dashboardWindowSwr, query, { refetchInterval: false, refetchOnWindowFocus: false });
  const data: DashboardResponse | undefined = dashboard.data;
  // A failed refresh keeps the last figures in hand; they are not this receipt's.
  const isCurrentData = Boolean(data) && !dashboard.isPlaceholderData && !dashboard.isError;

  const cubeParams = data && isCurrentData ? receiptCubeParams(range, data.window) : '';
  const cubeQuery = useQuery({
    queryKey: ['dashboard-receipt-cube', cubeParams],
    queryFn: () => api.getInsightsCube(cubeParams),
    enabled: Boolean(cubeParams),
    staleTime: 30_000,
    select: decodeInsightsCube,
  });
  const cube = cubeQuery.data;
  const labels = useInsightsLabels(cube);
  const ledger = React.useMemo(() => (cube && cubeParams ? buildReceiptLedger(cube, keyFilter?.id) : undefined), [cube, cubeParams, keyFilter?.id]);
  const models = React.useMemo(() => [...new Set((ledger?.keys ?? []).flatMap((line) => line.models.map((model) => model.model)))].sort(), [ledger]);
  const marks = useReceiptMarks(models);

  const sheet = React.useMemo<ReceiptSheet | undefined>(() => {
    if (!data) return undefined;
    return buildSheet({
      data, range, ledger, labels, isCubeError: cubeQuery.isError, issuedAt, zone, keyLabel: keyFilter?.label,
      t, money: (usd) => formatCurrency(usd, currency), tokens: (value) => formatTokens(value, tokenStyle), currencyCode: currency.code,
    });
  }, [data, range, ledger, labels, cubeQuery.isError, issuedAt, zone, keyFilter?.label, t, currency, tokenStyle]);

  const isReady = Boolean(sheet && ledger && isCurrentData);
  // The paper is printed once, when everything it prints is in hand, so it never grows after it is out.
  const isPrintable = Boolean(sheet && isCurrentData && (ledger || cubeQuery.isError));
  const [isPrinted, setIsPrinted] = React.useState(false);
  if (isPrintable && !isPrinted) setIsPrinted(true);
  // The stage holds still until the slip is let go: scrolled mid-print, the paper would run on
  // under a printer that had moved away from it.
  const [isSettled, setIsSettled] = React.useState(isMotionReduced);
  const hasFailed = dashboard.isError && !isPrinted;
  React.useEffect(() => {
    if (!hasFailed) return;
    toast.error(t('dash.receipt.load_failed'), { error: dashboard.error });
    closeRef.current();
  }, [hasFailed, dashboard.error, t, toast]);
  const canCopy = canCopyImage();
  const produce = async (action: 'copy' | 'download') => {
    const paper = paperRef.current;
    if (!paper || !isReady || pendingAction) return;
    setPendingAction(action);
    try {
      const image = await receiptImage(paper);
      if (action === 'copy') {
        await copyImage(image);
        toast.success(t('dash.receipt.copied'));
      } else {
        const day = dayjs(data!.window.from).format('YYYYMMDD');
        downloadBlob(image, `omc-receipt-${range.preset ?? 'custom'}-${day}.png`);
      }
    } catch (error) {
      toast.error(t('dash.receipt.export_failed'), { error });
    } finally {
      setPendingAction(null);
    }
  };

  return createPortal(
    <div
      ref={rootRef}
      className={`receipt-showcase${isLeaving ? ' is-leaving' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('dash.receipt.dialog_title')}
      tabIndex={-1}
    >
      <style>{RECEIPT_CSS}</style>
      <div className="receipt-showcase-backdrop" onClick={close} />
      {/* Close belongs to the stage, not the paper, so the paper's two actions stay centred under it. */}
      <ToolButton className="receipt-showcase-close" icon={<CloseOutlined />} label={t('common.close')} onClick={close} data-testid="receipt-close" />
      <div className={`receipt-showcase-scroll${isSettled ? '' : ' is-printing'}`} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div className="receipt-showcase-stage">
          <div className={`receipt-showcase-printer${isPrinted ? ' is-printing' : ''}`} aria-hidden="true">
            <span className="receipt-showcase-printer-mouth" />
            <span className="receipt-showcase-printer-led" />
          </div>
          <div className="receipt-showcase-feed">
            {isPrinted && sheet && (
              <div
                className={`receipt-showcase-paper${isCurrentData ? '' : ' is-loading'}`}
                onAnimationEnd={(event) => {
                  if (event.target === event.currentTarget && event.animationName === 'receipt-release') setIsSettled(true);
                }}
              >
                <ReceiptPaper ref={paperRef} sheet={sheet} marks={marks} />
              </div>
            )}
          </div>
          {isPrinted && (
            <div className="receipt-showcase-actions" role="toolbar" aria-label={t('dash.receipt.dialog_title')}>
              {/* The clipboard takes images only on a secure page; elsewhere the action stays in view, disabled, and says why. */}
              <Tooltip title={canCopy ? undefined : t('dash.receipt.copy_unavailable')}>
                <Button
                  block
                  icon={<CopyOutlined />}
                  loading={pendingAction === 'copy'}
                  disabled={!canCopy || !isReady || pendingAction === 'download'}
                  onClick={() => void produce('copy')}
                  data-testid="receipt-copy"
                >
                  {t('dash.receipt.copy')}
                </Button>
              </Tooltip>
              <Button
                block
                type="primary"
                icon={<DownloadOutlined />}
                loading={pendingAction === 'download'}
                disabled={!isReady || pendingAction === 'copy'}
                onClick={() => void produce('download')}
                data-testid="receipt-download"
              >
                {t('dash.receipt.download')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface SheetInput {
  data: DashboardResponse;
  range: DashboardRange;
  ledger: ReceiptLedger | undefined;
  labels: ReturnType<typeof useInsightsLabels>;
  isCubeError: boolean;
  issuedAt: number;
  zone: string;
  keyLabel?: string;
  t: ReturnType<typeof useT>;
  money: (usd: number) => string;
  tokens: (value: number) => string;
  currencyCode: string;
}

/** Words the receipt: the dashboard's figures for the headline, the ledger for the lines. */
function buildSheet({ data, range, ledger, labels, isCubeError, issuedAt, zone, keyLabel, t, money, tokens: formatTokenCount, currencyCode }: SheetInput): ReceiptSheet {
  const { window, requests, tokens, metrics } = data;
  const isFinal = isReceiptFinal(range);
  const amount = (line: ReceiptAmount) => (line.costedRequests > 0 ? money(line.costNanos / 1e9) : '—');
  // The server reports both rates as percentages already.
  const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`);

  const title = isCalendarPreset(range.preset)
    ? t(`dash.receipt.title_${range.preset}`)
    : range.preset
      ? t('dash.receipt.title_span', { period: dashboardPresetLabel(t, range.preset) })
      : t('dash.receipt.title');
  const span = `${dayjs(window.from).format(STAMP)} – ${isFinal ? dayjs(window.to).format(STAMP) : t('dash.range.until_now')}`;

  const meta: ReceiptRow[] = [
    { label: t('dash.receipt.period'), value: span },
    { label: t('dash.receipt.issued'), value: dayjs(issuedAt).format(STAMP) },
    { label: t('dash.receipt.timezone'), value: `${zone} ${formatTimeZoneOffset(zone)}` },
  ];
  if (keyLabel) meta.push({ label: t('dash.receipt.key'), value: keyLabel });

  const summary: ReceiptRow[] = [
    { label: t('dash.receipt.requests'), value: COUNT.format(requests.total) },
    { label: t('dash.receipt.success_rate'), value: percent(requests.success_rate) },
    { label: t('dash.receipt.failures'), value: COUNT.format(requests.failed), tone: requests.failed > 0 ? undefined : 'muted' },
  ];
  const change = ledger?.costChange;
  if (change?.kind === 'change') {
    summary.push({
      label: t('dash.receipt.vs_previous'),
      value: formatChange(change.change) ?? '—',
      tone: change.isNoise ? 'muted' : change.change > 0 ? 'up' : 'down',
    });
  } else if (change?.kind === 'new') {
    summary.push({ label: t('dash.receipt.vs_previous'), value: t('dash.receipt.new') });
  }
  if (requests.total > 0 && metrics.cost > 0) summary.push({ label: t('dash.receipt.per_request'), value: money(metrics.cost / requests.total) });
  if (metrics.avg_latency_ms !== null) summary.push({ label: t('dash.receipt.latency'), value: formatLatency(metrics.avg_latency_ms) });
  if (metrics.avg_ttft_ms !== null) summary.push({ label: t('dash.receipt.ttft'), value: formatLatency(metrics.avg_ttft_ms) });

  const groups: ReceiptSheet['groups'] = (ledger?.keys ?? []).map((line) => ({
    label: labels.label('key', line.key),
    detail: labels.detail('key', line.key),
    qty: COUNT.format(line.requests),
    amount: amount(line),
    lines: [
      ...line.models.map((model) => ({ label: model.model, model: model.model, qty: COUNT.format(model.requests), amount: amount(model) })),
      ...(line.otherModels
        ? [{ label: t('dash.receipt.other_models', { n: line.otherModels.count }), qty: COUNT.format(line.otherModels.requests), amount: amount(line.otherModels), isMuted: true }]
        : []),
    ],
  }));
  if (ledger?.otherKeys) {
    groups.push({
      label: t('dash.receipt.other_keys', { n: ledger.otherKeys.count }),
      qty: COUNT.format(ledger.otherKeys.requests),
      amount: amount(ledger.otherKeys),
      lines: [],
      isMuted: true,
    });
  }
  const placeholder = isCubeError
    ? t('dash.receipt.items_unavailable')
    : !ledger
      ? '· · ·'
      : groups.length === 0 ? t('dash.receipt.items_empty') : undefined;

  const tokenRows: ReceiptRow[] = [
    { label: t('dash.receipt.tokens_total'), value: formatTokenCount(tokens.total) },
    { label: t('dash.receipt.tokens_input'), value: formatTokenCount(tokens.input) },
    { label: t('dash.receipt.tokens_output'), value: formatTokenCount(tokens.output) },
  ];
  if (tokens.reasoning > 0) tokenRows.push({ label: t('dash.receipt.tokens_reasoning'), value: formatTokenCount(tokens.reasoning) });
  if (tokens.cache_read > 0) tokenRows.push({ label: t('dash.receipt.tokens_cache_read'), value: formatTokenCount(tokens.cache_read) });
  tokenRows.push({ label: t('dash.receipt.cache_rate'), value: percent(metrics.cache_rate) });

  const notes: string[] = [];
  const unpriced = ledger ? ledger.current.requests - ledger.current.costedRequests : 0;
  if (unpriced > 0) notes.push(t('dash.receipt.unpriced', { n: COUNT.format(unpriced) }));

  return {
    title,
    tagline: t('dash.receipt.tagline'),
    meta,
    totalLabel: t('dash.receipt.total'),
    total: money(metrics.cost),
    totalNote: t('dash.receipt.price_basis', { currency: currencyCode }),
    summary,
    itemsHeader: [t('dash.receipt.items_name'), t('dash.receipt.items_qty'), t('dash.receipt.items_amount')],
    groups,
    placeholder,
    tokens: tokenRows,
    notes,
  };
}
