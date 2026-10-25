import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Renderer } from '@openuidev/react-lang';
import type { McpClientLike } from '@openuidev/react-lang';
import { openuiChatLibrary, ThemeProvider } from '@openuidev/react-ui';
import type { Theme, ThemeMode } from '@openuidev/react-ui';
import { OPENUI_TOOL_PROVIDER } from './toolProvider';
import { fenceRemoteAssets, isLocalAsset, sanitizeAssetStyle } from './noRemoteAssets';

/** How long the interface may keep changing - queries answering, charts animating - before it is taken as drawn. */
const SETTLE_QUIET_MS = 300;
const SETTLE_LIMIT_MS = 8_000;

/**
 * Hooks the saved document's fixed script acts on. Rendered markup never carries them, and an
 * interface cannot add an attribute of its own; they are removed anyway so the guarantee does not
 * rest on the component library.
 */
const SCRIPT_HOOKS = /^data-(?:copy|copy-label|panel|toggle-panel|toggle-search|close|expand|collapse|print|search|search-count)$/;
/** Where a link may go in a saved document; an asset source has its own, local-only rule. */
const LINK_URL = /^(?:https?:|mailto:|#)/i;
/** Attributes that name an asset: they follow the same rule as a rendered answer, not the link's. */
const ASSET_ATTRIBUTES = new Set(['src', 'srcset', 'poster', 'xlink:href']);
const DROPPED_ELEMENTS = 'script,iframe,object,embed,link,meta,base,template,noscript';

/** Every candidate of a `srcset`, so a 2x remote source cannot ride along with a local one. */
function assetURLs(attribute: string, value: string): string[] {
  if (attribute !== 'srcset') return [value];
  return value.split(',').map(part => part.trim().split(/\s+/)[0] ?? '').filter(Boolean);
}

/**
 * The drawn interface as inert markup for a document that runs only its own fixed script: no
 * element that loads or runs anything, no handler or script hook, no address other than a web or
 * mail link, and every control left without a behaviour.
 */
export function inertMarkup(root: Element): string {
  const copy = root.cloneNode(true) as Element;
  copy.querySelectorAll(DROPPED_ELEMENTS).forEach(element => element.remove());
  for (const element of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    for (const { name, value } of Array.from(element.attributes)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || SCRIPT_HOOKS.test(lower)) {
        element.removeAttribute(name);
        continue;
      }
      // A saved document must not phone home when it is opened, so an asset is kept only when the
      // console serves it; a link may still point at the web.
      if (ASSET_ATTRIBUTES.has(lower)) {
        if (!assetURLs(lower, value.trim()).every(isLocalAsset)) element.removeAttribute(name);
        continue;
      }
      if (lower === 'style') {
        const fenced = sanitizeAssetStyle(value);
        if (fenced !== value) element.setAttribute(name, fenced);
        continue;
      }
      if (lower === 'href' ? !LINK_URL.test(value.trim()) : ['action', 'formaction'].includes(lower)) element.removeAttribute(name);
    }
  }
  return copy.innerHTML;
}

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
  // The programs are model output and the host is a live document: fence what they name before
  // they render, so export does not request a remote asset the console would not show either.
  const releaseFence = fenceRemoteAssets(host);
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
    releaseFence();
    host.remove();
  }
}
