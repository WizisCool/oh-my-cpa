import React from 'react';
import { Think } from '@ant-design/x';
import { useI18n } from '../../i18n';
import { ModelMarkdown } from './ModelMarkdown';
import styles from './Workspace.module.css';

export interface ReasoningBlockProps {
  text?: string;
  /** Reasoning is still arriving. */
  isThinking: boolean;
}

/**
 * A model's reasoning, as Ant Design X's `Think` disclosure.
 *
 * It opens while reasoning streams, because reading it live is the reason to show it at all, and
 * it starts closed for an answer that has already finished. The initial state is read once, at
 * mount; after that the disclosure is the reader's, so an answer that starts arriving never
 * closes a block someone is reading.
 *
 * `blink` is left off: it is a sweeping gradient over the title, which §7 of the design system
 * rules out. The spinner already says the phase is live.
 */
export const ReasoningBlock = React.memo(function ReasoningBlock({ text, isThinking }: ReasoningBlockProps) {
  const { t } = useI18n();
  const [isOpenAtMount] = React.useState(isThinking);
  return (
    <Think
      className={styles['reasoning']}
      title={t(isThinking ? 'pg.thinking' : 'pg.thought_process')}
      loading={isThinking}
      defaultExpanded={isOpenAtMount}
    >
      {text ? (
        <ModelMarkdown
          content={text}
          isStreaming={isThinking}
          externalImageLabel={t('pg.external_image')}
          className={styles['reasoning-text']}
        />
      ) : null}
    </Think>
  );
});
