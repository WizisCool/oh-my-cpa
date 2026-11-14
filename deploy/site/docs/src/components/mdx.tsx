import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import Link from 'next/link';
import type { MDXComponents } from 'mdx/types';
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from 'react';

function DocsImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      alt={props.alt ?? ''}
      loading={props.loading ?? 'lazy'}
      className={['rounded-lg border border-fd-border', props.className].filter(Boolean).join(' ')}
    />
  );
}

export function DocsAnchor({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!href || href.startsWith('#')) {
    return <a href={href} {...props} />;
  }
  if (
    href === '/' ||
    href.startsWith('/api-reference') ||
    href.startsWith('/demo') ||
    href.startsWith('http://') ||
    href.startsWith('https://')
  ) {
    const isCrossOrigin = href.startsWith('http://') || href.startsWith('https://');
    return (
      <a
        href={href}
        {...(isCrossOrigin ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        {...props}
      />
    );
  }
  const normalizedHref = href.startsWith('/docs/') ? href.slice('/docs'.length) : href;
  return <Link href={normalizedHref} {...props} />;
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Callout,
    Card,
    Cards,
    Step,
    Steps,
    Tab,
    Tabs,
    img: DocsImage,
    a: DocsAnchor,
    ...components,
  };
}
