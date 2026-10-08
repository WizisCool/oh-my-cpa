import type { DisplayView } from './types';

/** Trusted offline artwork handed into an opaque-origin UI document. */
export interface UIIconAsset { url: string; isMono: boolean }
export type UIIconAssets = Record<string, UIIconAsset>;

export function uiIconReferences(view: DisplayView): string[] {
  return [...new Set([...(view.icons ?? []), ...(view.blocks ?? []).flatMap(block => (block.items ?? []).map(item => item.icon).filter((icon): icon is string => !!icon))])];
}

export function isEmbeddedIcon(asset: UIIconAsset): boolean {
  return /^data:image\/(?:svg\+xml|png|jpeg|webp);(?:base64|charset=utf-8),/i.test(asset.url);
}

