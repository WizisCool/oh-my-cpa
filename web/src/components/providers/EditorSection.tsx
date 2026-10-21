import React from 'react';
import { DownOutlined } from '../icons';
import styles from './ProviderEditorDrawer.module.css';
import { Count } from '../common/Count';
import { Fold } from '../common/Fold';

export interface EditorSectionProps {
  title: React.ReactNode;
  /** How many entries the section holds; omitted, the head shows the title alone. */
  count?: number;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

/**
 * One collapsible group of the provider editor (keys, headers, models).
 *
 * The head is a real button carrying `aria-expanded`, so the three groups open from the keyboard
 * and a screen reader hears whether each is open - the clickable `div` it replaces offered neither.
 */
export function EditorSection({ title, count, isOpen, onToggle, children }: EditorSectionProps) {
  return (
    <section className={styles['section']}>
      <button type="button" className={styles['section-head']} aria-expanded={isOpen} onClick={onToggle}>
        <span className={styles['section-title']}>
          {title}
          {count !== undefined && <Count className={styles['section-count']}>{count}</Count>}
        </span>
        <span className={styles['section-chevron']} aria-hidden="true">
          <DownOutlined className={styles['chevron']} />
        </span>
      </button>
      <Fold isOpen={isOpen} className={styles['section-body']}>{children}</Fold>
    </section>
  );
}
