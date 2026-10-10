import React from 'react';
import { Button, Checkbox, Modal, Segmented, Select } from 'antd';

import { useCustomIcons } from '../../hooks/useCustomIcons';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useT } from '../../i18n';
import { useTheme } from '../../theme/ThemeContext';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import type { CredentialIndex, ProviderLookupEntry } from '../../types/usageEventIdentity';
import type { UsageEvent } from '../../types/usageEvents';
import { copyText } from '../../utils/clipboard';
import dayjs from '../../utils/time';
import { Notice, useToast } from '../feedback';
import { CodeOutlined, CopyOutlined, DownloadOutlined, PictureOutlined } from '../icons';
import { getProviderDefaultIcon, resolveMarkArtwork } from '../LobeIcon';
import { REQUEST_COLUMNS, type RequestColumnId, type RequestColumnWidths } from './requestColumns';
import { canCopyImage, copyImage, downloadBlob } from './requestExportImage';
import { buildRequestExport } from './requestExportJson';
import {
  DEFAULT_SENSITIVE_DETAILS,
  EXPORT_ROW_LIMIT,
  SENSITIVE_DETAILS,
  effectiveMasks,
  exportRows,
  type SensitiveDetail,
} from './requestSelection';
import { buildRequestSheet } from './requestSheetModel';
import { canvasToPng, paintRequestSheet, type SheetImageCache } from './requestSheetPainter';

export interface RequestExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Every selected record, across the pages it was picked from. */
  selection: ReadonlyMap<number, UsageEvent>;
  colWidths: RequestColumnWidths;
  credentials: CredentialIndex;
  providerIcons: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  pluginLogos: PluginOAuthLogos;
}

type ExportFormat = 'image' | 'json';

/** How many records the JSON preview prints; the file holds all of them. */
const JSON_PREVIEW_ROWS = 2;

/**
 * Exports the selected requests, as one image to show people or as JSON for a
 * program to analyse.
 *
 * Either way the export leaves the console for readers who should not learn
 * whose account or key it was - so the identifying details are withheld by
 * default and by name, whole columns only on request, and one set of choices
 * governs both formats. A withheld value is left out of the sheet or the
 * document before it is produced, not covered afterwards. The image's preview
 * is the canvas that is saved, so what the operator checks is what is shared.
 */
export const RequestExportDialog: React.FC<RequestExportDialogProps> = ({
  open,
  onClose,
  selection,
  colWidths,
  credentials,
  providerIcons,
  configuredProviders,
  pluginLogos,
}) => {
  const t = useT();
  const toast = useToast();
  const { theme } = useTheme();
  const { style: tokenStyle, tpsMode, modelView } = useTokenDisplayStyle();
  const customIcons = useCustomIcons(open).data;
  useOverlayHistory({ isOpen: open, onClose });

  const [canvas, setCanvas] = React.useState<HTMLCanvasElement | null>(null);
  const imagesRef = React.useRef<SheetImageCache>(new Map());
  const paintRef = React.useRef(0);
  const [format, setFormat] = React.useState<ExportFormat>('image');
  const [details, setDetails] = React.useState<SensitiveDetail[]>([...DEFAULT_SENSITIVE_DETAILS]);
  const [maskedWholeColumns, setMaskedWholeColumns] = React.useState<RequestColumnId[]>([]);
  const [isPainted, setIsPainted] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<'download' | 'copy' | null>(null);
  const isImage = format === 'image';

  const rows = React.useMemo(() => exportRows(selection), [selection]);
  const masks = React.useMemo(() => effectiveMasks(details, maskedWholeColumns), [details, maskedWholeColumns]);
  const sheet = React.useMemo(
    () =>
      open && isImage
        ? buildRequestSheet({
            rows,
            masks,
            colWidths,
            caption: t('events.export_caption', { n: rows.length, time: dayjs().format('YYYY-MM-DD HH:mm') }),
            t,
            tokenStyle,
            tpsMode,
            modelView,
            credentials,
            providerIcons,
            configuredProviders,
            pluginLogos,
            resolveDefaultIcon: getProviderDefaultIcon,
          })
        : null,
    [
      open, isImage, rows, masks, colWidths, t, tokenStyle, tpsMode, modelView,
      credentials, providerIcons, configuredProviders, pluginLogos,
    ],
  );
  // A program has no use for the image's row cap, so the document holds the whole selection.
  const exportDocument = React.useMemo(
    () =>
      open && !isImage
        ? buildRequestExport({
            rows: exportRows(selection, Number.POSITIVE_INFINITY),
            masks,
            exportedAt: new Date(),
            tpsMode,
            credentials,
            configuredProviders,
            pluginLogos,
          })
        : null,
    [open, isImage, selection, masks, tpsMode, credentials, configuredProviders, pluginLogos],
  );
  const jsonPreview = React.useMemo(
    () =>
      exportDocument
        ? JSON.stringify(
            { ...exportDocument, requests: exportDocument.requests.slice(0, JSON_PREVIEW_ROWS) },
            null,
            2,
          )
        : '',
    [exportDocument],
  );

  React.useEffect(() => {
    if (!canvas || !sheet) return undefined;
    const paint = (paintRef.current += 1);
    const computed = window.getComputedStyle(document.body);
    setIsPainted(false);
    void paintRequestSheet(
      canvas,
      sheet,
      {
        palette: theme.palette,
        fontSans: computed.fontFamily,
        fontMono: computed.getPropertyValue('--font-mono').trim() || 'monospace',
      },
      (mark) => resolveMarkArtwork(mark.iconId, mark.logo, customIcons),
      imagesRef.current,
      () => paintRef.current === paint,
    ).then(() => {
      if (paintRef.current === paint) setIsPainted(true);
    });
    return () => {
      paintRef.current += 1;
    };
  }, [canvas, sheet, theme.palette, customIcons]);

  const fileStem = () => `requests-${dayjs().format('YYYYMMDD-HHmmss')}`;

  const produceJson = async (action: 'download' | 'copy') => {
    if (!exportDocument) return;
    const body = JSON.stringify(exportDocument, null, 2);
    if (action === 'download') {
      downloadBlob(new Blob([body], { type: 'application/json' }), `${fileStem()}.json`);
    } else if (await copyText(body)) {
      toast.success(t('events.export_json_copied'));
    } else {
      toast.error(t('events.export_failed'));
    }
  };

  const produce = async (action: 'download' | 'copy') => {
    if (!isImage) {
      await produceJson(action);
      return;
    }
    if (!canvas || !isPainted || pendingAction) return;
    setPendingAction(action);
    try {
      const image = await canvasToPng(canvas);
      if (action === 'copy') {
        await copyImage(image);
        toast.success(t('events.export_copied'));
      } else {
        downloadBlob(image, `${fileStem()}.png`);
      }
    } catch (error) {
      toast.error(t('events.export_failed'), { error });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Modal
      className="req-export-dialog"
      title={t('events.export_title', { n: selection.size })}
      open={open}
      onCancel={onClose}
      width="min(1120px, calc(100vw - 32px))"
      destroyOnHidden
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {(!isImage || canCopyImage()) && (
            <Button
              icon={<CopyOutlined />}
              loading={pendingAction === 'copy'}
              disabled={isImage && (!isPainted || pendingAction === 'download')}
              onClick={() => void produce('copy')}
              data-testid="req-export-copy"
            >
              {t(isImage ? 'events.export_copy' : 'events.export_copy_json')}
            </Button>
          )}
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={pendingAction === 'download'}
            disabled={isImage && (!isPainted || pendingAction === 'copy')}
            onClick={() => void produce('download')}
            data-testid="req-export-download"
          >
            {t(isImage ? 'events.export_download' : 'events.export_download_json')}
          </Button>
        </>
      }
    >
      <Segmented<ExportFormat>
        className="req-export-format"
        aria-label={t('events.export_format')}
        value={format}
        onChange={setFormat}
        options={[
          { value: 'image', label: t('events.export_format_image'), icon: <PictureOutlined /> },
          { value: 'json', label: 'JSON', icon: <CodeOutlined /> },
        ]}
      />
      <fieldset className="req-export-masks">
        <legend>{t('events.export_mask')}</legend>
        <p className="req-export-hint">{t('events.export_mask_hint')}</p>
        <div className="req-export-mask-row">
          <Checkbox.Group
            value={details}
            onChange={(next) => setDetails(next as SensitiveDetail[])}
            options={SENSITIVE_DETAILS.map((detail) => ({
              value: detail,
              label: t(`events.export_detail_${detail}`),
            }))}
          />
          <Select
            className="req-export-columns"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            aria-label={t('events.export_mask_columns')}
            placeholder={t('events.export_mask_columns')}
            value={maskedWholeColumns}
            onChange={setMaskedWholeColumns}
            options={REQUEST_COLUMNS.map((column) => ({ value: column.id, label: t(column.labelKey) }))}
          />
        </div>
      </fieldset>
      {isImage && selection.size > EXPORT_ROW_LIMIT && (
        <Notice
          tone="info"
          title={t('events.export_truncated', { n: EXPORT_ROW_LIMIT, total: selection.size })}
        />
      )}
      {/* Focusable so a keyboard can scroll a preview taller than the dialog. */}
      {isImage ? (
        <div className="req-export-preview" tabIndex={0} role="group" aria-label={t('events.export_preview')}>
          <canvas
            ref={setCanvas}
            className="req-export-canvas"
            data-testid="req-export-sheet"
            data-painted={isPainted || undefined}
            role="img"
            aria-label={t('events.export_title', { n: rows.length })}
          />
        </div>
      ) : (
        <>
          {selection.size > JSON_PREVIEW_ROWS && (
            <p className="req-export-hint">
              {t('events.export_json_preview_hint', { n: JSON_PREVIEW_ROWS, total: selection.size })}
            </p>
          )}
          <pre
            className="req-export-preview req-export-json"
            tabIndex={0}
            aria-label={t('events.export_json_preview')}
            data-testid="req-export-json"
          >
            {jsonPreview}
          </pre>
        </>
      )}
    </Modal>
  );
};
