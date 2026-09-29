import React from 'react';
import { Button, Tooltip } from 'antd';
import { AttachmentPrimitive, ComposerPrimitive, QueueItemPrimitive, useAui, useAuiState } from '@assistant-ui/react';
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
 * Enter and the send button both ask the runtime to send, and the runtime decides against its live
 * state. The framework's own send controls decide from the state their last render saw, which
 * reaches them a task after the page changed it: a key or click arriving in that window - the
 * operator fixing what blocked sending and pressing Enter at once - would be refused in silence.
 * The button's blocked look is drawn from rendered state and `aria-disabled`, never the `disabled`
 * attribute, which would drop the click before the runtime could accept it.
 *
 * Plain Enter sends and Shift+Enter keeps the newline; an Enter that confirms an IME composition is
 * not a send - `isComposing`, plus keyCode 229 for Safari, which ends the composition before the
 * keydown it belongs to.
 *
 * On a phone the conversation is most of the screen and the keyboard takes half of what is left,
 * so the box starts at one line with send - and the attachment picker - beside it, and a foot row
 * exists only when the page has a control of its own to put in it.
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
  const aui = useAui();
  const isRunning = useAuiState(state => state.thread.isRunning);
  const canSend = useAuiState(state => state.composer.canSend);
  const hasQueue = useAuiState(state => state.thread.capabilities.queue);

  const submit = () => {
    const thread = aui.thread.getState();
    // Without a queue a run in flight owns the thread; the typed message stays in the box.
    if (thread.isRunning && !thread.capabilities.queue) return;
    aui.composer.send();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // Taken over from the primitive, whose own Enter would submit through its render-time check.
    event.preventDefault();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    submit();
  };

  const send = (
    <Tooltip title={canSend ? sendLabel : blockedReason}>
      <Button
        type="primary"
        className={clsx(styles['send-button'], isSendLabelled && styles['is-labelled'])}
        aria-label={sendLabel}
        aria-disabled={!canSend || undefined}
        icon={<ArrowUpOutlined />}
        onClick={submit}
      >
        {isSendLabelled ? sendLabel : null}
      </Button>
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
  // On a phone the picker sits beside send, so an attachment alone never costs the box a row.
  const start = (footerStart || (addAttachment && !isPhone)) ? <>{!isPhone && addAttachment}{footerStart}</> : null;

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
          {isPhone && addAttachment}
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
