import React from 'react';
import { Button, Tooltip } from 'antd';
import { AttachmentPrimitive, ComposerPrimitive, QueueItemPrimitive, useAuiState } from '@assistant-ui/react';
import { clsx } from 'clsx';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { ArrowUpOutlined, CloseOutlined, PictureOutlined } from '../icons';
import styles from './Workspace.module.css';

export interface AssistantComposerProps {
  placeholder: string;
  /** The textarea's accessible name. */
  inputLabel: string;
  sendLabel: string;
  /** Draws the send label beside the glyph, for a send that means something other than "send". */
  isSendLabelled?: boolean;
  stopLabel: string;
  /** Why sending is not possible right now, shown on the send button. */
  blockedReason?: string;
  /** Above the input, inside the frame: a quote, a hint. */
  header?: React.ReactNode;
  footerStart?: React.ReactNode;
  /** A line under the composer: the cost or privacy boundary the operator is about to cross. */
  note?: React.ReactNode;
  /** Offered when the runtime has an attachment adapter: the picker's label and the remove label. */
  attachments?: { addLabel: string; removeLabel: string };
  /** Offered when the runtime queues messages sent during a run. */
  queue?: { title: string; removeLabel: string };
}

const DESKTOP_ROWS = { minRows: 2, maxRows: 10 };
const PHONE_ROWS = { minRows: 1, maxRows: 5 };

/**
 * The message box both workspaces share, on assistant-ui's composer primitives with Ant Design
 * controls.
 *
 * Whether a message may be sent is the runtime's own state, read in the same render as the button,
 * so Enter and the button can never disagree. Plain Enter sends and Shift+Enter keeps the newline;
 * an Enter that confirms an IME composition is not a send - the primitive checks `isComposing`,
 * and keyCode 229 covers Safari, which ends the composition before the keydown it belongs to.
 *
 * On a phone the conversation is most of the screen and the keyboard takes half of what is left,
 * so the box starts at one line with send beside it, and a foot row exists only when there is a
 * control to put in it.
 */
export function AssistantComposer({
  placeholder,
  inputLabel,
  sendLabel,
  isSendLabelled = false,
  stopLabel,
  blockedReason,
  header,
  footerStart,
  note,
  attachments,
  queue,
}: AssistantComposerProps) {
  const isPhone = useIsPhoneViewport();
  const isRunning = useAuiState(state => state.thread.isRunning);
  const canSend = useAuiState(state => state.composer.canSend);
  const hasQueue = useAuiState(state => state.thread.capabilities.queue);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
  };

  const send = (
    <Tooltip title={canSend ? sendLabel : blockedReason}>
      <ComposerPrimitive.Send asChild>
        <Button
          type="primary"
          className={clsx(styles['send-button'], isSendLabelled && styles['is-labelled'])}
          aria-label={sendLabel}
          icon={<ArrowUpOutlined />}
        >
          {isSendLabelled ? sendLabel : null}
        </Button>
      </ComposerPrimitive.Send>
    </Tooltip>
  );
  const stop = (
    <Tooltip title={stopLabel}>
      <ComposerPrimitive.Cancel asChild>
        <Button className={styles['stop-button']} aria-label={stopLabel} icon={<span className={styles['stop-glyph']} aria-hidden="true" />} />
      </ComposerPrimitive.Cancel>
    </Tooltip>
  );
  // While a run is in flight a queueing runtime still accepts messages, so send sits beside stop.
  const controls = (
    <span className={styles['composer-controls']}>
      {isRunning && stop}
      {(!isRunning || hasQueue) && send}
    </span>
  );
  const addAttachment = attachments && (
    <Tooltip title={attachments.addLabel}>
      <ComposerPrimitive.AddAttachment asChild>
        <Button type="text" size="small" aria-label={attachments.addLabel} icon={<PictureOutlined />} />
      </ComposerPrimitive.AddAttachment>
    </Tooltip>
  );
  const start = (footerStart || addAttachment) ? <>{addAttachment}{footerStart}</> : null;

  return (
    <div className={clsx(styles['composer'], isPhone && styles['is-phone'])}>
      {queue && (
        <ComposerPrimitive.Queue>
          {({ queueItem }) => (
            <div className={styles['queue-item']} data-testid="composer-queue-item" key={queueItem.id}>
              <span className={styles['queue-label']}>{queue.title}</span>
              <QueueItemPrimitive.Text className={styles['queue-text']} />
              <QueueItemPrimitive.Remove asChild>
                <Button type="text" size="small" aria-label={queue.removeLabel} icon={<CloseOutlined />} />
              </QueueItemPrimitive.Remove>
            </div>
          )}
        </ComposerPrimitive.Queue>
      )}
      <ComposerPrimitive.Root className={styles['composer-frame']}>
        {attachments && (
          <ComposerPrimitive.AttachmentDropzone className={styles['dropzone']}>
            <ComposerPrimitive.Attachments>
              {({ attachment }) => (
                <AttachmentPrimitive.Root className={styles['attachment']} key={attachment.id}>
                  {attachment.file && attachment.type === 'image' ? <AttachmentThumb file={attachment.file} name={attachment.name} /> : <AttachmentPrimitive.Name />}
                  <AttachmentPrimitive.Remove asChild>
                    <Button type="text" size="small" className={styles['attachment-remove']} aria-label={attachments.removeLabel} icon={<CloseOutlined />} />
                  </AttachmentPrimitive.Remove>
                </AttachmentPrimitive.Root>
              )}
            </ComposerPrimitive.Attachments>
          </ComposerPrimitive.AttachmentDropzone>
        )}
        {header}
        <div className={styles['composer-body']}>
          <ComposerPrimitive.Input
            className={styles['composer-input']}
            aria-label={inputLabel}
            placeholder={placeholder}
            submitMode="enter"
            cancelOnEscape={false}
            unstable_focusOnRunStart={false}
            onKeyDown={onKeyDown}
            {...(isPhone ? PHONE_ROWS : DESKTOP_ROWS)}
          />
          {isPhone && controls}
        </div>
        {(!isPhone || start) && (
          <div className={styles['composer-foot']}>
            <div className={styles['composer-foot-start']}>{start}</div>
            {!isPhone && controls}
          </div>
        )}
      </ComposerPrimitive.Root>
      {note && <p className={styles['composer-note']}>{note}</p>}
    </div>
  );
}

/** A pending image, previewed from the file the operator chose; the URL lives as long as the chip. */
function AttachmentThumb({ file, name }: { file: File; name: string }) {
  const [url, setURL] = React.useState('');
  React.useEffect(() => {
    const next = URL.createObjectURL(file);
    setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <img src={url} alt={name} /> : null;
}
