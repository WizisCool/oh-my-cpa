import React from 'react';
import { Button, Tooltip } from 'antd';
import { ActionBarPrimitive, MessagePartPrimitive, MessagePrimitive, groupPartByType, useAui, useAuiState } from '@assistant-ui/react';
import type { MessagePartState } from '@assistant-ui/react';
import { clsx } from 'clsx';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { CheckOutlined, ClockCircleOutlined, CopyOutlined, DatabaseOutlined, EditOutlined, FileTextOutlined, PaperClipOutlined, ReloadOutlined, RightOutlined } from '../../components/icons';
import { ModelMarkdown } from '../../components/workspace/ModelMarkdown';
import { ReasoningBlock } from '../../components/workspace/ReasoningBlock';
import workspace from '../../components/workspace/Workspace.module.css';
import { agentSnapshot } from '../../agent/conversationSnapshot';
import { useConversationExport } from '../../components/workspace/useConversationExport';
import { completedDisplayViews } from '../../agent/types';
import type { Turn } from '../../agent/types';
import { DisplayFigure } from './tools/DisplayCall';
import { useI18n } from '../../i18n';
import { capabilityTitle } from '../../i18n/capabilities';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { failureKey, formatClock, formatDuration, isAwaitingAnswer, statusTone, turnDuration, turnLabelKey } from './state';
import type { AgentMessageCustom } from './thread';
import { formatBytes } from '../../utils/format';
import { useAgentView } from './tools/AgentViewContext';
import { ToolFallback } from './tools/registry';
import { LiveElapsed } from '../../components/workspace/LiveElapsed';
import styles from './AgentPage.module.css';

// User text is plain content, not a paragraph with browser-default vertical margins.
const USER_PART_COMPONENTS = { Text: () => <MessagePartPrimitive.Text smooth={false} /> };

/** The operator's message. */
export function AgentUserMessage() {
  const files = useAuiState(state => (state.message.metadata?.custom as AgentMessageCustom | undefined)?.files);
  const hasText = useAuiState(state => state.message.parts.some(part => part.type === 'text' && part.text.length > 0));
  return (
    <MessagePrimitive.Root className={workspace['message']} data-role="user">
      {!!files?.length && (
        <div className={styles['sent-files']} data-testid="agent-sent-files">
          {files.map((file, index) => (
            <span key={`${file.name}:${index}`} className={styles['sent-file']}>
              <PaperClipOutlined aria-hidden="true" />
              <span className={styles['sent-file-name']}>{file.name}</span>
              <span className={styles['sent-file-size']}>{formatBytes(file.bytes)}</span>
            </span>
          ))}
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
 * Reasoning and capability calls form the answer's chain of thought; the answer text, and any
 * figures the agent drew, stay outside it. A display call is itself a step of the chain - preparing
 * a figure is work the turn did - and its figure is published after the answer, once the turn has
 * succeeded (ADR 0042).
 */
const GROUP_BY = groupPartByType({
  reasoning: ['group-chain'],
  'tool-call': ['group-chain'],
});

type GroupPart = { readonly type: `group-${string}`; readonly indices: readonly number[] };

/**
 * A stretch of reasoning and calls. Open while the answer is still being produced or while a call
 * in it needs the operator, and folded to "used N capabilities" once the answer has settled; the
 * reader's own toggle wins either way. A stretch of reasoning alone needs no frame around it.
 */
function ChainGroup({ group, children }: { group: GroupPart; children: React.ReactNode }) {
  const { t } = useI18n();
  const parts = useAuiState(state => state.message.parts) as readonly MessagePartState[];
  const isRunning = useAuiState(state => state.message.status?.type === 'running');
  const [chosen, setChosen] = React.useState<boolean>();
  const members = group.indices.map(index => parts[index]).filter(Boolean);
  const calls = members.filter(part => part.type === 'tool-call');
  const needsOperator = calls.some(part => part.type === 'tool-call' && ((part.approval && part.approval.approved === undefined) || part.interrupt));
  if (calls.length === 0) return <>{children}</>;
  const isOpen = chosen ?? (isRunning || needsOperator);
  return (
    <div className={styles['chain']} data-testid="agent-chain" data-aui-quote-selectable="false">
      <button type="button" className={styles['chain-toggle']} aria-expanded={isOpen} onClick={() => setChosen(!isOpen)}>
        <RightOutlined className={styles['chain-caret']} aria-hidden="true" />
        <span>{t('agent.chain.used', { count: String(calls.length) })}</span>
      </button>
      {isOpen && <div className={styles['chain-body']}>{children}</div>}
    </div>
  );
}

/** What the run is doing now and for how long: a spinner alone cannot tell working from stuck. */
function ActivityStrip() {
  const { t } = useI18n();
  const { activity } = useAgentView();
  if (!activity) return null;
  const label = activity.runningCall
    ? t('agent.activity.calling', { name: capabilityTitle(activity.runningCall, t) })
    : activity.isThinking
      ? t('conversation.thinking')
      : t('agent.activity.waiting');
  return (
    <div className={styles['activity']} role="status" aria-live="polite" data-testid="agent-activity">
      <span className={styles['activity-mark']} aria-hidden="true" />
      {activity.round > 0 && <span className={styles['activity-round']}>{t('agent.activity.round', { round: String(activity.round) })}</span>}
      <span className={styles['activity-label']}>{label}</span>
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
            <Tooltip title={t('agent.turn.retry')}>
              <Button type="text" size="small" aria-label={t('agent.turn.retry')} icon={<ReloadOutlined />} onClick={retryTurn} />
            </Tooltip>
            <Tooltip title={t('agent.turn.edit')}>
              <Button type="text" size="small" aria-label={t('agent.turn.edit')} icon={<EditOutlined />} onClick={editTurn} />
            </Tooltip>
          </>
        )}
        <Tooltip title={t('conversation.copy_answer')}>
          <ActionBarPrimitive.Copy asChild>
            <Button type="text" size="small" aria-label={t('conversation.copy_answer')} className={styles['copy-action']}>
              <span className={styles['copy-idle']}><CopyOutlined /></span>
              <span className={styles['copy-done']}><CheckOutlined /></span>
            </Button>
          </ActionBarPrimitive.Copy>
        </Tooltip>
        <Tooltip title={t('agent.export.answer')}>
          <Button type="text" size="small" aria-label={t('agent.export.answer')} icon={<FileTextOutlined />} loading={isExporting}
            disabled={isExporting || turn.status === 'running'}
            onClick={() => void exportSnapshot(agentSnapshot({ id: '', revision: 0, model: '', client_key_fingerprint: '', omitted: 0, turns: [turn] }), 'html')}
          />
        </Tooltip>
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
      {suggestions.map(suggestion => (
        <button key={suggestion} type="button" className={workspace['follow-up']} onClick={() => aui.thread().composer().setText(suggestion)}>
          <RightOutlined aria-hidden="true" />
          <span>{suggestion}</span>
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
        {!isLive && completedDisplayViews(turn).length > 0 && (
          <section className={styles['results']} data-aui-quote-selectable="false" data-testid="agent-results" aria-label={t('agent.results')}>
            {completedDisplayViews(turn).map(trace => <DisplayFigure key={trace.id} view={trace.view!} />)}
          </section>
        )}
        {failure && !isLive && (
          <MessagePrimitive.Error>
            <div className={styles['failure']} role="alert" data-tone={statusTone(turn?.status ?? 'error', turn?.code)}>
              <span>{t(failureKey(failure))}</span>
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
