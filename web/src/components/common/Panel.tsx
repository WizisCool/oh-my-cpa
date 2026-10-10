import { Card, type CardProps } from 'antd';
import clsx from 'clsx';

/**
 * Padding and density are the surface's, not the caller's: an inline body padding outranks the
 * stylesheet's phone rules, which is how a tile kept its desktop inset on a 360px screen.
 */
export type PanelProps = Omit<CardProps, 'styles' | 'classNames' | 'size' | 'variant' | 'hoverable'>;

/**
 * The framed surface a page sets its content on: one border, one radius, one inset.
 *
 * `title` and `extra` draw the header rule; a panel whose heading needs a description or a count
 * leaves them out and opens its body with a `SectionHeading` instead.
 */
export function Panel({ className, ...props }: PanelProps) {
  return <Card {...props} className={clsx('panel', className)} />;
}
