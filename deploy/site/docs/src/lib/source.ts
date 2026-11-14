import { docs } from 'fumadocs-mdx:collections/server';
import { loader } from 'fumadocs-core/source';
import {
  BookOpen,
  Bot,
  Coins,
  Cpu,
  DatabaseBackup,
  Download,
  GitPullRequest,
  Layers,
  Plug,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { createElement } from 'react';
import { i18n } from '@/lib/i18n';

const ICON_MAP = {
  BookOpen,
  Bot,
  Coins,
  Cpu,
  DatabaseBackup,
  Download,
  GitPullRequest,
  Layers,
  Plug,
  Settings,
  ShieldCheck,
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
