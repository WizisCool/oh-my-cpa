import React from 'react';
import { Button, Image, Tooltip } from 'antd';
import { LabelTip } from '../../components/common/LabelTip';
import { ActionBarPrimitive, MessagePartPrimitive, MessagePrimitive, groupPartByType, useAui, useAuiState } from '@assistant-ui/react';
import type { MessagePartState } from '@assistant-ui/react';
import { clsx } from 'clsx';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { CheckOutlined, ClockCircleOutlined, CopyOutlined, DatabaseOutlined, EditOutlined, FileTextOutlined, PaperClipOutlined, ReloadOutlined, RightOutlined, StepsOutlined } from '../../components/icons';
import { ModelMarkdown } from '../../components/workspace/ModelMarkdown';
import { ReasoningBlock } from '../../components/workspace/ReasoningBlock';
import workspace from '../../components/workspace/Workspace.module.css';
import { agentSnapshot } from '../../agent/conversationSnapshot';
import { useConversationExport } from '../../components/workspace/useConversationExport';
import { DISPLAY_TOOLS } from '../../agent/types';
import type { Turn } from '../../agent/types';
import { useI18n } from '../../i18n';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { failureKey, formatClock, formatDuration, isAwaitingAnswer, statusTone, turnDuration, turnLabelKey } from './state';
import { readTurnImages } from './api';
import type { AgentMessageCustom } from './thread';
import { formatBytes } from '../../utils/format';
import { useAgentView } from './tools/AgentViewContext';
import { ToolFallback } from './tools/registry';
import { GenerationLoader } from '../../components/workspace/GenerationLoader';
import { LiveElapsed } from '../../components/workspace/LiveElapsed';
import styles from './AgentPage.module.css';

// User text is plain content, not a paragraph with browser-default vertical margins.
const USER_PART_COMPONENTS = { Text: () => <MessagePartPrimitive.Text smooth={false} /> };

/** The operator's message. */
export function AgentUserMessage() {
  const { t } = useI18n();
  const files = useAuiState(state => (state.message.metadata?.custom as AgentMessageCustom | undefined)?.files);
  const present = useAuiState(state => (state.message.metadata?.custom as AgentMessageCustom | undefined)?.present);
  const images = useAuiState(state => (state.message.metadata?.custom as AgentMessageCustom | undefined)?.images);
  const hasText = useAuiState(state => state.message.parts.some(part => part.type === 'text' && part.text.length > 0));
  return (
    <MessagePrimitive.Root className={workspace['message']} data-role="user">
      {(!!files?.length || present) && (
        <div className={styles['sent-files']} data-testid="agent-sent-files">
          {present && <span className={styles['sent-file']} data-tone="accent" data-testid="agent-sent-present">{t(`agent.present.${present}`)}</span>}
          {files?.map((file, index) => (
            <span key={`${file.name}:${index}`} className={styles['sent-file']}>
              <PaperClipOutlined aria-hidden="true" />
              <span className={styles['sent-file-name']}>{file.name}</span>
              <span className={styles['sent-file-size']}>{formatBytes(file.bytes)}</span>
            </span>
          ))}
        </div>
      )}
      {!!images?.length && (
        <div className={styles['sent-images']} data-testid="agent-sent-images">
          <Image.PreviewGroup>
            {images.map((src, index) => (
              <Image key={`${index}:${src.slice(-24)}`} className={styles['sent-image']} src={src} alt={t('agent.image.alt', { n: index + 1 })} />
            ))}
          </Image.PreviewGroup>
        </div>
      )}
      {hasText && (
        <div className={clsx(workspace['user-bubble'], workspace['user-text'])} data-aui-quote-selectable>
          <MessagePrimitive.Parts components={USER_PART_COMPONENTS} />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

/**
 * Reasoning and capability calls form the answer's chain of thought; the answer text stays outside
 * it. A display call is left out of the chain: it is drawn where the model made it, as the figure
 * itself, so the model decides what the reader meets before and after it (ADR 0082).
 */
const GROUP_BY = groupPartByType({
  reasoning: ['group-chain'],
  'tool-call': ['group-chain'],
  ...Object.fromEntries(DISPLAY_TOOLS.map(name => [`tool-call:${name}`, []])),
});

type GroupPart = { readonly type: `group-${string}`; readonly indices: readonly number[] };

/**
 * A stretch of reasoning and calls, as a timeline (ADR 0084): one line that says how much work
 * there was, and under it the steps in the order they happened, joined by a rail.
 *
 * The stretch the run is working in right now is open, as is one where a call needs the operator;
 * a stretch the answer has moved past folds to its summary, so the answer is not pushed down by
 * its own working. The reader's toggle wins either way. A stretch of reasoning alone needs no
 * frame around it.
 */
function ChainGroup({ group, children }: { group: GroupPart; children: React.ReactNode }) {
  const { t } = useI18n();
  const parts = useAuiState(state => state.message.parts) as readonly MessagePartState[];
  const isRunning = useAuiState(state => state.message.status?.type === 'running');
  const [chosen, setChosen] = React.useState<boolean>();
  const bodyID = React.useId();
  const members = group.indices.map(index => parts[index]).filter(Boolean);
  const calls = members.filter(part => part.type === 'tool-call');
  const needsOperator = calls.some(part => part.type === 'tool-call' && ((part.approval && part.approval.approved === undefined) || part.interrupt));
  // Still the end of a running answer: the next step, if there is one, lands here.
  const isActive = isRunning && group.indices.at(-1) === parts.length - 1;
  const isOpen = chosen ?? (isActive || needsOperator);
  // The steps are drawn from the first time the timeline is open and kept, so they are there to
  // fold away; a settled answer nobody opens draws none of them.
  const [hasOpened, setHasOpened] = React.useState(isOpen);
  React.useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);
  if (calls.length === 0) return <>{children}</>;
  const failed = calls.filter(part => part.type === 'tool-call' && part.isError).length;
  return (
    <div className={styles['chain']} data-testid="agent-chain" data-active={isActive || undefined} data-aui-quote-selectable="false">
      <button type="button" className={styles['chain-toggle']} aria-expanded={isOpen} aria-controls={bodyID} onClick={() => setChosen(!isOpen)}>
        <span className={styles['chain-icon']} aria-hidden="true"><StepsOutlined /></span>
        {/* The open timeline shows which step is running; folded, the summary has to. */}
        <span className={isActive && !isOpen ? workspace['live-text'] : undefined}>
          {t(isActive ? 'agent.chain.working' : 'agent.chain.used', { count: String(calls.length) })}
        </span>
        {failed > 0 && <span className={styles['chain-failed']}>{t('agent.chain.failed', { count: String(failed) })}</span>}
        <RightOutlined className={styles['chain-caret']} aria-hidden="true" />
      </button>
      <div id={bodyID} className={styles['fold']} data-open={isOpen || undefined}>
        <div className={styles['fold-inner']}>
          {(isOpen || hasOpened) && <div className={styles['chain-body']}>{children}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * That the run is alive and for how long: a spinner alone cannot tell working from stuck.
 *
 * Reasoning and a running call say what they are where they are drawn - the disclosure reads
 * "Thinking", the call's row carries its title - so the strip names a phase only when nothing in
 * the answer does: waiting on the model, or retrying it.
 */
function ActivityStrip() {
  const { t } = useI18n();
  const { activity } = useAgentView();
  if (!activity) return null;
  const label = activity.retry ? t('agent.activity.retry', { retry: activity.retry })
    : activity.runningCall || activity.isThinking ? '' : t('agent.activity.waiting');
  return (
    <div className={styles['activity']} role="status" aria-live="polite" data-testid="agent-activity">
      <GenerationLoader size="mark" />
      {label && <span className={styles['activity-label']}><span className={workspace['live-text']}>{label}</span></span>}
      <span className={workspace['metric']}><LiveElapsed startedAtMS={activity.startedAtMS} isRunning /></span>
    </div>
  );
}

/** A settled turn's facts and actions share the conversation's portable export. */
function TurnFooter({ turn }: { turn: Turn }) {
  useTimeZone();
  const { t, lang } = useI18n();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const { isExporting, exportSnapshot } = useConversationExport('agent');
  const duration = turnDuration(turn);
  const clock = formatClock(turn.started_at_ms, lang);
  const calls = turn.traces.length;
  const { replaceableTurnID, retryTurn, editTurn } = useAgentView();
  return (
    <div className={workspace['message-foot']}>
      <span className={workspace['status']}>
        <span className={workspace['pip']} data-tone={statusTone(turn.status, turn.code)} aria-hidden="true" />
        {t(isAwaitingAnswer(turn) ? 'agent.status.question' : turnLabelKey(turn))}
      </span>
      {duration !== undefined && (
        <span className={workspace['metric']}><ClockCircleOutlined aria-hidden="true" />{formatDuration(duration)}</span>
      )}
      {clock && <span className={workspace['metric']}>{clock}</span>}
      {(turn.rounds ?? 0) > 0 && (
        <span className={workspace['metric']}>{t('agent.foot.rounds', { rounds: String(turn.rounds), calls: String(calls) })}</span>
      )}
      {turn.usage?.total_tokens !== undefined && (
        <Tooltip title={t('agent.foot.tokens')}>
          <span className={workspace['metric']}><DatabaseOutlined aria-hidden="true" />{formatTokens(turn.usage.total_tokens, tokenStyle)}</span>
        </Tooltip>
      )}
      <span className={workspace['foot-spacer']} />
      <ActionBarPrimitive.Root className={workspace['foot-actions']}>
        {replaceableTurnID === turn.id && (
          <>
            <LabelTip title={t('agent.turn.retry')}>
              <Button type="text" size="small" aria-label={t('agent.turn.retry')} icon={<ReloadOutlined />} onClick={retryTurn} />
            </LabelTip>
            <LabelTip title={t('agent.turn.edit')}>
              <Button type="text" size="small" aria-label={t('agent.turn.edit')} icon={<EditOutlined />} onClick={editTurn} />
            </LabelTip>
          </>
        )}
        <LabelTip title={t('conversation.copy_answer')}>
          <ActionBarPrimitive.Copy asChild>
            <Button type="text" size="small" aria-label={t('conversation.copy_answer')} className={styles['copy-action']}>
              <span className={styles['copy-idle']}><CopyOutlined /></span>
              <span className={styles['copy-done']}><CheckOutlined /></span>
            </Button>
          </ActionBarPrimitive.Copy>
        </LabelTip>
        <LabelTip title={t('agent.export.answer')}>
          <Button type="text" size="small" aria-label={t('agent.export.answer')} icon={<FileTextOutlined />} loading={isExporting}
            disabled={isExporting || turn.status === 'running'}
            onClick={() => void readTurnImages([turn]).then(images => exportSnapshot(agentSnapshot({ id: '', revision: 0, model: '', client_key_fingerprint: '', omitted: 0, turns: [turn] }, images), 'html'))}
          />
        </LabelTip>
      </ActionBarPrimitive.Root>
    </div>
  );
}

/**
 * The questions the model offered after its answer, under the newest answer only: an older turn's
 * follow-ups were about a conversation that has since moved on. Choosing one writes it into the
 * message box rather than sending it, so the operator can still change it.
 *
 * The box is addressed through the thread: inside a message the bare composer scope is that
 * message's edit composer, which nothing on this page draws.
 */
function FollowUps({ suggestions }: { suggestions?: string[] }) {
  const { t } = useI18n();
  const aui = useAui();
  const isLast = useAuiState(state => state.message.isLast);
  if (!isLast || !suggestions?.length) return null;
  return (
    <div className={workspace['follow-ups']} role="group" aria-label={t('agent.follow_ups')} data-testid="agent-follow-ups">
      {suggestions.map((suggestion, index) => (
        <button key={suggestion} type="button" className={workspace['follow-up']} style={{ '--follow-up-row': index } as React.CSSProperties} onClick={() => aui.thread().composer().setText(suggestion)}>
          {suggestion}
        </button>
      ))}
    </div>
  );
}

/**
 * One thread message, drawn by the role of the message it is bound to rather than the role the
 * thread's render callback saw: the runtime can place its own placeholder where a message was.
 */
export function AgentMessage() {
  const role = useAuiState(state => state.message.role);
  return role === 'user' ? <AgentUserMessage /> : <AgentAssistantMessage />;
}

/**
 * One answer, drawn in the order it happened: a model may reason, say something, call
 * capabilities, reason again and answer, so the turn is a sequence of parts rather than fixed slots.
 * A turn that failed says so on the message itself, in a sentence with the code beneath it.
 */
export function AgentAssistantMessage() {
  const { t } = useI18n();
  const custom = useAuiState(state => state.message.metadata.custom) as AgentMessageCustom;
  const turn = custom.turn;
  const isLive = !!custom.isLive;
  const failure = turn?.code && turn.code !== 'cancelled' ? turn.code : '';
  return (
    <MessagePrimitive.Root className={workspace['message']} data-role="assistant">
      <div className={workspace['answer']} data-testid={isLive ? 'agent-running' : 'agent-turn'}>
        <MessagePrimitive.GroupedParts groupBy={GROUP_BY} indicator="never">
          {({ part, children }) => {
            switch (part.type) {
              case 'group-chain':
                return <ChainGroup group={part as GroupPart}>{children}</ChainGroup>;
              case 'text':
                return (
                  <div data-aui-quote-selectable>
                    <ModelMarkdown content={part.text} isStreaming={part.status.type === 'running'} externalImageLabel={t('conversation.external_image')} />
                  </div>
                );
              case 'reasoning':
                return <ReasoningBlock text={part.text} isThinking={part.status.type === 'running'} />;
              case 'tool-call':
                return part.toolUI ?? <ToolFallback {...part} />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {failure && !isLive && (
          <MessagePrimitive.Error>
            <div className={styles['failure']} role="alert" data-tone={statusTone(turn?.status ?? 'error', turn?.code)}>
              <span>{t(failureKey(failure))}</span>
              {turn?.failure?.retry_exhausted && <span>{t('agent.error.retries_exhausted')}</span>}
              {!!turn?.failure?.upstream_status && <span>{t('agent.error.upstream_status', { status: turn.failure.upstream_status })}</span>}
              {turn?.failure?.parameter && <span>{t('agent.error.parameter', { parameter: turn.failure.parameter })}</span>}
              <code>{failure}</code>
            </div>
          </MessagePrimitive.Error>
        )}
        {isLive ? <ActivityStrip /> : turn && <TurnFooter turn={turn} />}
        {!isLive && turn && <FollowUps suggestions={turn.suggestions} />}
      </div>
    </MessagePrimitive.Root>
  );
}
