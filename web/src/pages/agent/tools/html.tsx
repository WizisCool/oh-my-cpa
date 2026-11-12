import React from 'react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { AppModal } from '../../../components/common/AppModal';
import { CodeBody } from '../../../components/common/CodeBody';
import { CodeFrame } from '../../../components/common/CodeFrame';
import { SandboxedDocument } from '../../../components/common/SandboxedDocument';
import { Tooltip } from '../../../components/common/Tooltip';
import { DownloadOutlined, FullscreenOutlined } from '../../../components/icons';
import { useI18n } from '../../../i18n';
import { htmlOf } from '../../../agent/htmlDocument';
import styles from '../AgentPage.module.css';

type HTMLView = 'page' | 'code';

/** The document as a file the operator keeps, since the frame is a view rather than the artifact. */
function saveDocument(source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/html;charset=utf-8' }));
  const link = window.document.createElement('a');
  link.href = url;
  link.download = 'page.html';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface HTMLSurfaceProps {
  /** The call's argument text, as far as it has streamed. */
  argumentsText: string;
  isStreaming: boolean;
}

/**
 * A page the model drew: the document itself, with its source one click away.
 *
 * The document is model output and is drawn by `SandboxedDocument`, which fences what it may reach.
 * Until the call settles the frame stays closed: a half-written document would paint a broken page
 * and then repaint it on every token, so the reader waits for one finished drawing.
 */
export function HTMLSurface({ argumentsText, isStreaming }: HTMLSurfaceProps) {
  const { t } = useI18n();
  const [view, setView] = React.useState<HTMLView>('page');
  const [isExpanded, setIsExpanded] = React.useState(false);
  const source = htmlOf(argumentsText);
  const title = t('agent.html.frame_title');
  const actions = (
    <>
      <Segmented
        size="sm"
        value={view}
        onChange={value => setView(value as HTMLView)}
        options={[{ label: t('agent.html.page'), value: 'page' }, { label: t('agent.html.code'), value: 'code' }]}
      />
      {!isStreaming && view === 'page' && (
        <Tooltip title={t('agent.html.expand')}>
          <Button size="sm" variant="ghost" icon={<FullscreenOutlined />} onClick={() => setIsExpanded(true)} aria-label={t('agent.html.expand')} />
        </Tooltip>
      )}
      {!isStreaming && (
        <Tooltip title={t('agent.html.download')}>
          <Button size="sm" variant="ghost" icon={<DownloadOutlined />} onClick={() => saveDocument(source)} aria-label={t('agent.html.download')} />
        </Tooltip>
      )}
    </>
  );
  return (
    <div className={styles['html-surface']} data-testid="agent-html" data-streaming={isStreaming || undefined} data-aui-quote-selectable="false">
      <CodeFrame code={source} label="html" actions={actions}>
        {isStreaming ? (
          <div className={styles['html-pending']} role="status">{t('agent.html.rendering')}</div>
        ) : view === 'page' ? (
          <SandboxedDocument document={source} title={title} />
        ) : (
          <CodeBody code={source} lang="html" isStreaming={isStreaming} />
        )}
      </CodeFrame>
      <AppModal open={isExpanded} onCancel={() => setIsExpanded(false)} title={title} size="wide" footer={null} destroyOnHidden>
        <SandboxedDocument document={source} title={title} height="70vh" testID="agent-html-expanded" />
      </AppModal>
    </div>
  );
}
