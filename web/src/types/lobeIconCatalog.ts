import catalog from '../generated/lobeIconCatalog.json';

export interface LobeIconCatalogEntry {
  id: string;
  title: string;
  fullTitle: string;
  docsUrl: string;
  desc: string;
  group: 'model' | 'provider' | 'application';
  hasColor: boolean;
}

export const LOBE_ICON_CATALOG = catalog as LobeIconCatalogEntry[];

export function lobeIconSlug(iconId: string): string {
  return iconId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
