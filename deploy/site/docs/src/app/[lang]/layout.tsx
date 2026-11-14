import { i18nProvider } from 'fumadocs-ui/i18n';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { LocaleMemory } from '@/components/locale-memory';
import { SiteRootProvider } from '@/components/site-root-provider';
import { i18n } from '@/lib/i18n';
import { translations } from '@/lib/layout.shared';
import { asLang, SITE_ORIGIN } from '@/lib/site';
import '../global.css';

const DESCRIPTION = {
  en: 'Install, operate and extend Oh My CPA, the self-hosted AI gateway console.',
  zh: '安装、运维与扩展 Oh My CPA：自托管的 AI 网关控制台。',
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const lang = asLang((await params).lang);
  return {
    metadataBase: new URL(SITE_ORIGIN),
    title: {
      template: lang === 'zh' ? '%s | Oh My CPA 文档' : '%s | Oh My CPA Docs',
      default: lang === 'zh' ? 'Oh My CPA 文档' : 'Oh My CPA Docs',
    },
    description: DESCRIPTION[lang],
    applicationName: 'Oh My CPA',
    icons: { icon: '/docs/favicon.svg' },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f8' },
    { media: '(prefers-color-scheme: dark)', color: '#131314' },
  ],
};

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function LangRootLayout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>;
  children: ReactNode;
}) {
  const { lang } = await params;

  return (
    <html lang={lang === 'zh' ? 'zh-CN' : 'en'} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <LocaleMemory lang={lang} />
        <SiteRootProvider
          i18n={i18nProvider(translations, lang)}
          search={{
            options: {
              type: 'static',
              api: '/docs/search-index.json',
            },
          }}
        >
          {children}
        </SiteRootProvider>
      </body>
    </html>
  );
}
