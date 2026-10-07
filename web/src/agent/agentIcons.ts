import { LOBE_ICON_CATALOG } from '../types/lobeIconCatalog';

/**
 * Icons a panel names (ADR 0071).
 *
 * The model is not handed a list to choose from: it writes any Lucide name, or `brand:<maker>` for
 * a maker's mark, and the console resolves it. A name nothing answers to is not an error - the
 * item is drawn with a neutral mark - so an icon can never be the reason a view fails.
 */
export type LucideNode = [string, Record<string, string | number>];
/** Every Lucide name; a retired name holds the name that replaced it. */
export type LucideIconData = Record<string, LucideNode[] | string>;

export type IconReference =
  | { kind: 'brand'; id: string }
  | { kind: 'lucide'; name: string };

const BRAND_IDS = new Map(LOBE_ICON_CATALOG.map(item => [item.id.toLowerCase(), item.id]));

/** Reads an icon reference; models write `TrendingUp`, `trending_up` and `lucide:trending-up` alike. */
export function parseIconReference(icon: string | undefined): IconReference | undefined {
  const text = icon?.trim();
  if (!text) return undefined;
  if (/^custom:[a-f0-9]{32}$/.test(text)) return { kind: 'brand', id: text };
  const brand = /^brand:(.+)$/i.exec(text);
  if (brand) {
    const id = BRAND_IDS.get(brand[1].toLowerCase());
    return id ? { kind: 'brand', id } : undefined;
  }
  const name = text.replace(/^lucide:/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .replace(/[_.\s]+/g, '-')
    .toLowerCase();
  return /^[a-z0-9-]+$/.test(name) ? { kind: 'lucide', name } : undefined;
}

const has = (icons: LucideIconData, name: string) => Object.prototype.hasOwnProperty.call(icons, name);

export function lucideNodes(icons: LucideIconData, name: string): LucideNode[] | undefined {
  if (!has(icons, name)) {
    // `chart-2` and `chart2` are both written for names such as `bar-chart-2`.
    const compact = name.replace(/-(\d)/g, '$1');
    if (compact === name || !has(icons, compact)) return undefined;
    name = compact;
  }
  const entry = icons[name];
  const nodes = typeof entry === 'string' ? icons[entry] : entry;
  return Array.isArray(nodes) ? nodes : undefined;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

/** The icon as standalone markup, for a document that carries no icon library. */
export function lucideMarkup(nodes: readonly LucideNode[], size: number): string {
  const body = nodes.map(([tag, attributes]) =>
    `<${tag}${Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`).join('')}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

let iconsPromise: Promise<LucideIconData> | undefined;
/** The whole set is one lazily loaded document, fetched the first time a panel shows an icon. */
export function loadLucideIcons(): Promise<LucideIconData> {
  if (!iconsPromise) {
    iconsPromise = import('../generated/lucideIcons.json')
      .then(module => module.default as unknown as LucideIconData)
      .catch(error => { iconsPromise = undefined; throw error; });
  }
  return iconsPromise;
}
