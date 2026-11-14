import { docs } from 'fumadocs-mdx:collections/server';
import { loader } from 'fumadocs-core/source';
import { BookMarked, Code, Download, Rocket, Server, Sparkles } from 'lucide-react';
import { createElement } from 'react';
import { i18n } from '@/lib/i18n';

/** Section icons named in `scripts/sync-docs-site.mjs` (`DOCS_SECTIONS[].icon`). */
const ICON_MAP = {
  BookMarked,
  Code,
  Download,
  Rocket,
  Server,
  Sparkles,
} as const;

export const source = loader({
  baseUrl: '/',
  i18n,
  source: docs.toFumadocsSource(),
  icon(icon) {
    if (!icon || !(icon in ICON_MAP)) return;
    return createElement(ICON_MAP[icon as keyof typeof ICON_MAP]);
  },
});
