'use client';

import type { Framework } from 'fumadocs-core/framework';
import NextLink from 'next/link';
import type { ComponentProps } from 'react';

export const SiteLink: NonNullable<Framework['Link']> = function SiteLink({
  href = '#',
  prefetch,
  ...props
}: ComponentProps<NonNullable<Framework['Link']>>) {
  if (href === '/' || href.startsWith('/api-reference') || href.startsWith('/demo')) {
    return <a href={href} {...props} />;
  }
  return <NextLink href={href} prefetch={prefetch} {...props} />;
};
