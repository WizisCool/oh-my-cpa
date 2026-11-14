import { i18nProvider } from 'fumadocs-ui/i18n';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteLink } from '@/components/site-link';
import { i18n } from '@/lib/i18n';
import { translations } from '@/lib/layout.shared';
import '../global.css';

export const metadata: Metadata = {
  title: {
    template: '%s | Oh My CPA Docs',
    default: 'Oh My CPA Docs',
  },
  description: 'Self-hosted control plane and usage observability console for CLIProxyAPI v8+.',
  icons: {
    icon: '/docs/favicon.svg',
  },
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
        <RootProvider
          components={{ Link: SiteLink }}
          i18n={i18nProvider(translations, lang)}
          search={{
            options: {
              type: 'static',
              api: '/docs/search-index.json',
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
