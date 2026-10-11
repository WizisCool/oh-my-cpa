import React from 'react';
import { Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { DownloadOutlined } from '../icons';
import dayjs from '../../utils/time';
import { api, apiErrorCode } from '../../api/client';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { saveBlob } from '../../utils/download';
import { formatBytes } from '../../utils/format';
import {
  canPreviewLog,
  logViewerFileName,
  MAX_LOG_PREVIEW_BYTES,
  type LogViewerTarget,
} from '../../types/logs';
import { AppDrawer } from '../common/AppDrawer';
import { CopyButton } from '../common/CopyButton';
import { ParagraphPlaceholder } from '../common/ContentPlaceholder';
import { EmptyState } from '../common/EmptyState';
import { LoadFailure, Notice } from '../feedback';
import styles from './Logs.module.css';

interface LoadedLogFile {
  blob: Blob;
  /** Undefined when the file is too large to draw; the blob is still there to save. */
  text?: string;
}

async function loadLogFile(target: LogViewerTarget): Promise<LoadedLogFile> {
  const blob = target.kind === 'file'
    ? await api.downloadRequestErrorLog(target.file.name)
    : await api.downloadRequestLogById(target.requestId);
  return canPreviewLog(blob.size) ? { blob, text: await blob.text() } : { blob };
}

export interface LogFileViewerProps {
  /** The file on display; null closes the viewer. */
  target: LogViewerTarget | null;
  onClose: () => void;
}

/**
 * One gateway log file read in place: the request, what was sent upstream and what came back.
 *
 * The file is fetched once per opening and saved from that same copy, so reading and then
 * downloading is one audited read rather than two. Nothing is kept after the viewer closes: the
 * text quotes request content.
 */
export const LogFileViewer: React.FC<LogFileViewerProps> = ({ target, onClose }) => {
  useTimeZone();
  const t = useT();
  const isOpen = target !== null;
  useOverlayHistory({ isOpen, onClose });
  // The panel keeps its title and body while it slides out.
  const shownRef = React.useRef(target);
  if (target) shownRef.current = target;
  const shown = shownRef.current;

  const query = useQuery({
    queryKey: ['log-file', shown?.kind, shown ? logViewerFileName(shown) : ''],
    queryFn: () => loadLogFile(shown as LogViewerTarget),
    enabled: isOpen,
    meta: { silent: true },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const fileName = shown ? logViewerFileName(shown) : '';
  const loaded = query.data;
  // CPA keeps a file per request only while request logging is on, and otherwise its newest
  // few error logs: its absence is an answer about retention, not a read to retry.
  const isMissing = query.isError && apiErrorCode(query.error) === 'request_log_not_found';

  let body: React.ReactNode;
  if (query.isPending) {
    body = <ParagraphPlaceholder rows={10} />;
  } else if (isMissing) {
    body = <Notice tone="warning" title={t('logs.viewer_missing')} description={t('logs.viewer_missing_desc')} />;
  } else if (query.isError) {
    body = <LoadFailure title={t('logs.viewer_failed')} error={query.error} onRetry={() => void query.refetch()} />;
  } else if (loaded?.text === undefined) {
    body = <Notice tone="info" title={t('logs.viewer_too_large', { limit: formatBytes(MAX_LOG_PREVIEW_BYTES) })} />;
  } else if (loaded.text.trim() === '') {
    body = <EmptyState size="compact" title={t('logs.viewer_empty')} />;
  } else {
    body = <pre className={styles['viewer-text']} tabIndex={0}>{loaded.text}</pre>;
  }

  return (
    <AppDrawer
      width="wide"
      open={isOpen}
      onClose={onClose}
      destroyOnHidden
      title={<span className={styles['viewer-title']}>{fileName}</span>}
      footerStart={shown?.kind === 'file' ? (
        <span className={styles['viewer-meta']}>
          {formatBytes(shown.file.size)}
          {shown.file.modified ? ` · ${dayjs.unix(shown.file.modified).format('MM-DD HH:mm:ss')}` : ''}
        </span>
      ) : loaded ? <span className={styles['viewer-meta']}>{formatBytes(loaded.blob.size)}</span> : undefined}
      footer={(
        <>
          <CopyButton showLabel size="middle" text={loaded?.text ?? ''} disabled={!loaded?.text} />
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            disabled={!loaded}
            onClick={() => loaded && saveBlob(loaded.blob, fileName)}
          >
            {t('logs.download')}
          </Button>
        </>
      )}
    >
      {body}
    </AppDrawer>
  );
};
