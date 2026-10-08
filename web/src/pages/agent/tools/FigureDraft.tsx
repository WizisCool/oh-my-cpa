import React from 'react';
import { Placeholder } from '../../../components/common/Placeholder';
import { GenerationLoader } from '../../../components/workspace/GenerationLoader';
import workspace from '../../../components/workspace/Workspace.module.css';
import { useI18n } from '../../../i18n';
import { CANVAS_DRAFT_MESSAGE, CANVAS_MIN_HEIGHT, CANVAS_SANDBOX, canvasDraftDocument, canvasHeight } from '../../../agent/canvasDocument';
import { draftViewHTML, draftViewTitle, isDraftViewFrameless } from '../../../agent/types';
import type { Trace } from '../../../agent/types';
import { rememberDraftHeight, useCanvasAppearance } from './CanvasView';
import styles from '../AgentPage.module.css';

/** How often the markup written so far is redrawn; a canvas arrives far faster than it can be read. */
const DRAFT_INTERVAL_MS = 120;

/**
 * A display call the model is still writing, drawn where its figure will land and filled in as it
 * is written (ADR 0085). A canvas can take the better part of a minute to arrive as arguments, and
 * a loader for that long says only that something is coming; the markup itself, drawn as far as it
 * goes, shows what.
 *
 * The preview is the finished canvas's frame without its scripts: the same sandbox, policy, tokens
 * and components, handed the markup written so far. Until there is markup to show it is the
 * loader in the figure's own frame, and the title is shown as soon as its string has closed.
 */
export function FigureDraft({ trace }: { trace: Trace }) {
  const { t, lang } = useI18n();
  const title = draftViewTitle(trace.arguments);
  const html = draftViewHTML(trace.arguments);
  const isFrameless = isDraftViewFrameless(trace.arguments, trace.name);
  const appearance = useCanvasAppearance();
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const [isLoaded, setIsLoaded] = React.useState(false);
  const [height, setHeight] = React.useState(CANVAS_MIN_HEIGHT);
  const frameDocument = React.useMemo(() => canvasDraftDocument({ ...appearance, isFrameless, language: lang }), [appearance, isFrameless, lang]);

  const htmlRef = React.useRef(html);
  htmlRef.current = html;
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>();
  const post = React.useCallback(() => {
    timerRef.current = undefined;
    frameRef.current?.contentWindow?.postMessage({ type: CANVAS_DRAFT_MESSAGE, html: htmlRef.current }, '*');
  }, []);
  // The newest markup is always the one drawn: a pending redraw reads it when it fires.
  React.useEffect(() => {
    if (isLoaded && html && !timerRef.current) timerRef.current = setTimeout(post, DRAFT_INTERVAL_MS);
  }, [html, isLoaded, post]);
  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const reported = canvasHeight(event.data);
      if (reported === undefined) return;
      setHeight(reported);
      rememberDraftHeight(trace.id, reported);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [trace.id]);

  return (
    <figure
      className={`${styles['view']} ${styles['view-draft']}`}
      role="status"
      aria-busy="true"
      aria-label={t('agent.view.drafting')}
      data-testid="agent-view-draft"
      data-frame={isFrameless ? 'none' : 'card'}
    >
      <div className={styles['view-head']}>
        {title ? <span className={styles['view-title']}>{title}</span> : <Placeholder width={148} className="placeholder-line" />}
        {html && (
          <span className={styles['view-draft-status']}>
            <GenerationLoader size="mark" />
            <span className={styles['view-draft-label']}><span className={workspace['live-text']}>{t('agent.view.drafting')}</span></span>
          </span>
        )}
      </div>
      {!html && (
        <div className={styles['view-draft-stage']}>
          <GenerationLoader />
          <span className={styles['view-draft-label']}><span className={workspace['live-text']}>{t('agent.view.drafting')}</span></span>
        </div>
      )}
      {/* Mounted before there is markup, so the first of it is drawn the moment it arrives. */}
      <iframe
        ref={frameRef}
        className={styles['canvas-frame']}
        title={title || t('agent.view.drafting')}
        sandbox={CANVAS_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={frameDocument}
        style={{ height, display: html ? undefined : 'none' }}
        tabIndex={-1}
        data-testid="agent-canvas-draft"
        onLoad={() => { setIsLoaded(true); if (htmlRef.current) post(); }}
      />
    </figure>
  );
}
