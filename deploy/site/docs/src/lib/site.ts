import { AGENT_GUIDE_URL, GITHUB_URL, SITE_ORIGIN } from '../../../site-meta.mjs';

/** Facts shared by every page of the public site. */
export { AGENT_GUIDE_URL, GITHUB_URL, SITE_ORIGIN };
export const GITHUB_SOURCE = `${GITHUB_URL}/blob/main`;

export type Lang = 'en' | 'zh';

export function asLang(value: string): Lang {
  return value === 'zh' ? 'zh' : 'en';
}

/** The prompt a reader pastes into a coding agent; it must match `docs/install-for-agents.md`. */
export const AGENT_PROMPT: Record<Lang, string> = {
  en: `Install Oh My CPA for me by following\n${AGENT_GUIDE_URL}`,
  zh: `请按照 ${AGENT_GUIDE_URL} 为我安装 Oh My CPA`,
};

/** Docs pages are published at `/docs/<lang>/<slug>/` with a Markdown twin at `/docs/<lang>/<slug>.md`. */
export function docsPath(lang: Lang, slugs: string[] = []): string {
  return slugs.length ? `/docs/${lang}/${slugs.join('/')}/` : `/docs/${lang}/`;
}

export function markdownPath(lang: Lang, slugs: string[]): string {
  return `/docs/${lang}/${slugs.join('/')}.md`;
}
