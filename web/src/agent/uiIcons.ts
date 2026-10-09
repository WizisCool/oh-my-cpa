import { api } from '../api/client';
import { resolveMarkArtwork } from '../components/LobeIcon';
import { loadLucideIcons, lucideMarkup, lucideNodes, parseIconReference } from './agentIcons';

import type { UIIconAssets } from './uiAssets';
/** Load only explicitly named assets. Frames cannot fetch artwork or choose authenticated URLs. */
export async function loadUIIcons(names: readonly string[], signal?: AbortSignal): Promise<UIIconAssets> {
  const references = [...new Set(names)].map(name => ({ name, reference: parseIconReference(name) }));
  const lucide = references.some(item => item.reference?.kind === 'lucide') ? await loadLucideIcons() : undefined;
  const custom = references.some(item => item.reference?.kind === 'brand' && item.reference.id.startsWith('custom:'))
    ? await api.getCustomIcons().catch(() => []) : [];
  const assets: UIIconAssets = {};
  await Promise.all(references.map(async ({ name, reference }) => {
    if (!reference || signal?.aborted) return;
    if (reference.kind === 'lucide') {
      const nodes = lucide ? lucideNodes(lucide, reference.name) : undefined;
      if (nodes) assets[name] = { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(lucideMarkup(nodes, 24))}`, isMono: true };
      return;
    }
    const artwork = resolveMarkArtwork(reference.id, undefined, custom);
    if (!artwork) return;
    // Resolved URLs are owned by the console: a bundled file or a protected icon endpoint.
    try {
      const response = await fetch(artwork.url, { signal });
      if (!response.ok) return;
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!mime || !['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      assets[name] = { url: `data:${mime};base64,${btoa(binary)}`, isMono: artwork.isMono };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Missing artwork is a neutral icon, not a failed analytical answer.
    }
  }));
  return assets;
}
