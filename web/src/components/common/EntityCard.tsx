import React from 'react';
import clsx from 'clsx';
import { m } from '../../motion';
import styles from './EntityCard.module.css';

type ArticleProps = React.ComponentPropsWithoutRef<typeof m.article>;

export interface EntityCardProps extends Omit<ArticleProps, 'children'> {
  /** The record's mark tile. */
  mark: React.ReactNode;
  name: React.ReactNode;
  /** One secondary line under the name, usually a `MetaLine`. */
  subline?: React.ReactNode;
  /** The trailing corner of the head: the card's one forward action or its tools, ending with the menu. */
  aside?: React.ReactNode;
  /** The body: the description and one fact or a row of tags, on the card's own ground. */
  children?: React.ReactNode;
  /** The record's state. */
  footerStart?: React.ReactNode;
  /** The record's switch or outbound links. */
  footerEnd?: React.ReactNode;
  /** Laid over the card's leading edge, such as a reorder grip. */
  edge?: React.ReactNode;
  /** A featured section's card: the same anatomy, drawn larger. */
  isFeatured?: boolean;
}

/**
 * One record of a grid, on the console's one card anatomy (docs/dev/design.md, Entity cards): a head
 * with the mark, the name and its secondary line, and a trailing corner for actions; a body for the
 * description and tags, on the card's own ground; and a foot with the state on the leading side and the switch or links
 * on the trailing side. Every state of a record fills the same slots, so a grid of them scans across.
 */
export const EntityCard = React.forwardRef<HTMLElement, EntityCardProps>(function EntityCard(
  { mark, name, subline, aside, children, footerStart, footerEnd, edge, isFeatured = false, className, ...rest },
  ref,
) {
  const hasFoot = Boolean(footerStart) || Boolean(footerEnd);
  return (
    <m.article {...rest} ref={ref} className={clsx(styles['entity-card'], isFeatured && styles['is-featured'], className)}>
      {edge}
      <div className={styles.head}>
        <span className={styles.mark}>{mark}</span>
        <div className={styles.title}>
          <div className={styles.name}>{name}</div>
          {subline && <div className={styles.subline}>{subline}</div>}
        </div>
        {aside && <div className={styles.aside}>{aside}</div>}
      </div>
      {children && <div className={styles.body}>{children}</div>}
      {hasFoot && (
        <div className={styles.foot}>
          <div className={styles['foot-start']}>{footerStart}</div>
          <div className={styles['foot-end']}>{footerEnd}</div>
        </div>
      )}
    </m.article>
  );
});
