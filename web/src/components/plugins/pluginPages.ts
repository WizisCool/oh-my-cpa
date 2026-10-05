import { pluginDisplayName, type PluginItem } from '../../types/plugin';

/**
 * The pages plugins register, as the console addresses them.
 *
 * A plugin page is an HTML resource the plugin serves from CPA. The console lists every
 * running plugin's pages in its navigation and shows each one in a frame whose document
 * comes through the console's plugin host, so the page is loaded with the console session
 * and never needs CPA's management key in the browser (ADR 0060).
 */

export const PLUGIN_PAGE_ROUTE_PREFIX = '/plugin-pages';

/** The only prefix a plugin page may be read from; anything else is not a plugin resource. */
const PLUGIN_RESOURCE_PREFIX = '/v0/resource/plugins/';

export interface PluginPageEntry {
  /** The console route, which is also the navigation key. */
  route: string;
  pluginId: string;
  /** Position among the plugin's pages; the route names a page by it, as its path is not URL-safe. */
  pageIndex: number;
  pluginName: string;
  label: string;
  /** The label in a list that mixes plugins: the plugin is named when it has several pages. */
  navLabel: string;
  description?: string;
  logo?: string;
  resourcePath: string;
}

export function pluginPageRoute(pluginId: string, pageIndex: number): string {
  return `${PLUGIN_PAGE_ROUTE_PREFIX}/${encodeURIComponent(pluginId)}/${pageIndex}`;
}

/** The address the frame loads: the plugin's resource path under the console's plugin host. */
export function pluginPageFrameURL(apiBaseUrl: string, resourcePath: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/plugin-host${resourcePath}`;
}

function isPluginResourcePath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith(PLUGIN_RESOURCE_PREFIX) && !path.includes('..') && !/[\s\\]/.test(path);
}

/** Every page of every running plugin, in the order CPA lists them. */
export function collectPluginPages(plugins: readonly PluginItem[] | undefined): PluginPageEntry[] {
  const entries: PluginPageEntry[] = [];
  for (const plugin of plugins ?? []) {
    if (!plugin.effective_enabled) continue;
    const pages = (plugin.pages ?? []).filter((page) => isPluginResourcePath(page.path));
    const pluginName = pluginDisplayName(plugin);
    pages.forEach((page, pageIndex) => {
      const label = page.label?.trim() || pluginName;
      entries.push({
        route: pluginPageRoute(plugin.id, pageIndex),
        pluginId: plugin.id,
        pageIndex,
        pluginName,
        label,
        navLabel: pages.length > 1 && label !== pluginName ? `${pluginName} · ${label}` : label,
        description: page.description?.trim() || undefined,
        logo: plugin.logo || plugin.metadata?.logo,
        resourcePath: page.path,
      });
    });
  }
  return entries;
}

/** The page a route names, or nothing when the plugin stopped or no longer registers it. */
export function findPluginPage(
  entries: readonly PluginPageEntry[],
  pluginId: string | undefined,
  pageIndex: string | undefined,
): PluginPageEntry | undefined {
  if (!pluginId || !pageIndex || !/^\d+$/.test(pageIndex)) return undefined;
  const index = Number.parseInt(pageIndex, 10);
  return entries.find((entry) => entry.pluginId === pluginId && entry.pageIndex === index);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The document between the console and a plugin page.
 *
 * Plugin pages written for CPA's management centre read their colour scheme from
 * `window.parent.document.documentElement`'s `data-theme` (`dark` or `light`). The
 * console's own root carries a palette id there instead, so the page's parent is this
 * small same-origin document, which states the mode in the vocabulary those pages expect.
 *
 * It also declares the console's colour scheme. A framed document whose scheme differs
 * from its frame's is given an opaque canvas by the browser, which on a dark console is a
 * white rectangle until the plugin page has painted.
 */
export function pluginFrameShell(frameURL: string, title: string, frameTheme: 'dark' | 'light'): string {
  return [
    `<!doctype html><html data-theme="${frameTheme}" style="color-scheme:${frameTheme}"><head><meta charset="utf-8">`,
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;color-scheme:inherit}</style>',
    '</head><body>',
    `<iframe src="${escapeAttribute(frameURL)}" title="${escapeAttribute(title)}" referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write"></iframe>`,
    '</body></html>',
  ].join('');
}
