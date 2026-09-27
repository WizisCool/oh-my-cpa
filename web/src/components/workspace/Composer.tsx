import React from 'react';
import { Button, Tooltip } from 'antd';
import { Sender } from '@ant-design/x';
import { clsx } from 'clsx';
import type { SenderProps } from '@ant-design/x';
import { ArrowUpOutlined } from '../icons';
import styles from './Workspace.module.css';

export interface ComposerHandle {
  focus: () => void;
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter and the send button both arrive here, with the text as typed. */
  onSubmit: (value: string) => void;
  onStop: () => void;
  placeholder: string;
  /** The textarea's accessible name. */
  inputLabel: string;
  sendLabel: string;
  /** Draws the send label beside the glyph, for a send that means something other than "send". */
  isSendLabelled?: boolean;
  stopLabel: string;
  isRunning: boolean;
  /** Whether the send button - and therefore Enter - may submit. */
  canSend: boolean;
  /** Disables typing as well, for a composer that has nowhere to send to. */
  isDisabled?: boolean;
  /** Why sending is not possible right now, shown on the send button. */
  blockedReason?: string;
  header?: React.ReactNode;
  footerStart?: React.ReactNode;
  /** A line under the composer: the cost or privacy boundary the operator is about to cross. */
  note?: React.ReactNode;
  onPasteFile?: SenderProps['onPasteFile'];
}

/**
 * The message box both workspaces share.
 *
 * Sending goes through Ant Design X's own `SendButton` even though the button is drawn in the
 * footer: Sender only honours Enter while that button is mounted, because the button is what
 * reports whether a submission is currently allowed. A plain button in its place would leave Enter
 * permanently refused while the click still worked.
 *
 * The textarea is named through the DOM rather than a prop. Sender copies ARIA props onto its
 * container as well as the field, which gives the page two elements with the same name.
 */
export const Composer = React.forwardRef<ComposerHandle, ComposerProps>(function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder,
  inputLabel,
  sendLabel,
  isSendLabelled = false,
  stopLabel,
  isRunning,
  canSend,
  isDisabled = false,
  blockedReason,
  header,
  footerStart,
  note,
  onPasteFile,
}, ref) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => ({
    focus: () => containerRef.current?.querySelector('textarea')?.focus(),
  }), []);

  React.useEffect(() => {
    containerRef.current?.querySelector('textarea')?.setAttribute('aria-label', inputLabel);
  }, [inputLabel, isDisabled]);

  const footer: SenderProps['footer'] = (_, { components: { SendButton } }) => (
    <div className={styles['composer-foot']}>
      <div className={styles['composer-foot-start']}>{footerStart}</div>
      {isRunning ? (
        <Tooltip title={stopLabel}>
          <Button className={styles['stop-button']} aria-label={stopLabel} onClick={onStop} icon={<span className={styles['stop-glyph']} aria-hidden="true" />} />
        </Tooltip>
      ) : (
        <Tooltip title={canSend ? sendLabel : blockedReason}>
          <SendButton
            type="primary"
            shape="default"
            className={clsx(styles['send-button'], isSendLabelled && styles['is-labelled'])}
            aria-label={sendLabel}
            icon={<ArrowUpOutlined />}
            disabled={!canSend}
          >
            {isSendLabelled ? sendLabel : null}
          </SendButton>
        </Tooltip>
      )}
    </div>
  );

  return (
    <div className={styles['composer']} ref={containerRef}>
      <Sender
        className={styles['sender']}
        value={value}
        onChange={next => onChange(next)}
        onSubmit={onSubmit}
        onCancel={onStop}
        loading={isRunning}
        disabled={isDisabled}
        placeholder={placeholder}
        submitType="enter"
        autoSize={{ minRows: 2, maxRows: 10 }}
        header={header || false}
        footer={footer}
        suffix={false}
        onPasteFile={onPasteFile}
      />
      {note && <p className={styles['composer-note']}>{note}</p>}
    </div>
  );
});
