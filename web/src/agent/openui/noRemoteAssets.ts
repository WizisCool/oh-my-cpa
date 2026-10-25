/**
 * A rendered program may name any asset URL, and the program is model output: a tool result the
 * model read - a provider name, a plugin manifest, a user agent - can steer it into an answer, so a
 * remote image would turn the reader's browser into a beacon for whatever the URL carries.
 *
 * What this does, and what it cannot: it fences every asset an answer renders to what the console
 * already serves - its own origin, or an inline `data:`/`blob:` URL - by removing the source and
 * keeping the element's box, so the layout the model drew still reads. It runs on render and on
 * every later mutation, because a program streams its statements in. It is a net, not a wall: a
 * browser may have queued a request in the moment between an element's insertion and the observer's
 * callback, and nothing here can recall it. The wall would be an enforced `img-src`, which the
 * console does not set - its CSP is report-only because the library's own brand marks load favicons
 * from the open web. The prompt therefore also tells the model not to name external assets.
 */

const ASSET_ATTRIBUTES = ['src', 'srcset', 'poster', 'href', 'xlink:href'];
const ASSET_SELECTOR = 'img, source, video, audio, iframe, object, embed';
const SAFE_URL = /^(?:data|blob):/i;

/** Whether a URL names an asset the console itself serves. */
export function isLocalAsset(value: string): boolean {
  const trimmed = value.trim();
  if (SAFE_URL.test(trimmed)) return true;
  try {
    return new URL(trimmed, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Every URL a `srcset` names: a 2x candidate is its own request. */
function candidates(value: string): string[] {
  return value.split(',').map(part => part.trim().split(/\s+/)[0] ?? '').filter(Boolean);
}

function fenceElement(element: Element): void {
  if (element.matches(ASSET_SELECTOR)) {
    for (const attribute of ASSET_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null || value === '') continue;
      const urls = attribute === 'srcset' ? candidates(value) : [value];
      if (urls.every(isLocalAsset)) continue;
      element.removeAttribute(attribute);
      element.setAttribute('data-blocked-asset', '');
    }
  }
  const style = element.getAttribute('style');
  if (!style) return;
  const fenced = sanitizeAssetStyle(style);
  if (fenced !== style) element.setAttribute('style', fenced);
}

/**
 * A stylesheet declaration with every asset URL that the console does not serve replaced by
 * `none`. A background image is the same request as an `<img>`, written in CSS, and one declaration
 * may name several; the exported markup runs the same rule before a document is written.
 */
export function sanitizeAssetStyle(style: string): string {
  return style.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (whole, url: string) => (isLocalAsset(url) ? whole : 'none'));
}

/**
 * Fences every asset under `root`, including ones that arrive later: a program streams its
 * statements, so an image can be appended long after the first render. Returns the disconnect.
 */
export function fenceRemoteAssets(root: ParentNode): () => void {
  const fence = (node: Node) => {
    if (node instanceof Element) {
      fenceElement(node);
      // Every element, not only the media ones: a background image is written in `style`.
      for (const child of node.querySelectorAll('*')) fenceElement(child);
    }
  };
  fence(root as unknown as Node);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) fenceElement(record.target);
      else for (const node of record.addedNodes) fence(node);
    }
  });
  observer.observe(root as unknown as Node, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ASSET_ATTRIBUTES.concat('style'),
  });
  return () => observer.disconnect();
}
