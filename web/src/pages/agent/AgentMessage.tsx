import React from 'react';
import { Button, Tooltip } from 'antd';
import { ActionBarPrimitive, MessagePartPrimitive, MessagePrimitive, groupPartByType, useAuiState } from '@assistant-ui/react';
import type { MessagePartState } from '@assistant-ui/react';
import { clsx } from 'clsx';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { CheckOutlined, ClockCircleOutlined, CopyOutlined, DatabaseOutlined, FileTextOutlined, RightOutlined } from '../../components/icons';
import { ModelMarkdown } from '../../components/workspace/ModelMarkdown';
import { ReasoningBlock } from '../../components/workspace/ReasoningBlock';
import workspace from '../../components/workspace/Workspace.module.css';
import { exportFileName, turnAnswerMarkdown } from '../../agent/export';
import { completedDisplayViews } from '../../agent/types';
import type { Turn } from '../../agent/types';
import { DisplayFigure } from './tools/DisplayCall';
import { useI18n } from '../../i18n';
import { capabilityTitle } from '../../i18n/capabilities';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { saveBlob } from '../../utils/download';
import { useExportLabels } from './exportLabels';
import { failureKey, formatClock, formatDuration, isAwaitingAnswer, statusTone, turnDuration, turnLabelKey } from './state';
import type { AgentMessageCustom } from './thread';
import { useAgentView } from './tools/AgentViewContext';
import { ToolFallback } from './tools/registry';
import { LiveElapsed } from '../../components/workspace/LiveElapsed';
import styles from './AgentPage.module.css';

// User text is plain content, not a paragraph with browser-default vertical margins.
const USER_PART_COMPONENTS = { Text: () => <MessagePartPrimitive.Text smooth={false} /> };

/** The operator's message. */
export function AgentUserMessage() {
  return (
    <MessagePrimitive.Root className={workspace['message']} data-role="user">
      <div className={clsx(workspace['user-bubble'], workspace['user-text'])} data-aui-quote-selectable>
        <MessagePrimitive.Parts components={USER_PART_COMPONENTS} />
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * Reasoning and capability calls form the answer's chain of thought; the answer text, and any
 * chart or table the agent drew, stay outside it. Display tools are registered as standalone, so
 * they break out of the chain and sit in the answer where the model put them.
 */
const GROUP_BY = groupPartByType({
  reasoning: ['group-chain'],
  'tool-call': ['group-chain'],
  'standalone-tool-call': [],
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
      ? t('pg.thinking')
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

/** A settled turn's facts and its actions: copy the answer, export it as Markdown. */
function TurnFooter({ turn }: { turn: Turn }) {
  useTimeZone();
  const { t, lang } = useI18n();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const labels = useExportLabels();
  const duration = turnDuration(turn);
  const clock = formatClock(turn.started_at_ms, lang);
  const calls = turn.traces.length;
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
        <Tooltip title={t('pg.copy_answer')}>
          <ActionBarPrimitive.Copy asChild>
            <Button type="text" size="small" aria-label={t('pg.copy_answer')} className={styles['copy-action']}>
              <span className={styles['copy-idle']}><CopyOutlined /></span>
              <span className={styles['copy-done']}><CheckOutlined /></span>
            </Button>
          </ActionBarPrimitive.Copy>
        </Tooltip>
        <Tooltip title={t('agent.export.answer')}>
          <ActionBarPrimitive.ExportMarkdown
            asChild
            onExport={() => saveBlob(new Blob([turnAnswerMarkdown(turn, labels)], { type: 'text/markdown;charset=utf-8' }), exportFileName('omc-agent-answer', 'md', new Date()))}
          >
            <Button type="text" size="small" aria-label={t('agent.export.answer')} icon={<FileTextOutlined />} />
          </ActionBarPrimitive.ExportMarkdown>
        </Tooltip>
      </ActionBarPrimitive.Root>
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
                    <ModelMarkdown content={part.text} isStreaming={part.status.type === 'running'} externalImageLabel={t('pg.external_image')} />
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
          <section data-aui-quote-selectable="false" data-testid="agent-results" aria-label={t('agent.results')}>
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
      </div>
    </MessagePrimitive.Root>
  );
}
