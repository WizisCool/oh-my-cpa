import React from 'react';
import { Button, Tooltip } from 'antd';
import { ActionBarPrimitive, ComposerPrimitive, MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { clsx } from 'clsx';
import { BugOutlined, ClockCircleOutlined, DatabaseOutlined, EditOutlined, FieldTimeOutlined, HistoryOutlined, ReloadOutlined, ThunderboltOutlined } from '../../components/icons';
import { CopyButton } from '../../components/common/CopyButton';
import { ModelMarkdown } from '../../components/workspace/ModelMarkdown';
import { ReasoningBlock } from '../../components/workspace/ReasoningBlock';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { eventTokensPerSecond } from '../../types/usageEventMetrics';
import { effectiveModel, extractThinking, turnTone } from './state';
import type { Turn } from './state';
import { playgroundErrorKey } from './errors';
import type { PlaygroundMessageCustom } from './runtime';
import styles from './PlaygroundPage.module.css';

/** The operator's message: its text and the images that went with it. */
const UserContent = React.memo(function UserContent({ turn }: { turn: Turn }) {
  const { t } = useI18n();
  const text = turn.user.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n');
  const images = turn.user.content.flatMap(part => (part.type === 'image_url' ? [part.image_url.url] : []));
  return (
    <div>
      {text && <div className={workspace['user-text']}>{text}</div>}
      {images.length > 0 && (
        <div className={workspace['user-images']}>
          {/* A stored image that was too large to keep is a placeholder, not a URL. */}
          {images.map((url, position) => (url.startsWith('data:')
            ? <img key={position} src={url} alt={t('pg.attached_image')} />
            : <span key={position} className={styles['image-omitted']}>{t('pg.attached_image')}</span>))}
        </div>
      )}
    </div>
  );
});

/**
 * The operator's message as a thread message. The last one can be edited in place: the edit is
 * the same request asked again with different words (`editedTurn`), so it replaces the answer
 * below it rather than adding a turn.
 */
export function UserMessage({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const { turn } = useAuiState(state => state.message.metadata.custom) as PlaygroundMessageCustom;
  const isLast = useAuiState(state => state.message.isLast || state.thread.messages.at(-2)?.id === state.message.id);
  const isEditing = useAuiState(state => state.message.composer.isEditing);
  if (isEditing) {
    return (
      <MessagePrimitive.Root className={workspace['message']} data-role="user">
        <ComposerPrimitive.Root className={clsx(workspace['composer-frame'], styles['edit-frame'])}>
          <div className={workspace['composer-body']}>
            <ComposerPrimitive.Input className={workspace['composer-input']} aria-label={t('pg.edit_message')} submitMode="enter" minRows={1} maxRows={8} />
          </div>
          <div className={workspace['composer-foot']}>
            <span className={workspace['composer-foot-start']} />
            <ComposerPrimitive.Cancel asChild><Button size="small">{t('common.cancel')}</Button></ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send asChild><Button size="small" type="primary">{t('pg.edit_send')}</Button></ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root className={workspace['message']} data-role="user">
      <div className={workspace['user-bubble']}>
        <UserContent turn={turn} />
      </div>
      {canEdit && isLast && (
        <ActionBarPrimitive.Root className={workspace['foot-actions']}>
          <Tooltip title={t('pg.edit_message')}>
            <ActionBarPrimitive.Edit asChild>
              <Button type="text" size="small" aria-label={t('pg.edit_message')} icon={<EditOutlined />} />
            </ActionBarPrimitive.Edit>
          </Tooltip>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}

export interface AssistantMessageProps {
  canRetry: boolean;
  /** Whether the turn can be replayed; says why not when it cannot. */
  isReplayable: (turn: Turn) => boolean;
  onInspect: (turn: Turn) => void;
  onOpenRequests: (turn: Turn) => void;
}

interface AssistantContentProps extends AssistantMessageProps {
  turn: Turn;
  isLast: boolean;
}

/** One answer as a thread message; the turn it draws is the Playground's own. */
export function AssistantMessage(props: AssistantMessageProps) {
  const { turn } = useAuiState(state => state.message.metadata.custom) as PlaygroundMessageCustom;
  const isLast = useAuiState(state => state.message.isLast);
  return (
    <MessagePrimitive.Root className={workspace['message']} data-role="assistant">
      <AssistantContent {...props} turn={turn} isLast={isLast} />
    </MessagePrimitive.Root>
  );
}

/**
 * One answer: who answered and how it ended, the reasoning, the text, and what it cost.
 *
 * Memoised on the turn object. The streaming turn is the only one whose object changes while an
 * answer arrives, so a new token re-parses one answer rather than the whole conversation.
 */
const AssistantContent = React.memo(function AssistantContent({ turn, isLast, canRetry, isReplayable, onInspect, onOpenRequests }: AssistantContentProps) {
  const { t } = useI18n();
  const isRunning = turn.status === 'running';
  // Reasoning arrives either as its own event stream or inline in `<think>` tags, depending on the
  // provider; both are presented the same way.
  const inline = React.useMemo(() => extractThinking(turn.reply), [turn.reply]);
  const thought = turn.thought ?? inline.thought;
  const reply = turn.thought !== undefined ? turn.reply : inline.reply;
  const isThinking = isRunning && (turn.thought !== undefined ? !reply.trim() : Boolean(inline.isThinking));
  const isWaiting = isRunning && !reply.trim() && !thought;

  return (
    <div className={workspace['answer']} data-testid="playground-answer">
      <div className={workspace['message-head']}>
        <span className={workspace['message-model']}>{effectiveModel(turn.request)}</span>
        <span className={workspace['status']}>
          <span className={workspace['pip']} data-tone={turnTone(turn.status)} aria-hidden="true" />
          {t(`pg.status.${turn.status}`)}
        </span>
      </div>
      {(thought || isThinking) && <ReasoningBlock text={thought} isThinking={isThinking} />}
      {reply ? (
        <ModelMarkdown content={reply} isStreaming={isRunning} externalImageLabel={t('pg.external_image')} />
      ) : isWaiting ? (
        <div className={styles['waiting']} role="status">{t('pg.waiting')}</div>
      ) : !isRunning && !thought ? (
        <div className={styles['no-content']}>{t('pg.no_content')}</div>
      ) : null}
      {turn.error && (
        <div className={styles['turn-error']} role="alert">
          <span>{t(playgroundErrorKey(turn.error.code ?? ''))}</span>
          <code>{[turn.error.code, turn.error.upstream_status, turn.error.parameter].filter(Boolean).join(' · ')}</code>
        </div>
      )}
      {!isRunning && (
        <TurnFooter
          turn={turn}
          isLast={isLast}
          canRetry={canRetry}
          isReplayable={isReplayable}
          onInspect={onInspect}
          onOpenRequests={onOpenRequests}
        />
      )}
    </div>
  );
});

function TurnFooter({ turn, isLast, canRetry, isReplayable, onInspect, onOpenRequests }: AssistantContentProps) {
  const { t } = useI18n();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const rate = eventTokensPerSecond({
    generate: true,
    latency_ms: turn.durationMS,
    ttft_ms: turn.firstContentMS,
    tokens: {
      output: turn.usage?.completion_tokens ?? 0,
      total: turn.usage?.total_tokens ?? 0,
      input: turn.usage?.prompt_tokens ?? 0,
      reasoning: 0,
      cached: 0,
      cache_read: 0,
      cache_creation: 0,
    },
    stream: true,
  });
  const milliseconds = (value: number) => `${Math.max(0, value).toLocaleString()} ms`;

  return (
    <div className={workspace['message-foot']}>
      {turn.firstContentMS !== undefined && (
        <Tooltip title={t('pg.first_content')}>
          <span className={workspace['metric']}><FieldTimeOutlined aria-hidden="true" />{milliseconds(turn.firstContentMS)}</span>
        </Tooltip>
      )}
      {turn.durationMS !== undefined && (
        <Tooltip title={t('pg.duration')}>
          <span className={workspace['metric']}><ClockCircleOutlined aria-hidden="true" />{milliseconds(turn.durationMS)}</span>
        </Tooltip>
      )}
      {turn.usage?.total_tokens !== undefined && (
        <Tooltip title={t('pg.total_tokens')}>
          <span className={workspace['metric']}><DatabaseOutlined aria-hidden="true" />{formatTokens(turn.usage.total_tokens, tokenStyle)}</span>
        </Tooltip>
      )}
      {rate.tps !== null && (
        <Tooltip title={`${t(rate.hasTTFT ? 'events.tps_hint_ttft' : 'events.tps_hint_total')} (${rate.formatted})`}>
          <span className={workspace['metric']}><ThunderboltOutlined aria-hidden="true" />{rate.formatted}</span>
        </Tooltip>
      )}
      <span className={workspace['foot-spacer']} />
      <span className={workspace['foot-actions']}>
        <CopyButton text={turn.reply} label={t('pg.copy_answer')} disabled={!turn.reply} />
        <Tooltip title={t(turn.requestID ? 'pg.view_requests' : 'pg.request_id_missing')}>
          <Button type="text" size="small" aria-label={t('pg.view_requests')} disabled={!turn.requestID} icon={<HistoryOutlined />} onClick={() => onOpenRequests(turn)} />
        </Tooltip>
        {isLast && (
          <Tooltip title={t('pg.regenerate')}>
            {/* The framework's reload routes to the same replay the retry always was. A turn whose
                image was dropped from storage cannot be replayed, and says so instead. */}
            <ActionBarPrimitive.Reload asChild disabled={!canRetry}>
              <Button type="text" size="small" aria-label={t('pg.regenerate')} icon={<ReloadOutlined />} onClick={event => { if (!isReplayable(turn)) event.preventDefault(); }} />
            </ActionBarPrimitive.Reload>
          </Tooltip>
        )}
        <Tooltip title={t('pg.inspect')}>
          <Button type="text" size="small" aria-label={t('pg.inspect')} icon={<BugOutlined />} onClick={() => onInspect(turn)} />
        </Tooltip>
      </span>
    </div>
  );
}
