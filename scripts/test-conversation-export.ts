import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { agentSnapshot, playgroundSnapshot, snapshotImageSlices, snapshotValue, SNAPSHOT_IMAGE_PAGE_HEIGHT } from '../web/src/agent/conversationSnapshot.ts';
import { chartTicks, conversationHTML } from '../web/src/agent/conversationHtml.ts';
import type { SnapshotLabels } from '../web/src/agent/conversationHtml.ts';
import type { Conversation, DisplayView } from '../web/src/agent/types.ts';
import type { Turn as PlaygroundTurn } from '../web/src/pages/playground/state.ts';

const LABELS: SnapshotLabels = {
  title: 'OMC conversation', operator: 'Operator', answer: 'Answer', model: 'Model', exportedAt: 'Exported',
  thought: 'Reasoning', parameters: 'Parameters', arguments: 'Arguments', result: 'Result', data: 'Data',
  copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', search: 'Search conversation', expand: 'Expand details',
  panel: 'Side panel', close: 'Close', chart: 'Chart', usage: 'Tokens', noMatches: 'No turns match', turns: count => `${count} turns`,
  axisTime: milliseconds => `time-${milliseconds}`, number: value => String(value), calls: count => `Used ${count} capabilities`, tokens: count => `${count} tokens`,
  collapse: 'Collapse details', print: 'Print', imageOmitted: 'Image omitted', privacy: 'Snapshot; share with care',
  omitted: count => `${count} omitted turns`, status: status => status, capability: name => name,
  failure: code => `Failed ${code}`, date: milliseconds => new Date(milliseconds).toISOString(), duration: milliseconds => `${milliseconds}ms`,
};
const VIEW: DisplayView = { kind: 'chart', title: 'Requests', chart: { type: 'column', x: 'day', y: ['n'] }, columns: ['day', 'n'], rows: [{ day: 'Monday', n: 2 }, { day: 'Tuesday', n: 10 }] };
const CONVERSATION: Conversation = { id: 'private-session', revision: 1, model: 'test-model', client_key_fingerprint: 'private-key-fingerprint', omitted: 3,
  active_run_id: 'private-run-id', turns: [{ id: 'turn', user: 'Question', reply: 'First\n\nLast', status: 'success', started_at_ms: 100, ended_at_ms: 500,
    usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
    parts: [{ type: 'thought', content: 'Thought' }, { type: 'text', content: 'First' }, { type: 'tool', trace_id: 'query' }, { type: 'tool', trace_id: 'display' }, { type: 'text', content: 'Last' }],
    traces: [{ id: 'query', name: 'database_query', arguments: '{"sql":"select model from usage_events"}', result: { status: 'success', data: { rows: ['private-query-row'] }, operation_id: 'private-operation' } },
      { id: 'display', name: 'render_chart', result: { status: 'success', data: { rendered: true } }, view: VIEW }],
  }] };
function htmlFor(snapshot = agentSnapshot(CONVERSATION)) {
  return conversationHTML({ snapshot, labels: LABELS, exportedAt: new Date(0), language: 'en', appearance: { variables: { '--bg': '#121214', '--surface': '#1c1c1f', '--fg': '#f4f4f6', '--accent': '#00b8db' } } });
}

test('Agent exports ordered reasoning, calls and answers, metrics and frozen successful figures, not execution identities or SQL rows', () => {
  const snapshot = agentSnapshot(CONVERSATION);
  assert.deepEqual(snapshot.turns[0].blocks.map(block => block.kind), ['thought', 'text', 'call', 'call', 'text']);
  assert.equal(snapshot.turns[0].blocks[2].result, undefined);
  assert.equal(snapshot.turns[0].duration, 400);
  assert.equal(snapshot.turns[0].usage?.total_tokens, 33);
  assert.deepEqual(snapshot.turns[0].views, [VIEW]);
  const html = htmlFor(snapshot);
  for (const secret of ['private-session', 'private-key-fingerprint', 'private-run-id', 'private-query-row', 'private-operation']) assert.equal(html.includes(secret), false, secret);
  assert.ok(html.includes('Thought') && html.includes('Monday') && html.includes('3 omitted turns'));
  assert.ok(html.indexOf('First') < html.indexOf('database_query') && html.indexOf('database_query') < html.indexOf('Last'));
  assert.ok(html.includes('aria-label="Requests"') && html.includes('<rect'));
  assert.ok(html.includes('select model from usage_events'));
  snapshot.turns[0].views[0].rows[0].n = 99;
  assert.equal(VIEW.rows[0].n, 2, 'export is detached from live display data');
  for (const status of ['running', 'pending', 'error', 'cancelled']) assert.deepEqual(agentSnapshot({ ...CONVERSATION, turns: [{ ...CONVERSATION.turns[0], status }] }).turns[0].views, []);
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
  assert.ok(html.includes('data-search') && html.includes('data-sort') && html.includes('data-copy'));
});

test('all chart kinds carry their data and accessible vector marks, including zero and negative readings', () => {
  for (const type of ['line', 'area', 'column', 'bar', 'pie'] as const) {
    const snapshot = agentSnapshot(CONVERSATION);
    snapshot.turns[0].views[0].chart!.type = type;
    const html = htmlFor(snapshot);
    assert.ok(html.includes('<svg class="chart"'), type);
    assert.ok(html.includes('Tuesday') && html.includes('>10<'), type);
  }
  const snapshot = agentSnapshot(CONVERSATION);
  snapshot.turns[0].views[0].rows = [{ day: 'zero', n: 0 }, { day: 'negative', n: -2 }];
  assert.ok(htmlFor(snapshot).includes('negative'));
  const timed = agentSnapshot(CONVERSATION);
  timed.turns[0].views[0].rows = [{ day: 1791370000000, n: 1 }, { day: 1791373600000, n: 2 }];
  assert.ok(htmlFor(timed).includes('>time-1791370000000<'), 'a time-bucketed axis reads as time, not as an epoch');
});

test('image pagination bounds each canvas and preserves the entire long conversation', () => {
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

test('chart ticks are round, bracket the data and keep the zero baseline', () => {
  assert.deepEqual(chartTicks(2, 10), [0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(chartTicks(120000, 260000), [0, 100000, 200000, 300000]);
  assert.deepEqual(chartTicks(-2, 0), [-2, -1.5, -1, -0.5, 0]);
  assert.deepEqual(chartTicks(0, 0), [0], 'an all-zero series is a baseline, not an invented scale');
  assert.ok(chartTicks(0.1, 0.3).every(tick => String(tick).length < 6), 'no floating-point tails reach an axis label');
});

test('the exported control script parses as standalone JavaScript', () => {
  const script = htmlFor().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});
