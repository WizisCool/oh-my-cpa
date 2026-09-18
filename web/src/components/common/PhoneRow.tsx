import React from 'react';
import styles from './PhoneRow.module.css';
import type { PhoneRowField } from './phoneRowFields';

export interface PhoneRowProps {
  /** The row's headline: what the record *is*, and any control that renames it. */
  identity: React.ReactNode;
  /**
   * The one value the reader identifies the record by, printed under the headline.
   *
   * Separate from `fields` because it is not a label/value pair: at a phone width the key box
   * of a client key is the row's subject, and labelling it "Key" would spend a line saying
   * what the mask already says.
   */
  summary?: React.ReactNode;
  /** The labelled remainder, derived from the table's own columns. */
  fields?: readonly PhoneRowField[];
  /** The row's controls, on their own line. */
  actions?: React.ReactNode;
}

/**
 * One record, as a phone row.
 *
 * The console's lists are tables on a wide viewport and rows on a phone, and this is the row.
 * It exists as a component rather than as five sets of markup because the *shape* is what is
 * repeated - headline, summary, labelled fields, controls - and the shape is what has to stay
 * consistent for a reader moving between pages.
 *
 * Three of its decisions are load-bearing:
 *
 *   - **The fields are a description list.** `dl`/`dt`/`dd` is what the content is, and it is
 *     what makes a screen reader read a label with its value instead of reading a column of
 *     labels followed by a column of values.
 *   - **The labels are the table's own column titles** (`phoneRowFields`), so a row cannot
 *     label a value differently from the header it replaces and no second string is needed.
 *   - **The controls get their own line.** On a table the action cluster sits in a 4px-gap row
 *     sized for a pointer, which is the cluster the touch rules had to accept overlapping hit
 *     areas for. Here there is a whole line, so the gap is a real one and the overlap the
 *     stylesheet documents does not arise.
 *
 * An empty `fields` array is not an error: a record whose optional columns all render nothing
 * has nothing to list, and a row of empty labels would be noise around the headline.
 */
export const PhoneRow: React.FC<PhoneRowProps> = ({ identity, summary, fields = [], actions }) => (
  /* `data-testid` because the class below is a CSS module's hashed name: a browser check that
     selected on it would break on a rename that changed nothing a reader can see. */
  <article className={styles['phone-row']} data-testid="phone-row">
    <div className={styles['phone-row-head']}>{identity}</div>
    {summary !== undefined && summary !== null && <div className={styles['phone-row-summary']}>{summary}</div>}
    {fields.length > 0 && (
      <dl className={styles['phone-row-fields']}>
        {fields.map((field) => (
          <div className={styles['phone-row-field']} key={field.key}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    )}
    {actions !== undefined && actions !== null && <div className={styles['phone-row-actions']}>{actions}</div>}
  </article>
);
