import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { ThoughtChain } from '@ant-design/x';
import type { ThoughtChainItemType } from '@ant-design/x';
import { ClockCircleOutlined, WarningOutlined } from '../../components/icons';
import { CopyButton } from '../../components/common/CopyButton';
import { CodeBlock, ModelMarkdown } from '../../components/workspace/ModelMarkdown';
import { ReasoningBlock } from '../../components/workspace/ReasoningBlock';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import type { TFunc } from '../../i18n';
import { capabilityTitle } from '../../i18n/capabilities';
import { createVisibleClock } from '../../types/visibleClock';
import { extractThinking } from '../playground/state';
import {
  ASK_QUESTION,
  failureKey,
  formatClock,
  formatDuration,
  hasRawResult,
  isAwaitingAnswer,
  rawResultText,
  segmentParts,
  statusTone,
  summarizeResult,
  traceChainStatus,
  turnDuration,
  turnLabelKey,
  turnParts,
} from './state';
import type { Trace, Turn, TurnPart, TurnSegment } from './state';
import styles from './AgentPage.module.css';

/**
 * The transcript's own clock, ticking once a second while a run is in flight.
 *
 * `createVisibleClock` only runs its interval while something is subscribed, and the live turn is
 * the only subscriber, so the timer exists exactly for the duration of a run.
 */
const liveClock = createVisibleClock(1000);

const idleClock = { subscribe: () => () => {}, getSnapshot: () => 0 };

/** The clock only while `isLive`: a stored turn subscribes to nothing, so an idle page never ticks. */
function useLiveNow(isLive: boolean): number {
  const clock = isLive ? liveClock : idleClock;
  return React.useSyncExternalStore(clock.subscribe, clock.getSnapshot, () => 0);
}

/**
 * A capability call, as one step of the turn's chain.
 *
 * The description is the result digested to its top-level scalars and collection sizes; the
 * document itself is one disclosure away. A result is often a page of records, and rendering it
 * whole under an answer buries the answer it exists to support.
 *
 * A call waiting on the operator, or one whose outcome is unconfirmed, is not a chain status the
 * library knows - it has no "needs attention" state - so those steps carry the warning glyph
 * themselves rather than being drawn as loading or failed.
 */
function traceItem(trace: Trace, t: TFunc): ThoughtChainItemType {
  const { fields, counts } = summarizeResult(trace.result.data);
  const digest = [
    ...(trace.result.code ? [trace.result.code] : []),
    ...(trace.result.detail ? [trace.result.detail] : []),
    ...fields.map(field => `${field.label} ${field.value}`),
    ...counts.map(count => `${count.label} ${count.value}`),
  ].join(' · ');
  const status = traceChainStatus(trace.result.status);
  const tone = statusTone(trace.result.status, trace.result.code);
  const isRawAvailable = hasRawResult(trace.result);
  const isQuestionTrace = trace.name === ASK_QUESTION && trace.result.status === 'pending';
  return {
    key: trace.id,
    title: (
      <span className={styles['trace-title']} data-testid="agent-trace">
        <span className={styles['trace-label']}>{capabilityTitle(trace.name, t)}</span>
        <code className={styles['trace-name']}>{trace.name}</code>
        <span className={styles['trace-status']} data-tone={tone}>{t(isQuestionTrace ? 'agent.status.question' : turnLabelKey({ status: trace.result.status }))}</span>
      </span>
    ),
    description: digest ? <span className={styles['trace-digest']} title={digest}>{digest}</span> : undefined,
    ...(status ? { status } : { icon: <WarningOutlined className={styles['trace-attention']} /> }),
    collapsible: isRawAvailable,
    content: isRawAvailable ? <CodeBlock lang="json" block>{rawResultText(trace.result)}</CodeBlock> : undefined,
  };
}

/**
 * The capability calls a model made together, as one chain. A call waiting on the operator is
 * decided in the page's authorization dialog or question panel, not here, so the chain only states
 * that it is waiting.
 */
function ToolSegment({ traceIDs, traces }: { traceIDs: string[]; traces: Map<string, Trace> }) {
  useTimeZone();
  const { t } = useI18n();
  const group = React.useMemo(
    () => traceIDs.flatMap(id => (traces.has(id) ? [traces.get(id) as Trace] : [])),
    [traceIDs, traces],
  );
  const items = React.useMemo(() => group.map(trace => traceItem(trace, t)), [group, t]);
  if (group.length === 0) return null;
  return <ThoughtChain className={styles['chain']} items={items} line="solid" />;
}

/** Answer text; a provider that reasons inline in `<think>` tags has that part shown as reasoning. */
function TextSegment({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  useTimeZone();
  const { t } = useI18n();
  const inline = React.useMemo(() => extractThinking(content), [content]);
  return (
    <>
      {(inline.thought || inline.isThinking) && <ReasoningBlock text={inline.thought} isThinking={isStreaming && Boolean(inline.isThinking)} />}
      {inline.reply && <ModelMarkdown content={inline.reply} isStreaming={isStreaming} externalImageLabel={t('pg.external_image')} />}
    </>
  );
}

/** The part of a turn still being produced, and what the run is doing right now. */
export interface LiveRun {
  parts: TurnPart[];
  traces: Trace[];
  startedAtMS: number;
  /** True once the run has returned and is waiting for the operator rather than the model. */
  isAwaitingApproval: boolean;
}

export interface TurnViewProps {
  /** The stored turn; absent while a new message's first frames are still arriving. */
  turn?: Turn;
  /** Present while a run is writing to this turn. */
  live?: LiveRun;
}

/**
 * One turn, drawn in the order it happened.
 *
 * A model may reason, say something, call capabilities, reason again and answer - so the turn is
 * a sequence of segments rather than fixed slots for reasoning, calls and answer. The same view
 * draws a stored turn and a live one: a resumed turn keeps its earlier segments and grows below
 * them, instead of the continuation appearing as a second answer.
 *
 * Memoised on the turn and the live frame: while an answer streams, every stored turn above it
 * keeps its identity and is skipped rather than re-parsed twenty-five times a second.
 */
export const TurnView = React.memo(function TurnView({ turn, live }: TurnViewProps) {
  useTimeZone();
  const { t, lang } = useI18n();
  const nowMS = useLiveNow(Boolean(live));
  const parts = React.useMemo(() => {
    const stored = turn ? turnParts(turn) : [];
    // A resumed run reports the call it stopped on again, with its outcome. That call is already a
    // step of the stored turn, so its result updates the step rather than adding a second one.
    const storedCalls = new Set(stored.flatMap(part => (part.type === 'tool' && part.trace_id ? [part.trace_id] : [])));
    const added = (live?.parts ?? []).filter(part => part.type !== 'tool' || !storedCalls.has(part.trace_id ?? ''));
    return [...stored, ...added];
  }, [turn, live?.parts]);
  const segments = React.useMemo(() => segmentParts(parts), [parts]);
  const traces = React.useMemo(() => {
    const byID = new Map<string, Trace>();
    for (const trace of [...(turn?.traces ?? []), ...(live?.traces ?? [])]) byID.set(trace.id, trace);
    return byID;
  }, [turn?.traces, live?.traces]);
  const lastPart = parts.at(-1);
  const isThinking = Boolean(live) && lastPart?.type === 'thought';
  const lastTrace = live?.traces.at(-1);
  const answer = React.useMemo(
    () => parts.flatMap(part => (part.type === 'text' && part.content ? [extractThinking(part.content).reply] : [])).filter(Boolean).join('\n\n'),
    [parts],
  );
  const failure = turn?.code && turn.code !== 'cancelled' ? turn.code : '';
  const duration = turn ? turnDuration(turn) : undefined;
  const clock = formatClock(turn?.started_at_ms, lang);

  const renderSegment = (segment: TurnSegment, index: number) => {
    const isLast = index === segments.length - 1;
    if (segment.kind === 'thought') {
      return <ReasoningBlock key={segment.key} text={segment.content} isThinking={isThinking && isLast} />;
    }
    if (segment.kind === 'text') {
      return <TextSegment key={segment.key} content={segment.content} isStreaming={Boolean(live) && isLast} />;
    }
    return <ToolSegment key={segment.key} traceIDs={segment.traceIDs} traces={traces} />;
  };

  return (
    <div className={workspace['answer']} data-testid={live ? 'agent-running' : 'agent-turn'}>
      {segments.map(renderSegment)}
      {failure && !live && (
        <div className={styles['failure']} role="alert" data-tone={statusTone(turn?.status ?? 'error', turn?.code)}>
          <span>{t(failureKey(failure))}</span>
          <code>{failure}</code>
        </div>
      )}
      {live ? (
        // What the run is waiting on, and for how long: a spinner alone cannot tell working from stuck.
        <div className={styles['activity']} role="status" aria-live="polite" data-testid="agent-activity">
          <span className={styles['activity-mark']} aria-hidden="true" />
          <span className={styles['activity-label']}>
            {live.isAwaitingApproval
              ? t('agent.activity.approval')
              : isThinking
                ? t('pg.thinking')
                : lastTrace && lastPart?.type === 'tool'
                  ? t('agent.activity.called', { name: capabilityTitle(lastTrace.name, t) })
                  : t('agent.activity.waiting')}
          </span>
          <span className={workspace['metric']}>{formatDuration(Math.max(0, nowMS - live.startedAtMS))}</span>
        </div>
      ) : turn && (
        <div className={workspace['message-foot']}>
          <span className={workspace['status']}>
            <span className={workspace['pip']} data-tone={statusTone(turn.status, turn.code)} aria-hidden="true" />
            {t(isAwaitingAnswer(turn) ? 'agent.status.question' : turnLabelKey(turn))}
          </span>
          {duration !== undefined && (
            <span className={workspace['metric']}><ClockCircleOutlined aria-hidden="true" />{formatDuration(duration)}</span>
          )}
          {clock && <span className={workspace['metric']}>{clock}</span>}
          <span className={workspace['foot-spacer']} />
          {answer && (
            <span className={workspace['foot-actions']}>
              <CopyButton text={answer} label={t('pg.copy_answer')} />
            </span>
          )}
        </div>
      )}
    </div>
  );
});
