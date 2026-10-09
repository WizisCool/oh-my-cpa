/**
 * How an answer's parts become the blocks a reader meets.
 *
 * The transcript groups its parts through the chat framework and a saved copy of the conversation
 * groups them through `answerLayout`. These are the cases the two have to agree on; a saved copy
 * that grouped by its own rule drew every display at the end of its turn.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerLayout } from '../web/src/agent/answerLayout.ts';
import type { Trace, TurnPart } from '../web/src/agent/types.ts';

const call = (id: string, name = 'usage_aggregate', status = 'success'): Trace => ({ id, name, result: { status } });
const display = (id: string, status = 'success'): Trace => ({
  id, name: 'render_ui', result: { status },
  ...(status === 'success' ? { view: { kind: 'ui' as const, title: 'View', columns: [], rows: [], html: '<p>drawn</p>' } } : {}),
});
const tool = (id: string): TurnPart => ({ type: 'tool', trace_id: id });
const kinds = (parts: TurnPart[], traces: Trace[]) => answerLayout(parts, traces).map(segment => segment.kind);

test('reasoning and calls form one timeline until the answer speaks', () => {
  const layout = answerLayout(
    [tool('a'), { type: 'thought', content: 'why' }, tool('b'), { type: 'text', content: 'Answer' }],
    [call('a'), call('b')],
  );
  assert.deepEqual(layout.map(segment => segment.kind), ['chain', 'text']);
  assert.deepEqual(layout[0].kind === 'chain' && layout[0].steps.map(step => step.kind), ['call', 'thought', 'call']);
});

test('a display is drawn where the model called it and ends the timeline before it', () => {
  assert.deepEqual(
    kinds([tool('a'), { type: 'text', content: 'Before' }, tool('view'), { type: 'thought', content: 'check' }, { type: 'text', content: 'After' }], [call('a'), display('view')]),
    ['chain', 'text', 'figure', 'thought', 'text'],
  );
  assert.deepEqual(kinds([tool('a'), tool('view'), tool('b')], [call('a'), display('view'), call('b')]), ['chain', 'figure', 'chain']);
});

test('reasoning with no call beside it needs no timeline', () => {
  assert.deepEqual(kinds([{ type: 'thought', content: 'one' }, { type: 'thought', content: 'two' }, { type: 'text', content: 'Answer' }], []), ['thought', 'thought', 'text']);
});

test('a display that failed is a call row of its own, and one still being written is not laid out', () => {
  assert.deepEqual(kinds([tool('a'), tool('view')], [call('a'), display('view', 'error')]), ['chain', 'call']);
  assert.deepEqual(kinds([tool('view'), { type: 'text', content: 'Answer' }], [display('view', 'running')]), ['text']);
});

test('inline thinking is reasoning, and empty or orphaned parts are left out', () => {
  assert.deepEqual(kinds([tool('a'), { type: 'text', content: '<think>plan</think>Answer' }], [call('a')]), ['chain', 'text']);
  const layout = answerLayout([tool('a'), { type: 'text', content: '<think>plan</think>Answer' }], [call('a')]);
  assert.deepEqual(layout[0].kind === 'chain' && layout[0].steps.map(step => step.kind), ['call', 'thought']);
  assert.deepEqual(kinds([tool('missing'), { type: 'text', content: '' }, { type: 'thought' }], []), []);
});
