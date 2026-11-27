import type { ReactNode } from 'react';
import { formatErrorCode } from '../../../utils/format';
import { Button } from '@/components/ui/button';
import { useAui, useAuiState } from '@assistant-ui/react';
import { createOpenUIToolkit, OpenUIContent } from '@openuidev/assistant-ui';
import type { OpenUIErrorFallback } from '@openuidev/assistant-ui';
import type { OpenUIError } from '@openuidev/react-lang';
import '@openuidev/react-ui/components.css';
import { Notice } from '../../../components/feedback';
import { useI18n } from '../../../i18n';
import styles from '../AgentPage.module.css';
import { OPENUI_TOOL_PROVIDER } from '../../../agent/openui/toolProvider';

/**
 * The official OpenUI tool renderers, configured for OMC.
 *
 * `present_openui` and `prompt_openui` are drawn by `@openuidev/assistant-ui` exactly as the
 * integration ships them; OMC contributes only what is its own: the tool provider that connects a
 * program's Query and Mutation calls to the console, the theme (the page wraps the thread in
 * OpenUI's ThemeProvider, so the tools do not add their own), and how a failed render is reported.
 */

/**
 * A program the renderer could not draw, reported in a sentence rather than left blank, with the
 * renderer's structured errors one click away from the model: the OpenUI prompt spec asks the host
 * to send them back so the next answer can repair the program.
 */
export const OpenUIFailure: OpenUIErrorFallback = ({ errors }: { errors: readonly OpenUIError[] }) => {
  const { t } = useI18n();
  const aui = useAui();
  const isRunning = useAuiState(state => state.thread.isRunning);
  const report = errors.map(({ code, statementId, component, message, hint }) => ({ code, statementId, component, message, hint }));
  return (
    <Notice
      tone="warning"
      title={t('agent.openui.failed')}
      description={<code>{errors.slice(0, 3).map(error => formatErrorCode({ code: error.code, parameter: error.statementId })).join('\n')}</code>}
      action={(
        <Button size="sm" disabled={isRunning} onClick={() => aui.thread().append({ role: 'user', content: [{ type: 'text', text: `${t('agent.openui.repair')}\n\n${JSON.stringify(report)}` }] })}>
          {t('agent.openui.ask_repair')}
        </Button>
      )}
      data-testid="agent-openui-failure"
    />
  );
};

/**
 * A link the model put in a program. `window.open` accepts any scheme, so a prompt-injected answer
 * could otherwise hand the browser a `javascript:` or `data:` URL; only the web is opened.
 */
function isWebURL(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Where a drawn OpenUI interface stands in an answer.
 *
 * Interfaces render inside the console document where external HTTP(S) images (such as library
 * source favicons or model-referenced images) may load directly under `Referrer-Policy: no-referrer`.
 * Exported standalone HTML snapshots strip non-inline assets in `exportMarkup.ts` to match their
 * enforced `img-src data:` policy.
 */
export function OpenUISurface({ tool, children }: { tool: string; children: ReactNode }) {
  return (
    <div className={styles['openui']} data-testid="agent-openui" data-tool={tool} data-aui-quote-selectable="false">
      {children}
    </div>
  );
}

const RENDERER_PROPS = { toolProvider: OPENUI_TOOL_PROVIDER };

export const OPENUI_TOOLKIT = createOpenUIToolkit({
  disableThemeProvider: true,
  rendererProps: RENDERER_PROPS,
  ErrorFallback: OpenUIFailure,
});

/**
 * Answer text that is itself an OpenUI program, drawn by the same official renderer: a model that
 * answered with the program instead of calling the tool still shows an interface, not raw language.
 * It cannot submit a form - only `prompt_openui` waits for one - so its actions continue the
 * conversation, as present_openui's do.
 */
export function OpenUIText({ program, isStreaming }: { program: string; isStreaming: boolean }) {
  const aui = useAui();
  return (
    <OpenUIContent
      response={program}
      isStreaming={isStreaming}
      disableThemeProvider
      rendererProps={RENDERER_PROPS}
      ErrorFallback={OpenUIFailure}
      onAction={event => {
        if (event.type === 'continue_conversation') aui.thread().append({ role: 'user', content: [{ type: 'text', text: event.humanFriendlyMessage }] });
        else if (event.type === 'open_url' && isWebURL(event.params?.url)) window.open(event.params.url, '_blank', 'noopener,noreferrer');
      }}
    />
  );
}
