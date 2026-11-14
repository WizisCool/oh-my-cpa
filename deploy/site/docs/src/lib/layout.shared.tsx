import { zhCN } from '@fumadocs/language/zh-cn';
import { uiTranslations } from 'fumadocs-ui/i18n';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { i18n } from '@/lib/i18n';
import { asLang, GITHUB_URL } from '@/lib/site';

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .preset('zh', zhCN())
  .add({
    en: {
      displayName: 'English',
    },
    zh: {
      displayName: '简体中文',
    },
  });

const NAV_TEXT = {
  en: { home: 'Home', docs: 'Docs', api: 'API', demo: 'Live demo' },
  zh: { home: '首页', docs: '文档', api: 'API', demo: '在线演示' },
} as const;

export function BrandTitle() {
  return (
    <span className="inline-flex items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/docs/brand/wordmark-light.svg" alt="Oh My CPA" className="h-[18px] w-auto dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/docs/brand/wordmark-dark.svg" alt="Oh My CPA" className="hidden h-[18px] w-auto dark:block" />
    </span>
  );
}

export function baseOptions(locale: string): BaseLayoutProps {
  const lang = asLang(locale);
  const text = NAV_TEXT[lang];

  return {
    githubUrl: GITHUB_URL,
    nav: {
      url: `/${lang}`,
      title: <BrandTitle />,
    },
    links: [
      { type: 'main', on: 'nav', text: text.home, url: '/' },
      { type: 'main', on: 'nav', text: text.docs, url: `/${lang}`, active: 'nested-url' },
      { type: 'main', on: 'nav', text: text.api, url: '/api-reference/' },
      { type: 'main', on: 'nav', text: text.demo, url: '/demo/' },
    ],
  };
}
