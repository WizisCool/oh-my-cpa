import { zhCN } from '@fumadocs/language/zh-cn';
import { uiTranslations } from 'fumadocs-ui/i18n';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { BookOpen, ExternalLink, Home, Play } from 'lucide-react';
import { i18n } from '@/lib/i18n';

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

export function baseOptions(locale: string): BaseLayoutProps {
  const isZh = locale === 'zh';

  return {
    githubUrl: 'https://github.com/WizisCool/oh-my-cpa',
    nav: {
      url: `/${locale}`,
      title: (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <svg
            aria-hidden="true"
            viewBox="2 2 60 60"
            width="20"
            height="20"
            className="shrink-0"
          >
            <path
              fill="currentColor"
              d="M 13 2 H 51 A 11 11 0 0 1 62 13 V 30 H 47 V 19 A 2 2 0 0 0 45 17 H 19 A 2 2 0 0 0 17 19 V 45 A 2 2 0 0 0 19 47 H 26 V 62 H 13 A 11 11 0 0 1 2 51 V 13 A 11 11 0 0 1 13 2 Z"
            />
            <path
              fill="var(--color-fd-primary)"
              d="M 47 36 H 62 V 51 A 11 11 0 0 1 51 62 H 32 V 47 H 45 A 2 2 0 0 0 47 45 Z"
            />
          </svg>
          <span>Oh My CPA</span>
        </span>
      ),
    },
    links: [
      {
        type: 'main',
        text: isZh ? '官网首页' : 'Home',
        url: '/',
        icon: <Home className="size-4" />,
      },
      {
        type: 'main',
        text: isZh ? '在线演示' : 'Live Demo',
        url: '/demo/',
        icon: <Play className="size-4" />,
      },
      {
        type: 'main',
        text: isZh ? 'API 参考' : 'API Reference',
        url: '/api-reference/',
        icon: <BookOpen className="size-4" />,
      },
      {
        type: 'main',
        text: isZh ? '版本发布' : 'Releases',
        url: 'https://github.com/WizisCool/oh-my-cpa/releases',
        external: true,
        icon: <ExternalLink className="size-4" />,
      },
    ],
  };
}
