/**
 * Export-time sanitization for OpenUI interfaces embedded in standalone HTML snapshots.
 *
 * Exported conversation HTML enforces `img-src data:` (`web/src/agent/conversationHtml.ts`) and
 * opens offline without a console origin. Keeping these helpers separate from `staticRender.tsx`
 * avoids pulling `@openuidev/react-ui` into tests or callers that only need markup sanitization.
 */

/**
 * Hooks the saved document's fixed script acts on. Rendered markup never carries them, and an
 * interface cannot add an attribute of its own; they are removed anyway so the guarantee does not
 * rest on the component library.
 */
const SCRIPT_HOOKS = /^data-(?:copy|copy-label|panel|toggle-panel|toggle-search|close|expand|collapse|print|search|search-count)$/;
/** Where a link may go in a saved document; exported assets stay inline so the file works offline. */
const LINK_URL = /^(?:https?:|mailto:|#)/i;
/** Attributes that reference media/image assets stripped when not inline for offline HTML export. */
const ASSET_ATTRIBUTES = new Set(['src', 'srcset', 'poster', 'xlink:href']);
const SVG_IMAGE_ELEMENTS = new Set(['image', 'feimage']);
const DROPPED_ELEMENTS = 'script,iframe,object,embed,link,meta,base,template,noscript';

/** Whether a URL is an inline `data:image/` asset compatible with exported HTML's `img-src data:` CSP. */
export function isInlineImageURL(value: string): boolean {
  return /^data:image\//i.test(value.trim());
}

/**
 * Every candidate URL in an HTML `srcset` attribute. `data:` URLs contain a comma between the
 * metadata prefix and payload, so recombine those two segments before extracting the URL token.
 */
function srcsetURLs(value: string): string[] {
  const urls: string[] = [];
  const parts = value.split(',');
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i].trim();
    if (/^data:[^,\s]*$/i.test(part) && i + 1 < parts.length) {
      part = `${part},${parts[++i]}`.trim();
    }
    const url = part.split(/\s+/)[0];
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Replaces non-inline CSS `url(...)` references with `none` for portable HTML export, keeping
 * inline `data:image/` payloads and in-document `#fragment` references (such as SVG clip paths).
 */
export function sanitizeExportStyle(style: string): string {
  return style.replace(
    /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/gi,
    (whole, singleQuoted: string | undefined, doubleQuoted: string | undefined, unquoted: string | undefined) => {
      const url = (singleQuoted ?? doubleQuoted ?? unquoted ?? '').trim();
      return url.startsWith('#') || isInlineImageURL(url) ? whole : 'none';
    },
  );
}

/**
 * The drawn interface as inert, self-contained markup for a standalone exported document that
 * enforces `img-src data:` and runs only its own fixed script: no element that loads or runs
 * anything, no handler or script hook, no external/origin asset URLs, no address other than a web
 * or mail link, and every control left without a behaviour.
 */
export function inertMarkup(root: Element): string {
  const copy = root.cloneNode(true) as Element;
  copy.querySelectorAll(DROPPED_ELEMENTS).forEach(element => element.remove());
  for (const element of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    const tag = element.tagName.toLowerCase();
    for (const { name, value } of Array.from(element.attributes)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || SCRIPT_HOOKS.test(lower)) {
        element.removeAttribute(name);
        continue;
      }
      // Exported snapshots enforce `img-src data:` and have no console origin when opened offline,
      // so keep only inline `data:image/` payloads (and in-document `#` SVG references).
      if (ASSET_ATTRIBUTES.has(lower) || (lower === 'href' && (SVG_IMAGE_ELEMENTS.has(tag) || tag === 'use'))) {
        const trimmed = value.trim();
        const isPortable = lower === 'srcset'
          ? srcsetURLs(trimmed).length > 0 && srcsetURLs(trimmed).every(isInlineImageURL)
          : tag === 'use'
            ? trimmed.startsWith('#')
            : lower === 'xlink:href'
              ? trimmed.startsWith('#') || isInlineImageURL(trimmed)
              : isInlineImageURL(trimmed);
        if (!isPortable) element.removeAttribute(name);
        continue;
      }
      if (lower === 'style') {
        const sanitized = sanitizeExportStyle(value);
        if (sanitized !== value) element.setAttribute(name, sanitized);
        continue;
      }
      if (lower === 'href' ? !LINK_URL.test(value.trim()) : ['action', 'formaction'].includes(lower)) element.removeAttribute(name);
    }
  }
  return copy.innerHTML;
}
