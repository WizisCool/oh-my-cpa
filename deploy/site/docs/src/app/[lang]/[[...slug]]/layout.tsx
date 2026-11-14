import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import type { ReactNode } from 'react';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default async function DocsShellLayout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>;
  children: ReactNode;
}) {
  const { lang } = await params;
  const base = baseOptions(lang);

  return (
    <DocsLayout {...base} nav={{ ...base.nav, mode: 'top' }} tabs={false} tree={source.getPageTree(lang)}>
      {children}
    </DocsLayout>
  );
}
