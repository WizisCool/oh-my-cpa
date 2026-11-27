import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Renderer } from '@openuidev/react-lang';
import type { McpClientLike } from '@openuidev/react-lang';
import { openuiChatLibrary, ThemeProvider } from '@openuidev/react-ui';
import type { Theme, ThemeMode } from '@openuidev/react-ui';
import { inertMarkup } from './exportMarkup';
import { OPENUI_TOOL_PROVIDER } from './toolProvider';

export { inertMarkup, isInlineImageURL, sanitizeExportStyle } from './exportMarkup';

/** How long the interface may keep changing - queries answering, charts animating - before it is taken as drawn. */
const SETTLE_QUIET_MS = 300;
const SETTLE_LIMIT_MS = 8_000;

/** Resolves once the element has stopped changing for a moment, or once the limit passes. */
function settled(element: Element, isBusy: () => boolean): Promise<void> {
  return new Promise(resolve => {
    let quietTimer = 0;
    const finish = () => {
      observer.disconnect();
      window.clearTimeout(quietTimer);
      window.clearTimeout(limitTimer);
      resolve();
    };
    const arm = () => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(() => (isBusy() ? arm() : finish()), SETTLE_QUIET_MS);
    };
    const observer = new MutationObserver(arm);
    observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    const limitTimer = window.setTimeout(finish, SETTLE_LIMIT_MS);
    arm();
  });
}

export interface RenderedInterfaces {
  /** One entry per program, in order; empty where nothing could be drawn. */
  markup: string[];
  /** The theme's custom properties, for the saved document to declare on its interfaces. */
  themeCSS: string;
}

/**
 * Draws OpenUI programs with the official renderer, off screen, and reads back what they drew.
 *
 * A saved conversation cannot run the renderer, so each interface is kept as the markup it
 * produced at export time: queries answered through the page's own tool provider, at the width the
 * saved document lays it out at, in the console's theme. Its controls are kept for their look only.
 */
export async function renderInterfaces(programs: readonly string[], options: { theme: Theme; mode: ThemeMode; width: number }): Promise<RenderedInterfaces> {
  if (!programs.length) return { markup: [], themeCSS: '' };
  const host = document.createElement('div');
  const scope = `omc-openui-export-${Math.random().toString(36).slice(2)}`;
  host.className = scope;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${options.width}px;pointer-events:none`;
  document.body.append(host);
  let inFlight = 0;
  const provider: McpClientLike = {
    async callTool(call) {
      inFlight++;
      try {
        return await OPENUI_TOOL_PROVIDER.callTool(call);
      } finally {
        inFlight--;
      }
    },
  };
  const root = createRoot(host);
  try {
    flushSync(() => root.render(
      <ThemeProvider mode={options.mode} lightTheme={options.theme} darkTheme={options.theme} cssSelector={`.${scope}`}>
        {programs.map((program, index) => (
          <div key={index} data-interface={index}>
            <Renderer response={program} library={openuiChatLibrary} isStreaming={false} toolProvider={provider} />
          </div>
        ))}
      </ThemeProvider>,
    ));
    await settled(host, () => inFlight > 0);
    const markup = programs.map((_, index) => {
      const drawn = host.querySelector(`[data-interface="${index}"]`);
      return drawn?.textContent?.trim() || drawn?.querySelector('svg,img') ? inertMarkup(drawn!) : '';
    });
    const style = Array.from(document.head.querySelectorAll('style[data-openui-theme]')).find(item => item.textContent?.startsWith(`.${scope}`));
    const declarations = /\{([^}]*)\}/.exec(style?.textContent ?? '')?.[1] ?? '';
    return { markup, themeCSS: declarations.trim() };
  } finally {
    root.unmount();
    host.remove();
  }
}
