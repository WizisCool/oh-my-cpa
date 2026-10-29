import { extractThinking } from '../utils/thinking';
import { isProgramText, programOf } from './openui/program';
import { isOpenUITool } from './types';
import type { Trace, TurnPart } from './types';

/** One step of an answer's working: a stretch of reasoning, or a capability call. */
export type AnswerStep = { kind: 'thought'; text: string } | { kind: 'call'; trace: Trace };

/**
 * One block of an answer as a reader meets it, top to bottom.
 *
 * `chain` is a stretch of reasoning and calls drawn as one timeline. `interface` is an
 * OpenUI program drawn where the model wrote it - a `present_openui` or `prompt_openui` call, or
 * answer text that is itself a program; an OpenUI call that failed is a `call` row
 * standing on its own, which is where its code and detail are read. Reasoning with no call beside
 * it needs no timeline around it and is a `thought` of its own.
 */
export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'chain'; steps: AnswerStep[] }
  | { kind: 'interface'; program: string }
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
      if (!isOpenUITool(trace.name)) {
        working.push({ kind: 'call', trace });
        continue;
      }
      settleWorking();
      const isDrawn = trace.result.status === 'success' || trace.result.status === 'pending' || trace.result.status === 'running';
      segments.push(isDrawn ? { kind: 'interface', program: programOf(trace.arguments) } : { kind: 'call', trace });
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
      segments.push(isProgramText(inline.reply) ? { kind: 'interface', program: inline.reply } : { kind: 'text', text: inline.reply });
    }
  }
  settleWorking();
  return segments;
}
