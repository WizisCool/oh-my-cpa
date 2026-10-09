import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from 'antd';
import { LabelTip } from '../../../components/common/LabelTip';
import {
  CANVAS_MIN_HEIGHT, CANVAS_SANDBOX, CANVAS_TOKENS, canvasDocument, canvasHeight, canvasImage, canvasRasterScale, uiComposeMessage,
} from '../../../agent/canvasDocument';
import { loadUIIcons } from '../../../agent/uiIcons';
import type { UIIconAssets } from '../../../agent/uiAssets';
import { useAgentView } from './AgentViewContext';
import type { CanvasImage } from '../../../agent/canvasDocument';
import { CANVAS_CAPTURE_REQUEST } from '../../../agent/canvasKit';
import { exportFileName } from '../../../agent/export';
import type { DisplayView } from '../../../agent/types';
import { useToast } from '../../../components/feedback';
import { CodeOutlined, DownloadOutlined, EyeOutlined, FullscreenExitOutlined, FullscreenOutlined, PictureOutlined } from '../../../components/icons';
import { useOverlayHistory } from '../../../hooks/useOverlayHistory';
import { useI18n } from '../../../i18n';
import { languageLocale } from '../../../i18n/language';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { saveBlob } from '../../../utils/download';
import { getTimeZone } from '../../../utils/time';
import styles from '../AgentPage.module.css';
import { createID } from '../../../utils/ids';

const INITIAL_HEIGHT = 160;
const CAPTURE_TIMEOUT_MS = 5000;
const IMAGE_SCALE = 2;

/** Rasterises the picture a canvas sent of itself. It is only ever decoded as an image. */
async function encodeImage({ svg, width, height }: CanvasImage): Promise<Blob | null> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('canvas image unavailable'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const scale = canvasRasterScale(width, height, IMAGE_SCALE);
  const surface = document.createElement('canvas');
  surface.width = Math.max(1, Math.floor(width * scale));
  surface.height = Math.max(1, Math.floor(height * scale));
  const context = surface.getContext('2d');
  if (!context) return null;
  // Filled exactly, rather than by the wanted scale: a lowered scale is fractional, and rounding it
  // down would leave a sliver of the surface unpainted.
  context.scale(surface.width / width, surface.height / height);
  context.drawImage(image, 0, 0);
  return new Promise(resolve => surface.toBlob(resolve, 'image/png'));
}

function readCanvasVariables(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);
  return Object.fromEntries(CANVAS_TOKENS.map(token => [token, computed.getPropertyValue(`--${token}`).trim()]));
}

/**
 * The theme a canvas is drawn with. Read from the page rather than the palette object: these are
 * the values the console itself is drawn with, custom palettes included. The provider writes them
 * in a layout effect, after a component has rendered, so a read during render returns the theme
 * being left. The read waits for an effect, and carries the mode it was taken under so a frame is
 * rebuilt once.
 */
export function useCanvasAppearance(): { variables: Record<string, string>; isDark: boolean } {
  const { theme, themeMode } = useTheme();
  const [appearance, setAppearance] = React.useState(() => ({ variables: readCanvasVariables(), isDark: themeMode === 'dark' }));
  React.useEffect(() => {
    setAppearance({ variables: readCanvasVariables(), isDark: themeMode === 'dark' });
  }, [themeMode, theme.palette]);
  return appearance;
}

// How tall a canvas's preview had grown when the finished canvas took its place, by call: the
// canvas starts at that height instead of collapsing to its default and growing back.
const DRAFT_HEIGHTS = new Map<string, number>();
export function rememberDraftHeight(callID: string, height: number): void {
  DRAFT_HEIGHTS.set(callID, height);
}

/**
 * A canvas (ADR 0072): markup the model wrote, drawn in a sandboxed frame of its own. The frame
 * is rebuilt when the theme changes, so a canvas coloured with the theme variables follows the
 * console; its height follows what the canvas reports, within fixed bounds.
 *
 * It can take the whole viewport, where it fills the height instead of reporting one, and it can
 * be saved as a picture. The console cannot read a frame that has no origin, so the picture is
 * asked of the canvas itself, which answers with an image of its own document.
 */
export function CanvasView({ view, callID }: { view: DisplayView; callID?: string }) {
  const { t, lang } = useI18n();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const toast = useToast();
  const { composeMessage, activity } = useAgentView();
  const [draft, setDraft] = React.useState('');
  const [iconState, setIconState] = React.useState<{ key: string; assets: UIIconAssets }>();
  const iconKey = JSON.stringify(view.icons ?? []);
  const hasIcons = (view.icons?.length ?? 0) > 0;
  const isReady = !hasIcons || iconState?.key === iconKey;
  const icons = React.useMemo(() => iconState?.key === iconKey ? iconState.assets : {}, [iconState, iconKey]);
  React.useEffect(() => {
    const controller = new AbortController();
    // Mount once artwork is ready: replacing srcdoc afterwards would reset local controls.
    loadUIIcons(JSON.parse(iconKey) as string[], controller.signal).then(assets => {
      if (!controller.signal.aborted) setIconState({ key: iconKey, assets });
    }).catch(() => { if (!controller.signal.aborted) setIconState({ key: iconKey, assets: {} }); });
    return () => controller.abort();
  }, [iconKey]);
  const [mode, setMode] = React.useState<'canvas' | 'source'>('canvas');
  const [height, setHeight] = React.useState(() => (callID && DRAFT_HEIGHTS.get(callID)) || INITIAL_HEIGHT);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const figureRef = React.useRef<HTMLElement>(null);
  const exitRef = React.useRef<HTMLButtonElement>(null);
  const wasFullscreenRef = React.useRef(false);
  const html = view.html ?? '';

  const appearance = useCanvasAppearance();

  const frameDocument = React.useMemo(() => canvasDocument({
    html, icons, rows: view.rows, isFrameless: view.frame === 'none', variables: appearance.variables, isDark: appearance.isDark, language: lang,
    format: { tokenStyle, locale: languageLocale(lang), timeZone: getTimeZone(), emptyLabel: t('agent.view.empty') },
    // `t` follows `lang`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [html, icons, view.rows, view.frame, appearance, lang, tokenStyle]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The frame has no origin to check, so the sender is identified by its window.
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = uiComposeMessage(event.data);
      if (message) setDraft(message);
      const reported = canvasHeight(event.data);
      if (reported !== undefined) setHeight(reported);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const exitFullscreen = React.useCallback(() => setIsFullscreen(false), []);
  useOverlayHistory({ isOpen: isFullscreen, onClose: exitFullscreen });
  React.useEffect(() => {
    const wasFullscreen = wasFullscreenRef.current;
    wasFullscreenRef.current = isFullscreen;
    if (!isFullscreen) {
      if (wasFullscreen) exitRef.current?.focus({ preventScroll: true });
      return undefined;
    }
    exitRef.current?.focus({ preventScroll: true });
    // A full-screen figure claims the page for assistive technology, so Tab stays inside it: the
    // transcript behind the overlay is not reachable until it closes.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setIsFullscreen(false);
      if (event.key !== 'Tab') return;
      const figure = figureRef.current;
      if (!figure) return;
      const elements = Array.from(figure.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])'));
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;
      const isInside = figure.contains(document.activeElement);
      if (event.shiftKey ? document.activeElement === first || !isInside : document.activeElement === last || !isInside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    // Focus that a browser moved past the figure - out of the sandboxed frame, or onto the
    // transcript behind the overlay - is brought back, because the frame hides its own keys.
    const onFocusIn = (event: FocusEvent) => {
      const figure = figureRef.current;
      const target = event.target;
      if (!figure || !(target instanceof Node) || figure.contains(target) || target === document.body) return;
      exitRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [isFullscreen]);

  const saveImage = async () => {
    const target = frameRef.current?.contentWindow;
    if (!target || isSaving) return;
    setIsSaving(true);
    try {
      // `crypto.randomUUID` exists only on secure origins; the console is also served over plain HTTP.
      const id = createID('capture');
      const picture = await new Promise<CanvasImage>((resolve, reject) => {
        const timer = window.setTimeout(() => { window.removeEventListener('message', onReply); reject(new Error('canvas did not answer')); }, CAPTURE_TIMEOUT_MS);
        function onReply(event: MessageEvent) {
          if (event.source !== target) return;
          const image = canvasImage(event.data, id);
          if (!image) return;
          window.clearTimeout(timer);
          window.removeEventListener('message', onReply);
          resolve(image);
        }
        window.addEventListener('message', onReply);
        target.postMessage({ type: CANVAS_CAPTURE_REQUEST, id }, '*');
      });
      const blob = await encodeImage(picture);
      if (!blob) throw new Error('canvas image not encoded');
      saveBlob(blob, exportFileName(view.title, 'png', new Date()));
    } catch {
      toast.error(t('agent.view.save_image_failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const fullscreenLabel = t(isFullscreen ? 'agent.view.fullscreen_exit' : 'agent.view.fullscreen');
  const figure = (
    <figure
      ref={figureRef}
      className={`${styles['view']}${isFullscreen ? ` ${styles['view-fullscreen']}` : ''}`}
      data-testid="agent-view"
      data-kind={view.kind}
      aria-label={view.title}
      data-frame={view.frame === 'none' ? 'none' : 'card'}
      {...(isFullscreen ? { role: 'dialog', 'aria-modal': true } : {})}
    >
      <div className={styles['view-head']}>
        <span className={styles['view-title']}>{view.title}</span>
        <span className={styles['view-spacer']} />
        {/* One action among the others, named for what it will show next. */}
        <LabelTip title={t(mode === 'canvas' ? 'agent.view.source' : 'agent.view.ui')}>
          <Button
            type="text"
            size="small"
            data-testid="agent-view-mode"
            aria-label={t(mode === 'canvas' ? 'agent.view.source' : 'agent.view.ui')}
            icon={mode === 'canvas' ? <CodeOutlined /> : <EyeOutlined />}
            onClick={() => setMode(mode === 'canvas' ? 'source' : 'canvas')}
          />
        </LabelTip>
        <LabelTip title={t('agent.view.save_image')}>
          <Button
            type="text"
            size="small"
            aria-label={t('agent.view.save_image')}
            icon={<PictureOutlined />}
            loading={isSaving}
            disabled={mode !== 'canvas' || !isReady}
            onClick={() => void saveImage()}
          />
        </LabelTip>
        <LabelTip title={t('agent.view.download_html')}>
          <Button
            type="text"
            size="small"
            aria-label={t('agent.view.download_html')}
            disabled={!isReady}
            icon={<DownloadOutlined />}
            onClick={() => saveBlob(new Blob([frameDocument], { type: 'text/html;charset=utf-8' }), exportFileName(view.title, 'html', new Date()))}
          />
        </LabelTip>
        <LabelTip title={fullscreenLabel}>
          <Button
            ref={exitRef}
            type="text"
            size="small"
            aria-label={fullscreenLabel}
            aria-pressed={isFullscreen}
            icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            onClick={() => setIsFullscreen(value => !value)}
          />
        </LabelTip>
      </div>
      {draft && composeMessage && (
        <div className={styles['ui-draft']} data-testid="agent-ui-draft">
          <span>{t('agent.ui.review')}</span>
          <pre>{draft}</pre>
          <Button size="small" disabled={!!activity} onClick={() => { composeMessage(draft); setDraft(''); }}>{t('agent.ui.compose')}</Button>
          <Button size="small" type="text" onClick={() => setDraft('')}>{t('common.cancel')}</Button>
        </div>
      )}
      {mode === 'canvas' ? isReady && (
        <iframe
          ref={frameRef}
          className={styles['canvas-frame']}
          title={view.title}
          sandbox={CANVAS_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={frameDocument}
          style={isFullscreen ? undefined : { height: Math.max(CANVAS_MIN_HEIGHT, height) }}
          data-testid="agent-canvas"
        />
      ) : (
        <pre className={styles['canvas-source']}><code>{html}</code></pre>
      )}
    </figure>
  );

  // The viewport-filling canvas is drawn on the body, clear of the transcript's scroll box and
  // of anything above it that would clip a fixed element. Its place in the answer is held open so
  // the conversation does not jump when it returns.
  if (!isFullscreen) return figure;
  return (
    <>
      <div className={styles['view-placeholder']} style={{ height: Math.max(CANVAS_MIN_HEIGHT, height) + 56 }} aria-hidden="true" />
      {createPortal(figure, document.body)}
    </>
  );
}
