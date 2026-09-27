import React from 'react';
import { DownOutlined, UpOutlined } from '../icons';
import styles from './ProviderEditorDrawer.module.css';

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
          {count !== undefined && <span className={styles['section-count']}>{count}</span>}
        </span>
        <span className={styles['section-chevron']} aria-hidden="true">
          {isOpen ? <UpOutlined /> : <DownOutlined />}
        </span>
      </button>
      {isOpen && <div className={styles['section-body']}>{children}</div>}
    </section>
  );
}
