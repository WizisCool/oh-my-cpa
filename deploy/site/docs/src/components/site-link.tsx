'use client';

import type { Framework } from 'fumadocs-core/framework';
import NextLink from 'next/link';
import type { ComponentProps } from 'react';

/** Paths owned by the rest of the public site rather than by the docs app under `/docs`. */
export function isSiteHref(href: string): boolean {
  return href === '/' || href.startsWith('/api-reference') || href.startsWith('/demo') || href.startsWith('/docs/');
}

export const SiteLink: NonNullable<Framework['Link']> = function SiteLink({
  href = '#',
  prefetch,
  ...props
}: ComponentProps<NonNullable<Framework['Link']>>) {
  if (isSiteHref(href)) {
    return <a href={href} {...props} />;
  }
  return <NextLink href={href} prefetch={prefetch} {...props} />;
};
