import { extractThinking } from '../utils/thinking';
import { displayCallStage, isDisplayTool } from './types';
import type { Trace, TurnPart } from './types';

/** One step of an answer's working: a stretch of reasoning, or a capability call. */
export type AnswerStep = { kind: 'thought'; text: string } | { kind: 'call'; trace: Trace };

/**
 * One block of an answer as a reader meets it, top to bottom.
 *
 * `chain` is a stretch of reasoning and calls drawn as one timeline (ADR 0084). `figure` is a
 * display call drawn where the model made it (ADR 0082); a display call that failed is a `call`
 * row standing on its own, which is where its code and detail are read. Reasoning with no call
 * beside it needs no timeline around it and is a `thought` of its own.
 */
export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'chain'; steps: AnswerStep[] }
  | { kind: 'figure'; trace: Trace }
  | { kind: 'call'; trace: Trace };

/**
 * Lays a turn's parts out as the conversation draws them.
 *
 * The transcript groups its message parts through the chat framework (`GROUP_BY` and
 * `ChainGroup` in `pages/agent/AgentMessage.tsx`); this is the same rule as a plain function, for
 * everything that shows an answer without that framework - a saved copy of the conversation
 * first of all. A saved copy that grouped by a rule of its own drew every display at the end of
 * its turn and every call in one list, and so stopped looking like the conversation it was a
 * copy of. A change to how an answer is grouped belongs in both places, and
 * `scripts/test-answer-layout.ts` holds the cases the two have to agree on.
 */
export function answerLayout(parts: readonly TurnPart[], traces: readonly Trace[]): AnswerSegment[] {
  const byID = new Map(traces.map(trace => [trace.id, trace]));
  const segments: AnswerSegment[] = [];
  let working: AnswerStep[] = [];
  const settleWorking = () => {
    if (working.some(step => step.kind === 'call')) segments.push({ kind: 'chain', steps: working });
    else for (const step of working) if (step.kind === 'thought') segments.push(step);
    working = [];
  };
  for (const part of parts) {
    if (part.type === 'tool') {
      const trace = part.trace_id ? byID.get(part.trace_id) : undefined;
      if (!trace) continue;
      if (!isDisplayTool(trace.name)) {
        working.push({ kind: 'call', trace });
        continue;
      }
      settleWorking();
      const stage = displayCallStage(trace);
      // A draft is a figure still being written: there is nothing settled to lay out yet.
      if (stage !== 'draft') segments.push({ kind: stage === 'figure' ? 'figure' : 'call', trace });
      continue;
    }
    if (!part.content) continue;
    if (part.type === 'thought') {
      working.push({ kind: 'thought', text: part.content });
      continue;
    }
    // A provider that reasons inline in `<think>` tags has that part shown as reasoning.
    const inline = extractThinking(part.content);
    if (inline.thought) working.push({ kind: 'thought', text: inline.thought });
    if (inline.reply) {
      settleWorking();
      segments.push({ kind: 'text', text: inline.reply });
    }
  }
  settleWorking();
  return segments;
}
