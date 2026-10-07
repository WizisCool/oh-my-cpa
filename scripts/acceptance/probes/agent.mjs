import { fulfillFixture, abortFixture } from '../browser-guard.mjs';
import { until } from '../harness.mjs';
import { playgroundFixtures } from './playground.mjs';

const THREAD = 'agent-test-session';
const initial = () => ({ id: THREAD, revision: 1, model: 'vision-alias', client_key_fingerprint: 'playground-identity', turns: [], omitted: 0 });
export function agentFixtures() {
  return [
    ...playgroundFixtures(),
    [url => url.pathname.endsWith('/agent/session'), initial],
    [url => url.pathname.endsWith('/capabilities'), () => ({ capabilities: [
      { name: 'providers_delete', description: 'Delete exactly one provider and its credentials and mappings.', permission: 'destructive', risk: 'high', version: 1, adapters: ['agent'] },
      { name: 'providers_list', description: 'List configured API providers and callable model mappings.', permission: 'read', risk: 'low', version: 1, adapters: ['agent'] },
      { name: 'providers_set_status', description: 'Enable or disable exactly one API provider.', permission: 'write', risk: 'high', version: 1, adapters: ['agent'] },
    ] })],
  ];
}

// ── AG-UI frames ─────────────────────────────────────────────────────────────
//
// Built the way internal/agui's translator emits them, so the page is exercised on the wire
// format the server actually speaks rather than on a shape invented for the probe.

const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const started = (turnId, runId = 'run-test') => ({ type: 'RUN_STARTED', threadId: THREAD, runId, protocolVersion: '1.0', metadata: { turn_id: turnId } });
const step = round => ({ type: 'STEP_STARTED', stepName: `round:${round}`, metadata: { round } });
const text = (messageId, delta) => [
  { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId, delta },
  { type: 'TEXT_MESSAGE_END', messageId },
];
const reasoning = (messageId, delta) => [
  { type: 'REASONING_START', messageId },
  { type: 'REASONING_MESSAGE_START', messageId, role: 'reasoning' },
  { type: 'REASONING_MESSAGE_CONTENT', messageId, delta },
  { type: 'REASONING_MESSAGE_END', messageId },
  { type: 'REASONING_END', messageId },
];
const toolCall = (toolCallId, toolCallName, args = '{}') => [
  { type: 'TOOL_CALL_START', toolCallId, toolCallName, metadata: { started_at_ms: Date.now() - 300 } },
  { type: 'TOOL_CALL_ARGS', toolCallId, delta: args },
  { type: 'TOOL_CALL_END', toolCallId },
];
const toolResult = (toolCallId, receipt, metadata = {}) => ({ type: 'TOOL_CALL_RESULT', messageId: `result:${toolCallId}`, toolCallId, role: 'tool', content: JSON.stringify(receipt), metadata: { started_at_ms: Date.now() - 300, ended_at_ms: Date.now(), ...metadata } });
const snapshot = conversation => ({ type: 'STATE_SNAPSHOT', snapshot: conversation });
const finished = (interrupts = [], runId = 'run-test') => ({
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId,
  outcome: interrupts.length ? { type: 'interrupt', interrupts } : { type: 'success' },
  usage: [{ inputTokens: 1200, outputTokens: 80, totalTokens: 1280 }],
});
const runError = code => ({ type: 'RUN_ERROR', message: code, code });

export async function agentWorkspace({ base, page, check }) {
  let conversation = initial();
  let operation = { id: 'operation-test', capability: 'providers_delete', permission: 'destructive', status: 'pending', preview: { target: 'provider-test', changes: { provider: 'provider-test' } }, result: { status: 'pending' } };
  const runs = [];
  const decisions = [];
  await page.route('**/agent/session', route => route.fulfill({ json: conversation }));
  await page.route('**/agent/operations/operation-test', route => route.fulfill({ json: operation }));
  await page.route('**/agent/operations/operation-test/decision', async route => {
    decisions.push(JSON.parse(route.request().postData()));
    operation = { ...operation, status: 'success', result: { status: 'success', invalidates: ['management-providers'] } };
    await route.fulfill({ json: operation });
  });
  await page.route('**/agent/session/reset', async route => {
    // The server keeps the key, model and effort across a new conversation.
    conversation = { ...conversation, id: 'agent-test-session-2', revision: conversation.revision + 1, turns: [] };
    await route.fulfill({ json: conversation });
  });
  await page.route('**/agent/run', async route => {
    runs.push(JSON.parse(route.request().postData()));
    const isFirst = runs.length === 1;
    const trace = { id: 'tool-test', name: 'providers_delete', arguments: '{"id":"provider-test"}', result: isFirst ? { status: 'pending', operation_id: operation.id } : { status: 'success', data: { is_updated: true } } };
    const parts = isFirst ? [{ type: 'tool', trace_id: trace.id }] : [{ type: 'tool', trace_id: trace.id }, { type: 'text', content: 'The approved operation completed.' }];
    conversation = { ...conversation, revision: conversation.revision + 1, turns: [{ id: 'turn-test', user: 'Disable this provider', reply: isFirst ? '' : 'The approved operation completed.', parts, status: isFirst ? 'pending' : 'success', started_at_ms: Date.now() - 1200, ended_at_ms: Date.now(), traces: [trace] }] };
    const body = isFirst
      ? [started('turn-test'), step(1), ...toolCall(trace.id, trace.name, trace.arguments), toolResult(trace.id, trace.result), snapshot(conversation),
        finished([{ id: operation.id, reason: 'approval', toolCallId: trace.id, metadata: { capability: 'providers_delete', permission: 'destructive' } }])]
      : [started('turn-test', 'run-resume'), toolResult(trace.id, trace.result), step(2), ...text('run-resume:1', 'The approved operation completed.'), snapshot(conversation), finished([], 'run-resume')];
    await route.fulfill({ contentType: 'text/event-stream', body: sse(body) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();

  // The registry is browsable before anything runs: an operator can read what the agent may do,
  // including the destructive entries, without asking a question first.
  const directory = page.locator('[data-testid="agent-directory"]');
  await directory.waitFor();
  check('agent directory lists the destructive capabilities', await directory.getByText('providers_delete').count() === 1);
  check('agent directory groups by permission', await directory.getByText('Destructive', { exact: true }).count() >= 1);
  await directory.getByLabel('Filter by name or description').fill('callable');
  check('agent directory filters to matches', await directory.getByText('providers_list').count() === 1 && await directory.getByText('providers_delete').count() === 0);
  // Rows read in the operator's language, with the identifier beside the title, and the filter
  // matches the text the operator reads rather than only the registry's English.
  await directory.getByLabel('Filter by name or description').fill('the configured');
  check('agent directory filters on the localized description', await directory.getByText('providers_list').count() === 1 && await directory.getByText('providers_delete').count() === 0);
  await directory.getByLabel('Filter by name or description').fill('');
  check('agent directory titles each capability in the console language', await directory.getByText('Delete a provider', { exact: true }).count() === 1);

  // The empty state teaches the request shapes this deployment can answer.
  check('agent empty state offers example prompts', await page.getByText('Try one of these').count() === 1);
  // Sending needs no separate grant: the composer states where a message and the data the agent
  // reads will go, and sending is the act it describes.
  check('agent states where its data goes beside the composer', await page.getByText('Messages and the OMC data the agent reads are sent to the selected CPA model and its upstream. Do not enter secrets in chat.').isVisible());
  check('agent has no consent checkbox to tick before sending', await page.getByRole('checkbox').count() === 0);

  await page.getByRole('button', { name: 'Reasoning effort: Default', exact: true }).click();
  await page.getByRole('menuitem', { name: 'High (high)' }).click();
  const composer = page.getByLabel('Describe an OMC query or action');
  await composer.fill('Disable this provider');
  check('agent can send as soon as a message is typed', await page.getByRole('button', { name: 'Send', exact: true }).isEnabled());
  // The composer decides Enter itself, so the two Enters that must not send are pinned beside the
  // one that must: Shift+Enter adds a line, and an Enter confirming an IME composition belongs to
  // the input method. A send empties the box in the same task, so an unchanged box is the evidence.
  await composer.press('Shift+Enter');
  check('Shift+Enter adds a line instead of sending', await composer.inputValue() === 'Disable this provider\n', JSON.stringify(await composer.inputValue()));
  await composer.fill('Disable this provider');
  // React flushes a key event's updates in a microtask it queues during dispatch, so the box is
  // read from a microtask queued after it: by then a send would have emptied it.
  const afterImeEnter = await composer.evaluate(async (element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    await new Promise((resolve) => queueMicrotask(resolve));
    return element.value;
  });
  check('an Enter that confirms an IME composition does not send', afterImeEnter === 'Disable this provider', JSON.stringify(afterImeEnter));
  await composer.press('Enter');
  // A run that stops for approval puts the decision in the transcript, under the call that raised it.
  const card = page.locator('[data-testid="agent-transcript"] [data-testid="agent-authorization"][data-approval-id="operation-test"]');
  await card.waitFor();
  const request = runs[0];
  check('agent submits a message with Enter as one AG-UI user message', runs.length === 1 && request.protocolVersion === '1.0' && request.messages.length === 1
    && request.messages[0].role === 'user' && request.messages[0].content === 'Disable this provider', JSON.stringify(runs));
  check('agent sends its target and effort as forwarded props and no consent flag', request.forwardedProps.model === 'vision-alias' && request.forwardedProps.client_key_fingerprint === 'playground-identity'
    && request.forwardedProps.reasoning_effort === 'high' && !JSON.stringify(request).includes('has_consent'), JSON.stringify(request.forwardedProps));
  check('agent declares only the display tools it can draw, and never supplies state', JSON.stringify(request.tools.map(tool => tool.name).sort()) === JSON.stringify(['render_chart', 'render_table'])
    && (request.state === undefined || Object.keys(request.state).length === 0), JSON.stringify(request.tools));
  check('agent tells the server the console language', request.context.length === 1 && request.context[0].description === 'console_language' && request.context[0].value === 'en', JSON.stringify(request.context));
  check('agent shows the approval inline under the call, not in a dialog', await page.getByRole('dialog').count() === 0
    && await page.locator('[data-testid="agent-trace"][data-status="pending"]').count() === 1
    && await card.getByText('providers_delete').count() + await card.getByText('provider-test').count() >= 1);
  check('a destructive request is one decision, with nothing to type', await card.getByRole('textbox').count() === 0 && await card.getByText('This cannot be undone.').isVisible());
  check('the composer points at the waiting decision and refuses to send', await page.locator('[data-testid="agent-awaiting"]').isVisible() && await page.getByRole('button', { name: 'Send', exact: true }).isDisabled());
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  await until(() => decisions.length === 1, { label: 'the approval decision reach the server' });
  // Deciding is the whole interaction: the run continues without a separate Resume.
  await page.getByText('The approved operation completed.').waitFor();
  check('agent posts one allow decision with no confirmation text', JSON.stringify(decisions[0]) === JSON.stringify({ approve: true }), JSON.stringify(decisions[0]));
  check('agent continues the run once the operator decides', await card.count() === 0);
  check('agent resumes the interrupt instead of supplying a message or tool history', runs.length === 2 && runs[1].messages.length === 0
    && JSON.stringify(runs[1].resume) === JSON.stringify([{ interruptId: 'operation-test', status: 'resolved' }]), JSON.stringify(runs[1]));
  const settledChain = page.locator('[data-testid="agent-chain"]');
  check('a finished capability chain folds behind the answer', await settledChain.getByRole('button').first().getAttribute('aria-expanded') === 'false');
  check('agent offers a new conversation once there is one to replace', await page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled());
  await page.reload();
  await page.getByText('The approved operation completed.').waitFor();
  const selection = () => page.locator('[data-testid="agent-page"] header').innerText();
  await until(async () => (await selection()).includes('vision-alias'), {
    label: 'the restored header to name the model',
  });
  check('agent restores server-side history and the chosen target after reload', (await selection()).includes('vision-alias') && await page.getByRole('button', { name: 'Reasoning effort: High (high)', exact: true }).count() === 1, await selection());
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.locator('[data-testid="agent-empty"]').waitFor();
  check('a new conversation keeps the key, model and effort', (await selection()).includes('vision-alias') && (await selection()).includes('Test key') && await page.getByRole('button', { name: 'Reasoning effort: High (high)', exact: true }).count() === 1, await selection());
  const preference = await page.evaluate(async () => (await (await fetch('/omc/api/v1/preferences')).json()).preferences);
  check('the chosen target is remembered as the operator\'s own preference', preference?.agent_target?.model === 'vision-alias' && preference?.agent_target?.reasoning_effort === 'high', JSON.stringify(preference?.agent_target));
}

/**
 * An external agent's approval link opens the operation it names, and the same panel tells the
 * operator how such an agent is connected in the first place.
 */
export async function agentExternal({ base, page, check }) {
  const operationID = '0123456789abcdef0123456789abcdef0123456789abcdef';
  let operation = { id: operationID, capability: 'providers_delete', permission: 'destructive', status: 'pending', preview: { target: 'provider-test', changes: { provider: 'provider-test' } }, result: { status: 'pending' } };
  const decisions = [];
  await page.route(`**/agent/operations/${operationID}`, route => route.fulfill({ json: operation }));
  await page.route(`**/agent/operations/${operationID}/decision`, async route => {
    decisions.push(JSON.parse(route.request().postData()));
    operation = { ...operation, status: 'success', result: { status: 'success', invalidates: ['management-providers'] } };
    await route.fulfill({ json: operation });
  });
  await page.goto(`${base}/agent?operation=${operationID}`, { waitUntil: 'domcontentloaded' });

  // The link was followed to decide something, so the panel opens on it without a click.
  const linked = page.getByTestId('agent-linked-operation');
  await linked.getByTestId('agent-authorization').waitFor();
  check('an approval link shows the prepared change and its target', (await linked.innerText()).includes('provider-test') && await linked.getByText('Destructive', { exact: true }).count() === 1, await linked.innerText());
  await linked.getByRole('button', { name: 'Allow', exact: true }).click();
  await linked.getByText('Done', { exact: true }).waitFor();
  check('allowing it records one approval and settles the card', decisions.length === 1 && decisions[0].approve === true && await linked.getByTestId('agent-authorization').count() === 0, JSON.stringify(decisions));

  const guide = page.getByTestId('agent-connect');
  const origin = new URL(base).origin;
  const endpoint = `${origin}${new URL(base).pathname.replace(/\/$/, '')}/api/mcp`;
  check('the guide names this deployment\'s own MCP endpoint', await guide.getByTestId('agent-connect-endpoint').innerText() === endpoint, await guide.getByTestId('agent-connect-endpoint').innerText());
  const snippet = guide.getByTestId('agent-connect-snippet');
  check('the default snippet connects Claude Code by URL without the key in it', (await snippet.innerText()).includes(`--transport http oh-my-cpa ${endpoint}`) && (await snippet.innerText()).includes('$OMCPA_CPA_MANAGEMENT_KEY'), await snippet.innerText());
  await guide.getByText('Codex', { exact: true }).click();
  await snippet.getByText('bearer_token_env_var').waitFor();
  check('choosing another client swaps the snippet', (await snippet.innerText()).includes(`url = "${endpoint}"`), await snippet.innerText());
  const geometry = await guide.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  check('the guide fits the side panel without horizontal overflow', geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
}

/**
 * A run that fails after the server accepted it reports a sentence with the code beneath it; one
 * the server refused before persisting anything hands the message back to the composer.
 */
export async function agentFailureCopy({ base, page, check }) {
  let mode = 'rejected';
  let isDirectoryUnavailable = true;
  await page.route('**/capabilities', route => isDirectoryUnavailable
    ? fulfillFixture(route, { status: 502, json: { error: 'directory unavailable' } })
    : route.fallback());
  await page.route('**/agent/run', route => {
    const body = mode === 'rejected'
      ? [runError('client_key_unavailable')]
      : [started('turn-failed'), step(1), runError('operation_outcome_unknown')];
    return route.fulfill({ contentType: 'text/event-stream', body: sse(body) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  const composer = page.getByLabel('Describe an OMC query or action');
  await composer.fill('Delete a provider');
  const directory = page.getByTestId('agent-directory');
  const retryDirectory = directory.getByRole('button', { name: 'Retry', exact: true });
  await retryDirectory.waitFor();
  isDirectoryUnavailable = false;
  await retryDirectory.click();
  await directory.getByText('providers_delete', { exact: true }).waitFor();
  check('retrying the capability directory preserves the composer draft',
    await composer.inputValue() === 'Delete a provider' && await directory.locator('.omc-load-failure').count() === 0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const rejected = page.locator('[data-testid="agent-rejected"]');
  await rejected.waitFor();
  check('a message refused before the run started goes back into the composer', await composer.inputValue() === 'Delete a provider' && await rejected.getByText('client_key_unavailable').count() === 1, await composer.inputValue());
  check('a refused message leaves no turn behind', await page.locator('[data-testid="agent-turn"]').count() === 0 && await page.locator('[data-testid="agent-running"]').count() === 0);

  mode = 'failed';
  await rejected.getByRole('button', { name: 'Retry', exact: true }).click();
  // A failure states what happened and what to do, and keeps the machine code beneath it for a
  // support conversation rather than making the code the message.
  await page.getByText('The operation may have taken effect but its outcome is unconfirmed. Inspect the target resource before retrying.').first().waitFor();
  check('agent reports a failure as a sentence with the code beneath it', await page.getByText('operation_outcome_unknown').count() >= 1);
}

/**
 * A streamed answer must arrive in a bounded number of paints.
 *
 * This is the property the run loop's coalescing exists for, and it is the one that regresses
 * silently: dispatching every frame straight into React state still renders the same answer, just
 * two hundred times, and nothing in a screenshot can tell the difference. The probe counts the
 * mutations the running message actually receives while a 200-frame answer streams in.
 */
export async function agentStream({ base, page, check }) {
  const answer = Array.from({ length: 200 }, (_, index) => `token${index}`).join(' ');
  await page.route('**/agent/run', route => {
    const deltas = Array.from({ length: 200 }, (_, index) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'run-test:1', delta: `token${index} ` }));
    const conversation = {
      ...initial(),
      revision: 2,
      turns: [{ id: 'turn-stream', user: 'Stream', reply: answer, parts: [{ type: 'text', content: answer }], status: 'success', traces: [], usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 }, started_at_ms: Date.now() - 500, ended_at_ms: Date.now() }],
    };
    const body = [started('turn-stream'), step(1), { type: 'TEXT_MESSAGE_START', messageId: 'run-test:1', role: 'assistant' }, ...deltas, { type: 'TEXT_MESSAGE_END', messageId: 'run-test:1' }, snapshot(conversation), finished()];
    return route.fulfill({ contentType: 'text/event-stream', body: sse(body) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.evaluate(() => {
    const target = { count: 0 };
    Object.defineProperty(window, '__agentUpdates', { value: target, configurable: true });
    // Observed from the page rather than from the running message, because that message is one
    // of the things the run creates: an observer attached to it can only ever see the frames that
    // arrive after it exists. Records are filtered to its subtree instead, which counts the
    // thread's own transient renders out.
    const isInsideRunningMessage = node => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return !element?.closest?.('[data-live-elapsed]') && Boolean(element?.closest?.('[data-testid="agent-running"]'));
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (isInsideRunningMessage(record.target)) target.count += 1;
      }
    }).observe(document.querySelector('[data-testid="agent-page"]'), { subtree: true, childList: true, characterData: true });
  });
  await page.getByLabel('Describe an OMC query or action').fill('Stream an answer');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('token199', { exact: false }).waitFor();
  const updates = await page.evaluate(() => window.__agentUpdates.count);
  // Publishing every frame writes one record per token (~200 here); coalescing writes one per
  // publish tick. The bound sits an order of magnitude below the per-frame figure so a slow
  // machine cannot fail it, and far enough above the coalesced figure that removing the
  // coalescing fails it.
  check('a 200-frame answer is coalesced into a bounded number of paints', updates > 0 && updates < 100, `updates=${updates}`);
  const footer = await page.locator('[data-testid="agent-turn"]').last().innerText();
  check('a finished answer states the tokens the gateway reported', footer.includes('1,280') || footer.includes('1.28K') || footer.includes('1.3K'), footer);
}

export async function agentNarrow({ base, page, check }) {
  // A stored turn whose call returned one long unbroken field: its digest is a single line, and
  // that line used to size the call chain - and with it the whole transcript - so a sideways swipe
  // on a phone dragged the conversation off the screen.
  const longValue = 'a-value-without-any-break-'.repeat(12);
  const privateQueryCell = 'private-query-cell-not-for-preview';
  await page.route('**/agent/session', route => route.fulfill({ json: { ...initial(), revision: 2, turns: [
    { id: 'turn-wide', user: 'Which provider fails most?', reply: 'Checked.', parts: [{ type: 'tool', trace_id: 'call-wide' }, { type: 'text', content: 'Checked.' }], status: 'success', started_at_ms: Date.now() - 900, ended_at_ms: Date.now(), traces: [
      { id: 'call-wide', name: 'database_query', arguments: JSON.stringify({ sql: `select '${longValue}'` }), result: { status: 'success', data: { columns: ['provider'], rows: [[privateQueryCell]], is_truncated: false, detail: longValue } } },
    ] },
  ] } }));
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.getByText('Checked.', { exact: true }).waitFor();
  const chain = page.locator('[data-testid="agent-chain"]');
  if (await page.locator('[data-testid="agent-trace"]').count() === 0) await chain.getByRole('button').first().click();
  await page.locator('[data-testid="agent-trace"]').first().waitFor();
  check('a database query stays a call row without a result preview', await page.locator('[data-testid="agent-trace"]').first().getByRole('button').count() === 1 && await page.getByText(privateQueryCell, { exact: false }).count() === 0);
  // scrollWidth counts content past a clipped edge too, so this proves nothing is wider than the
  // column rather than only that the overflow is hidden.
  const transcript = await page.locator('[data-testid="agent-transcript"]').evaluate(box => ({ scroll: box.scrollWidth, client: box.clientWidth }));
  check('a long call digest does not widen the transcript on a phone', transcript.scroll <= transcript.client, JSON.stringify(transcript));
  const composer = await page.locator('[data-testid="agent-page"] form').last().boundingBox();
  check('the Agent composer starts compact on a phone', composer.height <= 90, `height=${composer.height}`);
  // On a phone the target stays in the head rather than behind a settings sheet: which model a
  // message will reach is never one tap away.
  check('Agent keeps its key and model selectors visible on a phone', await page.getByLabel('Model', { exact: true }).isVisible() && await page.getByLabel('Client key', { exact: true }).isVisible());
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, height: innerHeight, bottom: document.querySelector('[data-testid="agent-page"]').getBoundingClientRect().bottom }));
  check('Agent composer fits a narrow viewport', geometry.scroll <= geometry.width && geometry.bottom <= geometry.height + 1, JSON.stringify(geometry));

  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const directory = page.locator('[data-testid="agent-directory"]');
  await directory.waitFor();
  await page.goBack();
  await until(async () => await page.locator('[data-testid="agent-directory"]:visible').count() === 0);
  check('Back dismisses the side panel without navigating', new URL(page.url()).pathname.endsWith('/agent'));
  await page.locator('[data-testid="agent-trace"]').first().getByRole('button').first().click();
  const details = page.locator('[data-testid="agent-details"]');
  await details.waitFor();
  check('query details omit raw results from an older session', !(await details.innerText()).includes(privateQueryCell));
  await page.goBack();
  await until(async () => await page.locator('[data-testid="agent-details"]:visible').count() === 0);
}

/**
 * The operator's message is in the transcript the moment it is sent, not when the run ends; a
 * message sent during the run waits in a queue and goes out after it; and a turn is drawn in the
 * order the model worked.
 */
export async function agentLive({ base, page, check }) {
  let releaseResult;
  const resultReleased = new Promise(resolve => { releaseResult = resolve; });
  const runs = [];
  const trace = { id: 'call-usage', name: 'usage_aggregate', arguments: '{"window":"1h","group_by":"model"}', result: { status: 'success', data: { window: '1h', failed: 6 } } };
  const parts = [
    { type: 'thought', content: 'Compare failures by model first.' },
    { type: 'text', content: 'Let me read the last hour.' },
    { type: 'tool', trace_id: trace.id },
    { type: 'thought', content: 'One model dominates.' },
    { type: 'text', content: 'Two models failed most.' },
  ];
  const firstTurn = { id: 'turn-live', user: 'Which models failed?', reply: 'Let me read the last hour.\n\nTwo models failed most.', parts, status: 'success', traces: [trace], rounds: 2, started_at_ms: Date.now() - 900, ended_at_ms: Date.now() };
  // The first run is held until the probe has seen the sent message and queued a second one.
  await page.route('**/agent/run', async route => {
    const input = JSON.parse(route.request().postData());
    runs.push(input);
    if (runs.length === 1) {
      await resultReleased;
      await route.fulfill({ contentType: 'text/event-stream', body: sse([
        started('turn-live'), step(1), ...reasoning('run-test:1', parts[0].content), ...text('run-test:2', parts[1].content), ...toolCall(trace.id, trace.name, trace.arguments),
        toolResult(trace.id, trace.result), step(2), ...reasoning('run-test:3', parts[3].content), ...text('run-test:4', parts[4].content),
        snapshot({ ...initial(), revision: 2, turns: [firstTurn] }), finished(),
      ]) });
      return;
    }
    const second = { id: 'turn-queued', user: input.messages[0]?.content ?? '', reply: 'Queued answer.', parts: [{ type: 'text', content: 'Queued answer.' }], status: 'success', traces: [], started_at_ms: Date.now() - 200, ended_at_ms: Date.now() };
    await route.fulfill({ contentType: 'text/event-stream', body: sse([started('turn-queued', 'run-queued'), step(1), ...text('run-queued:1', 'Queued answer.'),
      snapshot({ ...initial(), revision: 3, turns: [firstTurn, second] }), finished([], 'run-queued')]) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  const input = page.getByLabel('Describe an OMC query or action');
  const emptyHeight = await input.evaluate(element => element.getBoundingClientRect().height);
  check('the desktop composer starts at one line', emptyHeight < 30, `height=${emptyHeight}`);
  await input.fill('First line\nSecond line\nThird line');
  const expandedHeight = await input.evaluate(element => element.getBoundingClientRect().height);
  check('the composer grows for multiline input', expandedHeight > emptyHeight * 2, `empty=${emptyHeight} expanded=${expandedHeight}`);
  await input.fill('Which models failed?');
  await input.press('Enter');
  const transcript = page.locator('[data-testid="agent-transcript"]');
  await transcript.getByText('Which models failed?', { exact: true }).waitFor({ timeout: 2000 });
  check('the sent message appears before the run answers', await transcript.getByText('Which models failed?', { exact: true }).isVisible() && await page.locator('[data-testid="agent-activity"]').isVisible());
  check('the composer is cleared once the message is sent', await input.inputValue() === '');
  const bubble = await transcript.locator('[data-role="user"]').last().evaluate(element => element.firstElementChild.getBoundingClientRect().height);
  check('a single-line user message has compact vertical padding', bubble < 50, `height=${bubble}`);
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  check('an empty running composer shows stop without a queue button', await page.getByRole('button', { name: 'Queue', exact: true }).count() === 0);
  await page.mouse.move(0, 0);
  const stopStyle = await page.getByRole('button', { name: 'Stop', exact: true }).evaluate(element => {
    const style = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.style.color = 'var(--border)'; element.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return { border: style.borderTopColor, expected, shadow: style.boxShadow };
  });
  check('light Stop uses the neutral token border without a black shadow', stopStyle.border === stopStyle.expected && stopStyle.shadow === 'none', JSON.stringify(stopStyle));
  const elapsedSamples = await page.locator('[data-testid="agent-activity"] [data-live-elapsed]').evaluate(element => new Promise(resolve => {
    const samples = [];
    const observer = new MutationObserver(() => {
      samples.push({ text: element.textContent, at: performance.now() });
      if (samples.length >= 8 && samples.filter(sample => /^\d+\.\ds$/.test(sample.text)).length >= 3) { observer.disconnect(); resolve(samples); }
    });
    observer.observe(element, { subtree: true, characterData: true, childList: true });
  }));
  const seconds = elapsedSamples.filter(sample => /^\d+\.\ds$/.test(sample.text));
  check('live elapsed changes in tenths instead of whole seconds', seconds.length >= 3 && seconds.every(sample => /^\d+\.\ds$/.test(sample.text)) && seconds.slice(1).every((sample, index) => Math.abs(parseFloat(sample.text) - parseFloat(seconds[index].text) - 0.1) < 0.01), JSON.stringify(elapsedSamples));


  await input.fill('And the day before?');
  await page.getByRole('button', { name: 'Queue', exact: true }).waitFor();
  check('a running composer with a draft replaces stop with queue', await page.getByRole('button', { name: 'Stop', exact: true }).count() === 0);

  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await page.locator('[data-testid="composer-queue-item"]').waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  check('queueing clears the draft and restores the stop action', await input.inputValue() === '' && await page.getByRole('button', { name: 'Queue', exact: true }).count() === 0);

  check('a message sent during a run waits in the queue instead of starting a second run', runs.length === 1 && await page.locator('[data-testid="composer-queue-item"]').getByText('And the day before?').isVisible(), `runs=${runs.length}`);
  releaseResult();
  await page.getByText('Two models failed most.').waitFor();
  await page.getByText('Queued answer.').waitFor();
  check('the queued message goes out once the run settles, as its own run', runs.length === 2 && runs[1].messages[0].content === 'And the day before?' && await page.locator('[data-testid="composer-queue-item"]').count() === 0, JSON.stringify(runs.map(run => run.messages)));
  const turn = page.locator('[data-testid="agent-turn"]').first();
  const chain = turn.locator('[data-testid="agent-chain"]');
  await page.getByText('Two models failed most.').waitFor();
  check('a finished stretch of reasoning folds back behind its answer', await turn.getByRole('button', { name: 'Thought process', exact: true }).evaluateAll(buttons => buttons.every(button => button.getAttribute('aria-expanded') === 'false')));
  if (await turn.locator('[data-testid="agent-trace"]').count() === 0) await chain.getByRole('button').first().click();
  for (const title of await turn.getByText('Thought process', { exact: true }).all()) await title.click();
  await turn.getByText('One model dominates.').waitFor();
  const content = await turn.innerText();
  const positions = ['Compare failures by model first.', 'Let me read the last hour.', 'usage_aggregate', 'One model dominates.', 'Two models failed most.'].map(fragment => content.indexOf(fragment));
  check('a turn is drawn in the order the model worked', positions.every(position => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]), JSON.stringify(positions));
  check('each stretch of reasoning keeps its own place', await turn.getByText('Thought process', { exact: true }).count() === 2);
  // A call row opens its details in the side panel: arguments and the result the model received.
  await turn.locator('[data-testid="agent-trace"]').first().getByRole('button').first().click();
  const details = page.locator('[data-testid="agent-details"]');
  await details.getByText('Arguments', { exact: true }).waitFor();
  check('a call opens its arguments and result in the details tab', (await details.innerText()).includes('group_by') && (await details.innerText()).includes('failed'), await details.innerText());
  await verifyAgentRecovery({ base, page, check });
}

/**
 * Display calls draw the rows the server froze on the trace, never the model's text: a table is a
 * table with its own CSV actions, and a chart can be read as the data behind it.
 */
export async function agentViews({ base, page, check }) {
  const rows = [{ model: 'gpt-4.1', requests: 120 }, { model: 'gemini-2.5', requests: 80 }];
  const tableView = { kind: 'table', title: 'Requests by model', columns: ['model', 'requests'], rows, source: { call_id: 'call-usage', path: 'rows' } };
  const chartView = { kind: 'chart', title: 'Request share', chart: { type: 'column', x: 'model', y: ['requests'] }, columns: ['model', 'requests'], rows, source: { call_id: 'call-usage', path: 'rows' } };
  await page.route('**/agent/session', route => route.fulfill({ json: { ...initial(), revision: 2, turns: [{
    id: 'turn-views', user: 'Chart requests by model', reply: 'Here they are.', status: 'success', started_at_ms: Date.now() - 900, ended_at_ms: Date.now(),
    parts: [{ type: 'tool', trace_id: 'call-usage' }, { type: 'tool', trace_id: 'call-table' }, { type: 'tool', trace_id: 'call-chart' }, { type: 'text', content: 'Here they are.' }],
    traces: [
      { id: 'call-usage', name: 'usage_aggregate', arguments: '{}', result: { status: 'success', data: { rows } } },
      { id: 'call-table', name: 'render_table', arguments: '{"title":"Requests by model"}', result: { status: 'success', data: { rendered: true, rows: 2 } }, view: tableView },
      { id: 'call-chart', name: 'render_chart', arguments: '{"title":"Request share"}', result: { status: 'success', data: { rendered: true, rows: 2 } }, view: chartView },
    ],
  }] } }));
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.getByText('Here they are.').waitFor();
  const table = page.locator('[data-testid="agent-view"][data-kind="table"]');
  const chart = page.locator('[data-testid="agent-view"][data-kind="chart"]');
  await table.waitFor();
  await chart.waitFor();
  check('a display call draws its frozen rows as a table', await table.getByText('Requests by model').count() >= 1 && await table.getByText('gemini-2.5').count() === 1 && await table.getByText('120').count() === 1);
  check('a display call is drawn outside the call chain, where the answer reads', await page.locator('[data-testid="agent-chain"] [data-testid="agent-view"]').count() === 0);
  await chart.locator('canvas').first().waitFor();
  check('a chart view draws on the console chart stack', await chart.locator('canvas').count() >= 1 && await chart.getByRole('img', { name: 'Request share' }).count() === 1);
  await chart.getByText('Data', { exact: true }).click();
  await chart.getByText('gpt-4.1').waitFor();
  check('a chart can be read as the rows behind it', await chart.getByText('gpt-4.1').count() === 1 && await chart.locator('canvas').count() === 0);

}

/**
 * `ask_question` takes the composer's place: the agent's options, a typed answer beside them, and
 * sending the reply continues the run.
 */
export async function agentQuestion({ base, page, check }) {
  let conversation = initial();
  let operation = { id: 'question-test', capability: 'ask_question', permission: 'read', human_input: 'answer', status: 'pending', preview: { target: 'Which window?', changes: { questions: [
    { question: 'Which window should the summary cover?', header: 'Window', options: [{ label: 'Last hour' }, { label: 'Last 24 hours', description: 'The console default' }] },
    { question: 'Which providers matter?', options: [{ label: 'OpenAI' }, { label: 'Gemini' }], multi_select: true },
  ] } }, result: { status: 'pending' } };
  const runs = [];
  const decisions = [];
  await page.route('**/agent/session', route => route.fulfill({ json: conversation }));
  await page.route('**/agent/operations/question-test', route => route.fulfill({ json: operation }));
  await page.route('**/agent/operations/question-test/decision', async route => {
    decisions.push(JSON.parse(route.request().postData()));
    operation = { ...operation, status: 'success', result: { status: 'success', data: { answers: [] } } };
    await route.fulfill({ json: operation });
  });
  await page.route('**/agent/run', async route => {
    runs.push(JSON.parse(route.request().postData()));
    const isFirst = runs.length === 1;
    const trace = { id: 'tool-question', name: 'ask_question', arguments: '{}', result: isFirst ? { status: 'pending', operation_id: operation.id } : { status: 'success', data: { answers: [] } } };
    const parts = isFirst ? [{ type: 'tool', trace_id: trace.id }] : [{ type: 'tool', trace_id: trace.id }, { type: 'text', content: 'Here is the 24 hour summary.' }];
    conversation = { ...conversation, revision: conversation.revision + 1, turns: [{ id: 'turn-question', user: 'Summarize usage', reply: isFirst ? '' : 'Here is the 24 hour summary.', parts, status: isFirst ? 'pending' : 'success', started_at_ms: Date.now() - 800, ended_at_ms: Date.now(), traces: [trace] }] };
    const body = isFirst
      ? [started('turn-question'), step(1), ...toolCall(trace.id, trace.name), toolResult(trace.id, trace.result), snapshot(conversation),
        finished([{ id: operation.id, reason: 'question', toolCallId: trace.id, metadata: { capability: 'ask_question', permission: 'read' } }])]
      : [started('turn-question', 'run-resume'), toolResult(trace.id, trace.result), step(2), ...text('run-resume:1', 'Here is the 24 hour summary.'), snapshot(conversation), finished([], 'run-resume')];
    await route.fulfill({ contentType: 'text/event-stream', body: sse(body) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.getByLabel('Describe an OMC query or action').fill('Summarize usage');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const panel = page.locator('[data-testid="agent-question"]');
  await panel.waitFor();
  check('a question takes the composer\'s place', await page.getByLabel('Describe an OMC query or action').count() === 0 && await panel.getByText('Which window should the summary cover?').isVisible());
  // One question at a time behind a tab per question and a review tab, as the coding agents' own
  // question prompts do; the first step offers Next, never a submit that could skip the rest.
  check('each question has its own tab, and a review tab ends the row', await panel.getByRole('tab').count() === 3 && await panel.getByText('Question 1 of 2').isVisible());
  const next = panel.getByRole('button', { name: 'Next', exact: true });
  check('an unanswered question cannot move on', await next.isDisabled() && await panel.getByRole('button', { name: 'Submit answer', exact: true }).count() === 0);
  // A digit picks its option, and a single choice moves on by itself because the pick is the answer.
  await panel.press('2');
  await panel.getByText('Which providers matter?').waitFor();
  check('a digit picks a single-choice option and moves to the next question', await panel.getByRole('tab', { name: /Window/ }).getAttribute('aria-selected') === 'false'
    && await panel.getByText('Question 2 of 2').isVisible());
  // Choices are asserted by what they commit rather than by the click: the row renders its checked
  // state from the draft it is handed, one render after the click that changed it.
  const openAI = panel.getByRole('checkbox', { name: 'OpenAI' });
  await openAI.click();
  await until(async () => await openAI.getAttribute('aria-checked') === 'true', { label: 'the chosen option to commit' });
  await panel.getByRole('checkbox', { name: 'Something else…' }).click();
  await panel.getByLabel('Type your answer').fill('Exclude test keys');
  await until(async () => await next.isEnabled(), { label: 'the second answer to allow Next' });
  await next.click();
  const submit = panel.getByRole('button', { name: 'Submit answer', exact: true });
  await submit.waitFor();
  check('the review step shows every answer before it is sent', await panel.getByText('Last 24 hours', { exact: true }).isVisible() && await panel.getByText('OpenAI, Exclude test keys', { exact: true }).isVisible());
  await submit.click();
  await page.getByText('Here is the 24 hour summary.').waitFor();
  const answers = decisions[0]?.answer?.answers;
  check('the reply carries each question\'s choices and typed text', decisions.length === 1 && decisions[0].approve === true
    && JSON.stringify(answers) === JSON.stringify([{ selected: ['Last 24 hours'], text: '' }, { selected: ['OpenAI'], text: 'Exclude test keys' }]), JSON.stringify(decisions));
  check('answering resumes the question\'s interrupt and returns the composer', runs.length === 2 && runs[1].messages.length === 0
    && runs[1].resume?.[0]?.interruptId === 'question-test' && await page.getByLabel('Describe an OMC query or action').count() === 1, JSON.stringify(runs[1]));
}


async function verifyAgentRecovery({ base, page, check }) {
  let generationCount = 0;
  let subscriptionCount = 0;
  let cancelCount = 0;
  let runID;
  let conversation = initial();
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  await page.route('**/agent/session', route => route.fulfill({ json: conversation }));
  await page.route('**/agent/runs/*/cancel', route => { cancelCount++; return route.fulfill({ json: { is_cancelled: true } }); });
  await page.route('**/agent/run', route => {
    generationCount++;
    runID = route.request().headers()['x-omc-run-id'];
    conversation = { ...initial(), active_run_id: runID, revision: 2, turns: [{ id: 'recover-turn', user: 'Recover this run', reply: '', status: 'running', traces: [], started_at_ms: Date.now() }] };
    return route.fulfill({ contentType: 'text/event-stream', body: sse([started('recover-turn', runID), ...text('recover-message', 'Partial answer')]) });
  });
  await page.route('**/agent/runs/*', async route => {
    if (route.request().method() === 'POST') { cancelCount++; await route.fulfill({ json: { is_cancelled: true } }); return; }
    subscriptionCount++;
    if (subscriptionCount === 1) { await abortFixture(route, 'internetdisconnected'); return; }
    await completion;
    const finishedConversation = { ...conversation, active_run_id: undefined, revision: 3, turns: [{ ...conversation.turns[0], reply: 'Recovered complete.', status: 'success', ended_at_ms: Date.now() }] };
    conversation = finishedConversation;
    try { await route.fulfill({ contentType: 'text/event-stream', body: sse([started('recover-turn', runID), ...text('recover-message', 'Recovered complete.'), snapshot(finishedConversation), finished([], runID)]) }); } catch { /* The old subscriber was closed by reload. */ }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Describe an OMC query or action').fill('Recover this run');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => subscriptionCount >= 2, { label: 'the failed subscription to reconnect' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await until(() => subscriptionCount >= 3, { label: 'refresh to attach to the original run' });
  check('Agent refresh reattaches without sending Stop or starting another model call', generationCount === 1 && cancelCount === 0, JSON.stringify({ generationCount, cancelCount, subscriptionCount }));
  release();
  await page.getByText('Recovered complete.', { exact: true }).waitFor();
  check('Agent replay replaces partial text and restores one complete answer', await page.getByText('Recovered complete.', { exact: true }).count() === 1 && await page.getByText('Partial answer', { exact: true }).count() === 0 && generationCount === 1);
}
