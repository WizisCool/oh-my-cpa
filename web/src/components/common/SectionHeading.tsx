import React from 'react';
import clsx from 'clsx';

export interface SectionHeadingProps {
  title: React.ReactNode;
  /**
   * `section` opens a part of a page; `group` opens a panel, a settings group or a drawer section;
   * `label` names a short run of fields or facts inside one of those.
   */
  level?: 'section' | 'group' | 'label';
  /** The element the title is, chosen by the document outline rather than by how it looks. */
  as?: 'h2' | 'h3' | 'h4' | 'div';
  /** How many entries the section holds, set after the title in tabular numerals. */
  count?: React.ReactNode;
  /** One line under the title; a `label` has no room for one and ignores it. */
  description?: React.ReactNode;
  /** A control or status that belongs to this section alone, at the head's trailing edge. */
  extra?: React.ReactNode;
  /** Lands on the title, for `aria-labelledby`. */
  id?: string;
  /** Lands on the description, for `aria-describedby`. */
  descriptionId?: string;
  className?: string;
}

/**
 * The head of a section at one of three weights.
 *
 * Every drawer and settings panel drew its own, which left the console with six heading sizes for
 * three jobs and a different case and letter-spacing on each. The frame around the head - padding,
 * a rule, a tinted strip - stays with the caller through `className`; the type, the count and the
 * placement of `extra` belong here.
 */
export function SectionHeading({
  title,
  level = 'group',
  as: Title = 'h3',
  count,
  description,
  extra,
  id,
  descriptionId,
  className,
}: SectionHeadingProps) {
  const hasDescription = level !== 'label' && description !== undefined && description !== null && description !== false;
  const hasExtra = extra !== undefined && extra !== null && extra !== false;
  return (
    <div className={clsx('section-head', `is-${level}`, className)}>
      <div className="section-head-main">
        <Title className="section-head-title" id={id}>
          {title}
          {count !== undefined && count !== null && <span className="section-head-count">{count}</span>}
        </Title>
        {hasDescription && <p className="section-head-description" id={descriptionId}>{description}</p>}
      </div>
      {hasExtra && <div className="section-head-extra">{extra}</div>}
    </div>
  );
}
