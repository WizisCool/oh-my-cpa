import React from 'react';
import { Button, Segmented, Tooltip } from 'antd';
import { CANVAS_MIN_HEIGHT, CANVAS_SANDBOX, CANVAS_TOKENS, canvasDocument, canvasHeight } from '../../../agent/canvasDocument';
import { exportFileName } from '../../../agent/export';
import type { DisplayView } from '../../../agent/types';
import { DownloadOutlined } from '../../../components/icons';
import { useI18n } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import { saveBlob } from '../../../utils/download';
import styles from '../AgentPage.module.css';

const INITIAL_HEIGHT = 160;

/**
 * A canvas (ADR 0072): markup the model wrote, drawn in a sandboxed frame of its own. The frame
 * is rebuilt when the theme changes, so a canvas coloured with the theme variables follows the
 * console; its height follows what the canvas reports, within fixed bounds.
 */
export function CanvasView({ view }: { view: DisplayView }) {
  const { t, lang } = useI18n();
  const { theme, themeMode } = useTheme();
  const [mode, setMode] = React.useState<'canvas' | 'source'>('canvas');
  const [height, setHeight] = React.useState(INITIAL_HEIGHT);
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const html = view.html ?? '';

  const frameDocument = React.useMemo(() => {
    // Read from the page rather than the palette object: these are the values the console itself
    // is drawn with, custom palettes included.
    const computed = getComputedStyle(document.documentElement);
    const variables = Object.fromEntries(CANVAS_TOKENS.map(token => [token, computed.getPropertyValue(`--${token}`).trim()]));
    return canvasDocument({ html, rows: view.rows, variables, isDark: themeMode === 'dark', language: lang });
    // The palette is a dependency because the variables are read at build time, not live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, view.rows, themeMode, theme.palette, lang]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The frame has no origin to check, so the sender is identified by its window.
      if (event.source !== frameRef.current?.contentWindow) return;
      const reported = canvasHeight(event.data);
      if (reported !== undefined) setHeight(reported);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <figure className={styles['view']} data-testid="agent-view" data-kind="canvas">
      <div className={styles['view-head']}>
        <span className={styles['view-title']}>{view.title}</span>
        <Segmented
          size="small"
          value={mode}
          onChange={value => setMode(value as 'canvas' | 'source')}
          options={[
            { value: 'canvas', label: t('agent.view.canvas') },
            { value: 'source', label: t('agent.view.source') },
          ]}
        />
        <span className={styles['view-spacer']} />
        <Tooltip title={t('agent.view.download_html')}>
          <Button
            type="text"
            size="small"
            aria-label={t('agent.view.download_html')}
            icon={<DownloadOutlined />}
            onClick={() => saveBlob(new Blob([frameDocument], { type: 'text/html;charset=utf-8' }), exportFileName(view.title, 'html', new Date()))}
          />
        </Tooltip>
      </div>
      {mode === 'canvas' ? (
        <iframe
          ref={frameRef}
          className={styles['canvas-frame']}
          title={view.title}
          sandbox={CANVAS_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={frameDocument}
          style={{ height: Math.max(CANVAS_MIN_HEIGHT, height) }}
          data-testid="agent-canvas"
        />
      ) : (
        <pre className={styles['canvas-source']}><code>{html}</code></pre>
      )}
    </figure>
  );
}
