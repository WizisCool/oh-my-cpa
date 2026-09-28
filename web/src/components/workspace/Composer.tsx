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
 * Enter and the send button are decided here, from `canSend`, rather than by Sender. Sender keeps
 * its own copy of whether a submission is allowed, which its `SendButton` writes from an effect,
 * so that copy trails the button by one render: an Enter or a click landing between the commit
 * that enables the button and the render that follows was refused in silence, with the message
 * still in the box. Reading the prop the same commit rendered leaves no such window. Sender is
 * given no `onSubmit`, which makes its own send a no-op, and its Enter handling is switched off by
 * answering `false` from `onKeyDown`; `SendButton` stays only for its look, with our own click.
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

  const submit = () => {
    if (canSend) onSubmit(value);
  };

  // Plain Enter sends; Shift+Enter keeps the newline, and a modified Enter is left to the browser.
  // A keypress that confirms an IME composition is not a send: `isComposing` covers most engines,
  // and keyCode 229 covers Safari, which ends the composition before the keydown it belongs to.
  const onKeyDown: SenderProps['onKeyDown'] = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    event.preventDefault();
    submit();
    return false;
  };

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
            onClick={submit}
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
        onKeyDown={onKeyDown}
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
