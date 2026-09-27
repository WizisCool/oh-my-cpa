import React from 'react';
import { Button, Tooltip } from 'antd';
import { BugOutlined, ClockCircleOutlined, DatabaseOutlined, FieldTimeOutlined, HistoryOutlined, ReloadOutlined, ThunderboltOutlined } from '../../components/icons';
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
import styles from './PlaygroundPage.module.css';

/** The operator's message: its text and the images that went with it. */
export const UserMessage = React.memo(function UserMessage({ turn }: { turn: Turn }) {
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

export interface AssistantMessageProps {
  turn: Turn;
  isLast: boolean;
  canRetry: boolean;
  onRetry: (turn: Turn) => void;
  onInspect: (turn: Turn) => void;
  onOpenRequests: (turn: Turn) => void;
}

/**
 * One answer: who answered and how it ended, the reasoning, the text, and what it cost.
 *
 * Memoised on the turn object. The streaming turn is the only one whose object changes while an
 * answer arrives, so a new token re-parses one answer rather than the whole conversation.
 */
export const AssistantMessage = React.memo(function AssistantMessage({ turn, isLast, canRetry, onRetry, onInspect, onOpenRequests }: AssistantMessageProps) {
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
          onRetry={onRetry}
          onInspect={onInspect}
          onOpenRequests={onOpenRequests}
        />
      )}
    </div>
  );
});

function TurnFooter({ turn, isLast, canRetry, onRetry, onInspect, onOpenRequests }: AssistantMessageProps) {
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
        <Tooltip title={t('pg.view_requests')}>
          <Button type="text" size="small" aria-label={t('pg.view_requests')} icon={<HistoryOutlined />} onClick={() => onOpenRequests(turn)} />
        </Tooltip>
        {isLast && (
          <Tooltip title={t('common.retry')}>
            <Button type="text" size="small" aria-label={t('common.retry')} disabled={!canRetry} icon={<ReloadOutlined />} onClick={() => onRetry(turn)} />
          </Tooltip>
        )}
        <Tooltip title={t('pg.inspect')}>
          <Button type="text" size="small" aria-label={t('pg.inspect')} icon={<BugOutlined />} onClick={() => onInspect(turn)} />
        </Tooltip>
      </span>
    </div>
  );
}
