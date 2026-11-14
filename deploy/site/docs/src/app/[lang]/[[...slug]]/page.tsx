import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/notebook/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsHome } from '@/components/docs-home';
import { DocsAnchor, getMDXComponents } from '@/components/mdx';
import { i18n } from '@/lib/i18n';
import { asLang, docsPath, GITHUB_SOURCE, markdownPath, SITE_ORIGIN } from '@/lib/site';
import { source } from '@/lib/source';

export default async function DocsContentPage(props: {
  params: Promise<{ lang: string; slug?: string[] }>;
}) {
  const params = await props.params;
  const lang = asLang(params.lang);
  const slugs = params.slug ?? [];
  const page = source.getPage(params.slug, params.lang);
  if (!page) notFound();

  if (slugs.length === 0) {
    return (
      <DocsPage full toc={[]} breadcrumb={{ enabled: false }} footer={{ enabled: false }} tableOfContent={{ enabled: false }}>
        <DocsHome lang={lang} />
      </DocsPage>
    );
  }

  const MDX = page.data.body;
  const markdownUrl = markdownPath(lang, slugs);
  const sourceFile = page.data.source;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="flex flex-row flex-wrap items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          pageUrl={`${SITE_ORIGIN}${docsPath(lang, slugs)}`}
          githubUrl={sourceFile ? `${GITHUB_SOURCE}/${sourceFile}` : undefined}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page, DocsAnchor),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams('slug', 'lang');
}

export async function generateMetadata(props: {
  params: Promise<{ lang: string; slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const lang = asLang(params.lang);
  const slugs = params.slug ?? [];
  const page = source.getPage(params.slug, params.lang);
  if (!page) notFound();

  const title = slugs.length === 0 ? { absolute: lang === 'zh' ? 'Oh My CPA 文档' : 'Oh My CPA Docs' } : page.data.title;
  const languages = Object.fromEntries(
    i18n.languages.map((code) => [code === 'zh' ? 'zh-CN' : code, docsPath(asLang(code), slugs)]),
  );
  const image = `/og/docs-${lang}.png`;

  return {
    title,
    description: page.data.description,
    alternates: {
      canonical: docsPath(lang, slugs),
      languages: { ...languages, 'x-default': docsPath('en', slugs) },
      types: slugs.length ? { 'text/markdown': markdownPath(lang, slugs) } : undefined,
    },
    openGraph: {
      type: 'article',
      siteName: 'Oh My CPA',
      locale: lang === 'zh' ? 'zh_CN' : 'en_US',
      url: docsPath(lang, slugs),
      title: typeof title === 'string' ? title : title.absolute,
      description: page.data.description,
      images: [{ url: image, width: 1200, height: 630, alt: 'Oh My CPA' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: typeof title === 'string' ? title : title.absolute,
      description: page.data.description,
      images: [image],
    },
  };
}
