import React from 'react';
import { Button } from 'antd';
import { LabelTip } from '../common/LabelTip';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  QueueItemPrimitive,
  unstable_useComposerInputHistory as useComposerInputHistory,
  unstable_useMentionAdapter as useMentionAdapter,
  unstable_useSlashCommandAdapter as useSlashCommandAdapter,
  unstable_useTriggerPopoverRootContextOptional as useTriggerPopoverRootContextOptional,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import type { DirectiveFormatter } from '@assistant-ui/react';
import { clsx } from 'clsx';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { ArrowUpOutlined, CloseOutlined, PictureOutlined } from '../icons';
import styles from './Workspace.module.css';

/**
 * Something `/` runs: an action of the page, or a setting of the next message. A command is listed
 * only while it can run, so the list never offers a row that would do nothing.
 */
export interface ComposerCommand {
  /** What the operator types after the slash. */
  id: string;
  description: string;
  icon?: React.ReactNode;
  run: () => void;
}

/** A name `@` completes: an identifier the operator would otherwise have to copy from another page. */
export interface ComposerMention {
  id: string;
  label: string;
  /** The kind of thing it names, already localized. */
  group: string;
}

export interface ComposerTriggers {
  commands: ComposerCommand[];
  mentions: ComposerMention[];
  emptyLabel: string;
}

export interface AssistantComposerProps {
  placeholder: string;
  /** The textarea's accessible name. */
  inputLabel: string;
  sendLabel: string;
  stopLabel: string;
  /** Why sending is not possible right now, shown on the send button. */
  blockedReason?: string;
  /** Above the input, inside the frame: a quote, a hint. */
  header?: React.ReactNode;
  /** What the next message carries beyond its text, as removable chips above the input. */
  chips?: React.ReactNode;
  footerStart?: React.ReactNode;
  /** Beside the send control: what the message is sent with, such as the model. */
  footerEnd?: React.ReactNode;
  /** A line under the composer: the cost or privacy boundary the operator is about to cross. */
  note?: React.ReactNode;
  /** A reading under the composer, opposite the note, such as how full the model's context is. */
  status?: React.ReactNode;
  /** Offered when the runtime has an attachment adapter: the picker's label and the remove label. */
  attachments?: { addLabel: string; removeLabel: string; icon?: React.ReactNode };
  /** Offered when the runtime queues messages sent during a run. */
  queue?: { summary: (count: number) => string; removeLabel: string };
  /** Offered when the page has commands or names to complete: `/` and `@` open a list above the box. */
  triggers?: ComposerTriggers;
}

const NO_COMMANDS: ComposerCommand[] = [];
const NO_MENTIONS: ComposerMention[] = [];

/**
 * A mention lands in the message as the name itself. The box is a plain textarea, so the library's
 * directive syntax would be shown to the operator, and sent to the model, as markup around a name
 * that is already unambiguous on its own.
 */
const MENTION_FORMATTER: DirectiveFormatter = {
  serialize: item => item.label,
  parse: text => [{ kind: 'text', text }],
};

const DESKTOP_ROWS = { minRows: 1, maxRows: 10 };
/** The least a `/` or `@` list is given, in pixels: two rows at a finger's height. */
const TRIGGER_MIN_ROOM = 96;
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
 *
 * The frame holds what a message is made of and sent with - attach, the page's own choice such as
 * the model, send - and nothing that only reports: readings sit under it with the note, and `/`
 * and `@` are taught by the placeholder rather than by buttons.
 */
export function AssistantComposer(props: AssistantComposerProps) {
  // The input reads the open list from this root, so it has to sit above the hooks that ask for it.
  return (
    <ComposerPrimitive.TriggerPopoverRoot>
      <ComposerSurface {...props} />
    </ComposerPrimitive.TriggerPopoverRoot>
  );
}

function ComposerSurface({
  placeholder,
  inputLabel,
  sendLabel,
  stopLabel,
  blockedReason,
  header,
  chips,
  footerStart,
  footerEnd,
  note,
  status,
  attachments,
  queue,
  triggers,
}: AssistantComposerProps) {
  const isPhone = useIsPhoneViewport();
  const aui = useAui();
  const isRunning = useAuiState(state => state.thread.isRunning);
  const canSend = useAuiState(state => state.composer.canSend);
  const hasQueue = useAuiState(state => state.thread.capabilities.queue);
  const queuedCount = useAuiState(state => state.composer.queue.length);
  const hasDraft = useAuiState(state => state.composer.text.trim().length > 0 || state.composer.attachments.length > 0);
  const shouldShowStop = isRunning && (!hasQueue || !hasDraft);

  const submit = () => {
    const thread = aui.thread.getState();
    // Without a queue a run in flight owns the thread; the typed message stays in the box.
    if (thread.isRunning && !thread.capabilities.queue) return;
    aui.composer.send();
  };

  const popovers = useTriggerPopoverRootContextOptional();
  const history = useComposerInputHistory();
  const commands = triggers?.commands ?? NO_COMMANDS;
  const slash = useSlashCommandAdapter({
    commands: React.useMemo(() => commands.map(command => ({
      id: command.id,
      label: command.id,
      description: command.description,
      execute: command.run,
    })), [commands]),
    removeOnExecute: true,
  });
  const mentionItems = triggers?.mentions ?? NO_MENTIONS;
  const mention = useMentionAdapter({
    items: React.useMemo(() => mentionItems.map(item => ({
      id: item.id,
      type: 'mention',
      label: item.label,
      description: item.group,
    })), [mentionItems]),
    includeModelContextTools: false,
    formatter: MENTION_FORMATTER,
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // An open list with a highlighted row owns the keys: Enter picks the row, arrows move in it.
    if (popovers?.getActiveAria()?.highlightedItemId) return;
    if (event.key !== 'Enter' || event.shiftKey) {
      // Up on an empty box recalls what was sent before; the hook leaves every other key alone.
      history.onKeyDown(event);
      return;
    }
    // Taken over from the primitive, whose own Enter would submit through its render-time check.
    event.preventDefault();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    submit();
  };

  // Send and stop are one round primary-filled button whose glyph changes: the single filled shape in the
  // frame, so the eye finds the action without reading the row.
  const send = (
    <LabelTip title={canSend ? sendLabel : blockedReason}>
      <button type="button" className={styles['send-button']} aria-label={sendLabel} aria-disabled={!canSend || undefined} onClick={submit}>
        <ArrowUpOutlined aria-hidden="true" />
      </button>
    </LabelTip>
  );
  const stop = (
    <LabelTip title={stopLabel}>
      <ComposerPrimitive.Cancel asChild>
        <button type="button" className={styles['send-button']} data-action="stop" aria-label={stopLabel}>
          <span className={styles['stop-glyph']} aria-hidden="true" />
        </button>
      </ComposerPrimitive.Cancel>
    </LabelTip>
  );
  // One action occupies the same slot: an empty running composer stops; a draft can be queued.
  const controls = (
    <span className={styles['composer-controls']}>
      {shouldShowStop ? stop : send}
    </span>
  );
  const addAttachment = attachments && (
    <LabelTip title={attachments.addLabel}>
      <ComposerPrimitive.AddAttachment asChild>
        <Button type="text" shape="circle" className={styles['attach-button']} aria-label={attachments.addLabel} icon={attachments.icon ?? <PictureOutlined />} />
      </ComposerPrimitive.AddAttachment>
    </LabelTip>
  );
  // On a phone the picker sits beside send, so an attachment alone never costs the box a row.
  const start = (footerStart || (addAttachment && !isPhone)) ? (
    <>
      {!isPhone && addAttachment}
      {footerStart}
    </>
  ) : null;
  const iconOf = React.useMemo(() => new Map(commands.map(command => [command.id, command.icon])), [commands]);

  // A list rises from the box into whatever the pane above it has left, which under a phone's
  // keyboard is a few lines. It is measured as a list mounts, and again whenever the pane changes
  // size - a keyboard that opens or closes under an open list moves the box without touching the
  // list - so the list scrolls inside that room instead of running off the pane's top edge.
  const triggerAnchorRef = React.useRef<HTMLDivElement>(null);
  const hasTriggers = !!triggers;
  React.useLayoutEffect(() => {
    const anchor = triggerAnchorRef.current;
    const pane = anchor?.parentElement?.parentElement;
    if (!anchor || !pane) return;
    const measureRoom = () => {
      const paneTop = pane.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(pane).paddingTop);
      anchor.style.setProperty('--trigger-room', `${Math.max(TRIGGER_MIN_ROOM, Math.floor(anchor.getBoundingClientRect().top - paneTop - 4))}px`);
    };
    measureRoom();
    const lists = new MutationObserver(measureRoom);
    lists.observe(anchor, { childList: true });
    const layout = new ResizeObserver(measureRoom);
    layout.observe(pane);
    return () => {
      lists.disconnect();
      layout.disconnect();
    };
  }, [hasTriggers]);

  return (
    <div className={clsx(styles['composer'], isPhone && styles['is-phone'])}>
      {/* Messages sent during a run wait in a tray on the box they were typed in, in the order
          they will go out, each one removable until its turn comes. */}
      {queue && queuedCount > 0 && (
        <div className={styles['queue']} data-testid="composer-queue">
          <div className={styles['queue-head']} role="status">{queue.summary(queuedCount)}</div>
          <ComposerPrimitive.Queue>
            {({ queueItem }) => (
              <div className={styles['queue-item']} data-testid="composer-queue-item" key={queueItem.id}>
                <ArrowUpOutlined className={styles['queue-mark']} aria-hidden="true" />
                <QueueItemPrimitive.Text className={styles['queue-text']} />
                <LabelTip title={queue.removeLabel}>
                  <QueueItemPrimitive.Remove asChild>
                    <Button type="text" size="small" aria-label={queue.removeLabel} icon={<CloseOutlined />} />
                  </QueueItemPrimitive.Remove>
                </LabelTip>
              </div>
            )}
          </ComposerPrimitive.Queue>
        </div>
      )}
      {triggers && (
        <div ref={triggerAnchorRef} className={styles['trigger-anchor']}>
          <ComposerPrimitive.TriggerPopover char="/" adapter={slash.adapter} className={styles['trigger-popover']} data-testid="composer-commands">
            <ComposerPrimitive.TriggerPopover.Action {...slash.action} />
            <TriggerRows prefix="/" emptyLabel={triggers.emptyLabel} iconOf={iconOf} />
          </ComposerPrimitive.TriggerPopover>
          <ComposerPrimitive.TriggerPopover char="@" adapter={mention.adapter} className={styles['trigger-popover']} data-testid="composer-mentions">
            <ComposerPrimitive.TriggerPopover.Directive {...mention.directive} />
            <TriggerRows prefix="" emptyLabel={triggers.emptyLabel} />
          </ComposerPrimitive.TriggerPopover>
        </div>
      )}
      <ComposerPrimitive.Root className={styles['composer-frame']}>
        {attachments && (
          <ComposerPrimitive.AttachmentDropzone className={styles['dropzone']}>
            <ComposerPrimitive.Attachments>
              {({ attachment }) => (
                <AttachmentPrimitive.Root className={styles['attachment']} data-kind={attachment.type === 'image' ? 'image' : 'file'} key={attachment.id}>
                  {attachment.file && attachment.type === 'image'
                    ? <AttachmentThumb file={attachment.file} name={attachment.name} />
                    : <span className={styles['attachment-name']}><AttachmentPrimitive.Name /></span>}
                  <AttachmentPrimitive.Remove asChild>
                    <Button type="text" size="small" className={styles['attachment-remove']} aria-label={attachments.removeLabel} icon={<CloseOutlined />} />
                  </AttachmentPrimitive.Remove>
                </AttachmentPrimitive.Root>
              )}
            </ComposerPrimitive.Attachments>
          </ComposerPrimitive.AttachmentDropzone>
        )}
        {header}
        {chips && <div className={styles['composer-chips']}>{chips}</div>}
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
        {(!isPhone || start || footerEnd) && (
          <div className={styles['composer-foot']}>
            <div className={styles['composer-foot-start']}>{start}</div>
            {footerEnd}
            {!isPhone && controls}
          </div>
        )}
      </ComposerPrimitive.Root>
      {(note || status) && (
        <div className={styles['composer-under']}>
          {note && <p className={styles['composer-note']}>{note}</p>}
          {status}
        </div>
      )}
    </div>
  );
}

/** The rows of an open `/` or `@` list: the name in the console's mono face, what it is beside it. */
function TriggerRows({ prefix, emptyLabel, iconOf }: { prefix: string; emptyLabel: string; iconOf?: Map<string, React.ReactNode> }) {
  return (
    <ComposerPrimitive.TriggerPopoverItems className={styles['trigger-rows']}>
      {items => items.length === 0
        ? <span className={styles['trigger-empty']}>{emptyLabel}</span>
        : items.map((item, index) => (
          <ComposerPrimitive.TriggerPopoverItem key={item.id} item={item} index={index} className={styles['trigger-row']}>
            {iconOf && <span className={styles['trigger-icon']} aria-hidden="true">{iconOf.get(item.id)}</span>}
            <span className={styles['trigger-name']}>{prefix}{item.label}</span>
            {item.description && <span className={styles['trigger-description']}>{item.description}</span>}
          </ComposerPrimitive.TriggerPopoverItem>
        ))}
    </ComposerPrimitive.TriggerPopoverItems>
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
