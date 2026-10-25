/**
 * A saved conversation, asserted without a browser.
 *
 * The export is the one copy of a conversation that outlives the console, so what it carries is a
 * contract: reasoning, calls and answers in the order they happened, an interface drawn where the
 * model called it, the figures frozen as they were read, and nothing that identifies an execution.
 * `conversationHtml.ts` renders it as one static document; this suite reads that document.
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { agentSnapshot, playgroundSnapshot, snapshotImageSlices, snapshotInterfaces, snapshotValue, SNAPSHOT_IMAGE_PAGE_HEIGHT } from '../web/src/agent/conversationSnapshot.ts';
import { conversationHTML } from '../web/src/agent/conversationHtml.ts';
import type { SnapshotLabels } from '../web/src/agent/conversationHtml.ts';
import type { Conversation } from '../web/src/agent/types.ts';
import type { Turn as PlaygroundTurn } from '../web/src/pages/playground/state.ts';

const LABELS: SnapshotLabels = {
  title: 'OMC conversation', operator: 'Operator', answer: 'Answer', model: 'Model', exportedAt: 'Exported',
  thought: 'Reasoning', parameters: 'Parameters', arguments: 'Arguments', result: 'Result',
  copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', search: 'Search conversation', expand: 'Expand details',
  panel: 'Side panel', close: 'Close', usage: 'Tokens', noMatches: 'No turns match', interfaceOmitted: 'Interface not drawn in HTML export', turns: count => `${count} turns`,
  number: value => String(value), calls: count => `Used ${count} capabilities`, tokens: count => `${count} tokens`,
  collapse: 'Collapse details', print: 'Print', imageOmitted: 'Image omitted', privacy: 'Snapshot; share with care',
  omitted: count => `${count} omitted turns`, status: status => status, capability: name => name,
  callStatus: (_name, status) => `call-${status}`, chainFailed: count => `${count} failed`, rounds: (rounds, calls) => `${rounds} rounds, ${calls} calls`,
  present: present => `present-${present}`, tokenCount: count => `${count}t`,
  failure: code => `Failed ${code}`, date: milliseconds => new Date(milliseconds).toISOString(), duration: milliseconds => `${milliseconds}ms`,
};

const PROGRAM = 'root = Card([TextContent("Requests by day")])';
const CONVERSATION: Conversation = { id: 'private-session', revision: 1, model: 'test-model', client_key_fingerprint: 'private-key-fingerprint', omitted: 3,
  active_run_id: 'private-run-id', turns: [{ id: 'turn', user: 'Question', reply: 'First\n\nLast', status: 'success', started_at_ms: 100, ended_at_ms: 500,
    usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
    parts: [{ type: 'thought', content: 'Thought' }, { type: 'text', content: 'First' }, { type: 'tool', trace_id: 'query' }, { type: 'tool', trace_id: 'display' }, { type: 'text', content: 'Last' }],
    traces: [{ id: 'query', name: 'database_query', arguments: '{"sql":"select model from usage_events"}', result: { status: 'success', data: { rows: ['private-query-row'] }, operation_id: 'private-operation' } },
      { id: 'display', name: 'present_openui', arguments: JSON.stringify({ ui: PROGRAM }), result: { status: 'success', data: { displayed: true } } }],
  }] };

function htmlFor(snapshot = agentSnapshot(CONVERSATION)) {
  return conversationHTML({ snapshot, labels: LABELS, exportedAt: new Date(0), language: 'en', appearance: { variables: { '--bg': '#121214', '--surface': '#1c1c1f', '--fg': '#f4f4f6', '--accent': '#00b8db' } } });
}

test('Agent exports ordered reasoning, calls and answers, metrics and the interface where the model drew it, not execution identities or SQL rows', () => {
  const snapshot = agentSnapshot(CONVERSATION);
  // The blocks the conversation draws: reasoning with no call beside it stands alone, a call is
  // a timeline, and the interface is the answer in the place the model called it.
  assert.deepEqual(snapshot.turns[0].segments.map(segment => segment.kind), ['thought', 'text', 'chain', 'interface', 'text']);
  const chain = snapshot.turns[0].segments[2];
  assert.ok(chain.kind === 'chain' && chain.steps[0].kind === 'call');
  assert.equal(chain.steps[0].result, undefined);
  assert.equal(chain.steps[0].summary, 'sql=select model from usage_events');
  assert.equal(snapshot.turns[0].duration, 400);
  assert.equal(snapshot.turns[0].usage?.total_tokens, 33);
  const [drawn] = snapshotInterfaces(snapshot);
  assert.equal(drawn.program, PROGRAM);
  assert.equal(drawn.markup, undefined, 'the markup is drawn at export time, not stored in the conversation');
  // What the official renderer draws is what the document embeds, figures and all.
  drawn.markup = '<div class="openui-card"><p>Monday 10</p></div>';
  const html = htmlFor(snapshot);
  for (const secret of ['private-session', 'private-key-fingerprint', 'private-run-id', 'private-query-row', 'private-operation']) assert.equal(html.includes(secret), false, secret);
  assert.ok(html.includes('Thought') && html.includes('Monday 10') && html.includes('3 omitted turns'));
  assert.ok(html.indexOf('First') < html.indexOf('database_query') && html.indexOf('database_query') < html.indexOf('Last'));
  assert.ok(html.indexOf('database_query') < html.indexOf('<figure class="interface"') && html.indexOf('<figure class="interface"') < html.indexOf('>Last<'), 'the interface sits where the model called it, before the text that follows');
  assert.ok(html.includes('<figure class="interface" data-frame="none" inert>') && html.includes('<div class="openui-card">'), 'a saved interface is inert markup, never a frame');
  assert.ok(html.includes('<details class="chain">') && html.includes('class="call-args"') && html.includes('class="call-detail"'), 'a call is a disclosure in the answer');
  assert.equal(html.includes('class="message-head"'), false, 'the Agent names no model above an answer');
  assert.ok(html.includes('select model from usage_events'));
  assert.equal(html.includes('<iframe'), false, 'the document carries no frame of its own');
});

test('an interface the renderer could not draw says so in place rather than leaving the answer blank', () => {
  const snapshot = agentSnapshot(CONVERSATION);
  const html = htmlFor(snapshot);
  assert.ok(html.includes('<figure class="interface"><p class="meta">Interface not drawn in HTML export</p></figure>'));
});

test('Playground exports the original request model, images, parameters, partial reasoning and cancellation', () => {
  const turn: PlaygroundTurn = { id: 't', keyLabel: 'private-key-label', startedAt: 10, durationMS: 20, status: 'cancelled', reply: 'Partial', thought: 'Reasoning before stop',
    user: { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'image_url', image_url: { url: '[image omitted]' } }] },
    request: { client_key_fingerprint: 'private-key-fingerprint', model: 'original', system_prompt: 'Original system', temperature: 0,
      messages: [], custom_body: { model: 'effective-model', api_key: 'private-secret', metadata: { temperature: 0.2, access_token: 'private-token' } } },
    events: [], eventBytes: 0, isTruncated: false,
  };
  const snapshot = playgroundSnapshot([turn]);
  const html = htmlFor(snapshot);
  assert.equal(snapshot.turns[0].model, 'effective-model');
  assert.equal(snapshot.turns[0].parameters?.temperature, 0);
  assert.ok(html.includes('Original system') && html.includes('Reasoning before stop') && html.includes('cancelled'));
  assert.ok(html.includes('data:image/png;base64,AAAA') && html.includes('Image omitted'));
  for (const secret of ['private-key-label', 'private-key-fingerprint', 'private-secret', 'private-token']) assert.equal(html.includes(secret), false, secret);
  assert.deepEqual(snapshotValue({ api_key: 'secret', metadata: [{ access_token: 'secret', model: 'visible' }] }), { metadata: [{ model: 'visible' }] });
});

test('HTML renders Markdown and GFM but cannot activate hostile transcript markup, image loads or script delimiters', () => {
  const payload = '<script>window.injected=true</script><img src="https://tracking.invalid/x" onerror="evil()">';
  const snapshot = agentSnapshot({ ...CONVERSATION, turns: [{ ...CONVERSATION.turns[0], user: payload, parts: [
    { type: 'text', content: `**Bold**\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\`\`\`html\n${payload}\n\`\`\`\n\n![tracker](https://tracking.invalid/markdown)\n\n[bad](javascript:evil())\n\n${payload}` },
  ] }] });
  const html = htmlFor(snapshot);
  assert.ok(html.includes('<strong>Bold</strong>') && html.includes('<table>'));
  assert.equal(html.match(/<script>/g)?.length, 1, 'only the static control script executes');
  assert.equal(html.includes('<img src="https://tracking.invalid'), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.ok(html.includes('&lt;script&gt;') && html.includes('connect-src \'none\''));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('data-search') && html.includes('data-toggle-panel') && html.includes('data-copy'));
});

test('a display tool the console no longer has is left out of the drawing, with its call kept', () => {
  const conversation = { ...CONVERSATION, turns: [{ ...CONVERSATION.turns[0], traces: [CONVERSATION.turns[0].traces[0],
    { id: 'display', name: 'render_chart', result: { status: 'success' as const }, view: { kind: 'chart', title: 'Retired', html: '<p>drawn</p>' } }] }] };
  const snapshot = agentSnapshot(conversation);
  assert.deepEqual(snapshotInterfaces(snapshot), []);
  // The retired display is an ordinary call now, so it joins the timeline beside the query.
  assert.deepEqual(snapshot.turns[0].segments.map(segment => segment.kind), ['thought', 'text', 'chain', 'text']);
  const chain = snapshot.turns[0].segments[2];
  assert.deepEqual(chain.kind === 'chain' && chain.steps.map(step => step.kind === 'call' && step.name), ['database_query', 'render_chart']);
});

test('image pagination bounds each page and preserves the entire long conversation', () => {
  assert.deepEqual(snapshotImageSlices(50), [{ top: 0, height: 50 }]);
  assert.deepEqual(snapshotImageSlices(SNAPSHOT_IMAGE_PAGE_HEIGHT), [{ top: 0, height: SNAPSHOT_IMAGE_PAGE_HEIGHT }]);
  const height = SNAPSHOT_IMAGE_PAGE_HEIGHT * 3 + 9.2;
  const pages = snapshotImageSlices(height);
  assert.equal(pages.length, 4);
  assert.equal(pages.reduce((sum, page) => sum + page.height, 0), Math.ceil(height));
  assert.equal(pages.at(-1)?.height, 10);
  pages.forEach((page, index) => { assert.equal(page.top, index * SNAPSHOT_IMAGE_PAGE_HEIGHT); assert.ok(page.height <= SNAPSHOT_IMAGE_PAGE_HEIGHT); });
  for (const height of [0, -1, NaN, Infinity]) assert.throws(() => snapshotImageSlices(height));
});

test('image pages end at a block boundary when one fits, and never shrink below half a page for it', () => {
  const page = SNAPSHOT_IMAGE_PAGE_HEIGHT;
  assert.deepEqual(snapshotImageSlices(page + 500, [100, page - 40.5, page + 20]), [{ top: 0, height: page - 41 }, { top: page - 41, height: 541 }]);
  assert.deepEqual(snapshotImageSlices(page + 500, [100]), [{ top: 0, height: page }, { top: page, height: 500 }], 'a boundary too early is not worth a short page');
  assert.deepEqual(snapshotImageSlices(page - 1, [100, 2000]), [{ top: 0, height: page - 1 }], 'a transcript that fits is never cut');
  const pages = snapshotImageSlices(page * 5, Array.from({ length: 200 }, (_, index) => index * 137));
  assert.equal(pages.reduce((sum, slice) => sum + slice.height, 0), page * 5);
  pages.forEach((slice, index) => assert.equal(slice.top, pages.slice(0, index).reduce((sum, previous) => sum + previous.height, 0)));
});

test('the exported control script parses as standalone JavaScript', () => {
  const script = htmlFor().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('the Playground keeps its model heading, and a failed interface call stays a row with its code', () => {
  const playground = htmlFor(playgroundSnapshot([]));
  assert.equal(playgroundSnapshot([]).layout, 'playground');
  assert.ok(!playground.includes('<details class="chain">'));
  const failed = { ...CONVERSATION, turns: [{ ...CONVERSATION.turns[0], present: 'text', rounds: 2, traces: [CONVERSATION.turns[0].traces[0],
    { id: 'display', name: 'present_openui', arguments: '{"ui":"root = Nope("}', result: { status: 'error', code: 'invalid_tool_arguments', detail: 'ui must be a nonempty OpenUI Lang program' } }] }] };
  const snapshot = agentSnapshot(failed);
  assert.deepEqual(snapshot.turns[0].segments.map(segment => segment.kind), ['thought', 'text', 'chain', 'call', 'text']);
  const html = htmlFor(snapshot);
  assert.ok(html.includes('class="call-failure"><code>invalid_tool_arguments</code><span>ui must be a nonempty OpenUI Lang program</span>'));
  assert.ok(html.includes('call-error') && html.includes('present-text') && html.includes('2 rounds, 2 calls') && html.includes('33t'));
});
