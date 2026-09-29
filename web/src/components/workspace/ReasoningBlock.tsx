import React from 'react';
import { clsx } from 'clsx';
import { useI18n } from '../../i18n';
import { BulbOutlined, RightOutlined } from '../icons';
import { ModelMarkdown } from './ModelMarkdown';
import styles from './Workspace.module.css';

export interface ReasoningBlockProps {
  text?: string;
  /** Reasoning is still arriving. */
  isThinking: boolean;
}

/**
 * A model's reasoning, as a disclosure.
 *
 * It opens while reasoning streams, because reading it live is the reason to show it at all, and
 * it starts closed for an answer that has already finished. The initial state is read once, at
 * mount; after that the disclosure is the reader's, so an answer that starts arriving never closes
 * a block someone is reading. The live state is a steady label, not a sweeping gradient: §7 of the
 * design system rules that out, and the activity strip already says the phase is live.
 */
export const ReasoningBlock = React.memo(function ReasoningBlock({ text, isThinking }: ReasoningBlockProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(isThinking);
  const contentID = React.useId();
  return (
    <div className={clsx(styles['reasoning'], isThinking && styles['is-thinking'])}>
      <button
        type="button"
        className={styles['reasoning-toggle']}
        aria-expanded={isOpen}
        aria-controls={contentID}
        onClick={() => setIsOpen(value => !value)}
      >
        <BulbOutlined aria-hidden="true" />
        <span>{t(isThinking ? 'pg.thinking' : 'pg.thought_process')}</span>
        <RightOutlined className={styles['reasoning-caret']} aria-hidden="true" />
      </button>
      {isOpen && text ? (
        <div id={contentID} className={styles['reasoning-body']}>
          <ModelMarkdown content={text} isStreaming={isThinking} externalImageLabel={t('pg.external_image')} className={styles['reasoning-text']} />
        </div>
      ) : null}
    </div>
  );
});
