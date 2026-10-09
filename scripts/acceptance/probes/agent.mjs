import { checkConversationExport } from './conversation-export.mjs';
import { fulfillFixture, abortFixture } from '../browser-guard.mjs';
import { settleLayout, until } from '../harness.mjs';
import { playgroundFixtures } from './playground.mjs';

const THREAD = 'agent-test-session';
const initial = () => ({ id: THREAD, revision: 1, model: 'vision-alias', client_key_fingerprint: 'playground-identity', turns: [], omitted: 0 });
export function agentFixtures() {
  return [
    ...playgroundFixtures(),
    [url => url.pathname.endsWith('/agent/session'), initial],
    [url => url.pathname.endsWith('/management/model-square'), () => ({ models: [], providers: [], routes: [], partial: [], metadata_updated_at: '', model_info: { 'vision-alias': { id: 'vision-alias', name: 'Vision', limit: { context: 4000 }, modalities: {} } } })],
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
  // At rest the page is the conversation alone: no ruled head, no panel beside it.
  check('the agent page opens on the conversation with nothing beside it', await page.locator('[data-testid="agent-page"] header').count() === 0
    && await page.locator('[data-testid="agent-directory"]').count() === 0);
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
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
  await page.keyboard.press('Escape');
  await until(async () => await page.locator('[data-testid="agent-directory"]:visible').count() === 0, { label: 'the capability drawer to close' });

  // The empty state teaches the request shapes this deployment can answer.
  // An empty conversation gathers its greeting, its box and its starting questions mid-page.
  const heroBox = await page.locator('[data-testid="agent-page"] form').last().boundingBox();
  const heroExamples = page.getByLabel('Try one of these');
  check('agent empty state offers example prompts under a centred composer', await heroExamples.getByRole('button').count() === 4
    && heroBox.y + heroBox.height < page.viewportSize().height * 0.75 && (await heroExamples.boundingBox()).y > heroBox.y, JSON.stringify(heroBox));
  // Sending needs no separate grant: the composer states where a message and the data the agent
  // reads will go, and sending is the act it describes.
  check('agent states where its data goes beside the composer', await page.getByText('Messages and the OMC data the agent reads are sent to the selected CPA model and its upstream. Do not enter secrets in chat.').isVisible());
  check('agent has no consent checkbox to tick before sending', await page.getByRole('checkbox').count() === 0);

  const composer = page.getByLabel('Describe an OMC query or action');
  // `/` and `@` open a list above the box while typing. Enter belongs to the highlighted row
  // while a list is open, so neither completion may reach the model as a message.
  await composer.pressSequentially('/');
  const commands = page.locator('[data-testid="composer-commands"]');
  await commands.getByText('/ui', { exact: true }).waitFor();
  // A command is something the page can do now. An empty conversation has nothing to retry,
  // export or replace, so those are not listed; and no row is a canned question.
  const listed = (await commands.locator('button, [role="option"]').allInnerTexts()).map(text => text.split('\n')[0].trim());
  check('the command list offers only what can run now', ['/ui', '/text', '/capabilities', '/connect'].every(name => listed.includes(name))
    && !listed.some(name => ['/new', '/retry', '/edit', '/export', '/image', '/stop', '/usage'].includes(name)), JSON.stringify(listed));
  await composer.pressSequentially('ui');
  await commands.getByText('/text', { exact: true }).waitFor({ state: 'detached' });
  await composer.press('Enter');
  const present = page.locator('[data-testid="agent-present"]');
  await present.waitFor();
  check('/ui sets how the next answer is presented without sending', await composer.inputValue() === '' && await present.getAttribute('data-present') === 'ui'
    && (await present.innerText()).includes('Interactive UI') && runs.length === 0, JSON.stringify({ value: await composer.inputValue(), runs: runs.length }));
  await page.getByRole('button', { name: 'Back to the default answer format', exact: true }).click();
  check('the presentation chip is removable', await present.count() === 0);
  // The frame holds what a message is sent with and nothing else: attach, effort, the model, send.
  const frameButtons = await page.locator('[data-testid="agent-page"] form button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') ?? ''));
  check('the composer frame offers attach, effort, the model and send only',
    frameButtons.length === 4 && frameButtons[0] === 'Attach images or text files' && frameButtons[1].startsWith('Reasoning effort:') && frameButtons[2].startsWith('Model:') && frameButtons[3] === 'Send', JSON.stringify(frameButtons));
  await composer.pressSequentially('/ui');
  await commands.getByText('/text', { exact: true }).waitFor({ state: 'detached' });
  await composer.press('Enter');
  await present.waitFor();
  await composer.pressSequentially('Explain @providers_l');
  await page.locator('[data-testid="composer-mentions"]').getByText('providers_list', { exact: true }).waitFor();
  await composer.press('Enter');
  check('a mention completes to the bare name without sending', (await composer.inputValue()).trim() === 'Explain providers_list' && runs.length === 0,
    JSON.stringify({ value: await composer.inputValue(), runs: runs.length }));
  await composer.fill('');

  // Both message settings use named rows: arrows browse, and only confirmation changes a request.
  const modelChip = page.getByTestId('target-chip');
  await modelChip.focus();
  await page.keyboard.press('ArrowDown');
  const modelPicker = page.getByTestId('target-popover');
  await modelPicker.waitFor();
  await until(async () => modelPicker.getByRole('option', { name: 'vision-alias', exact: true }).evaluate(option => option === document.activeElement));
  await page.keyboard.press('ArrowDown');
  check('model arrows move focus without changing the target', await modelPicker.getByRole('option', { name: 'text-only', exact: true }).evaluate(option => option === document.activeElement)
    && (await modelChip.innerText()).includes('vision-alias'));
  await page.keyboard.press('Escape');
  await modelPicker.waitFor({ state: 'hidden' });
  check('Escape returns model focus to the composer control', await modelChip.evaluate(button => button === document.activeElement));

  const effortChip = page.getByTestId('effort-chip');
  await effortChip.click();
  const effortPicker = page.getByTestId('effort-popover');
  const modelDefault = effortPicker.getByRole('option', { name: 'Use model default', exact: true });
  await modelDefault.waitFor();
  await until(async () => modelDefault.evaluate(option => option === document.activeElement));
  check('reasoning default is an explicit selected choice', await modelDefault.getAttribute('aria-selected') === 'true');
  const extraHighColumns = await effortPicker.getByRole('option', { name: 'Extra high (xhigh)', exact: true }).evaluate(row => {
    const [parameter, description] = row.children;
    return {
      parameter: parameter.textContent,
      description: description.textContent,
      parameterLeft: parameter.getBoundingClientRect().left,
      descriptionLeft: description.getBoundingClientRect().left,
      parameterColor: getComputedStyle(parameter).color,
      descriptionColor: getComputedStyle(description).color,
    };
  });
  check('reasoning leads with its parameter name and gives the description secondary ink', extraHighColumns.parameter === 'xHigh'
    && extraHighColumns.description === 'Extra high' && extraHighColumns.parameterLeft < extraHighColumns.descriptionLeft
    && extraHighColumns.parameterColor !== extraHighColumns.descriptionColor, JSON.stringify(extraHighColumns));
  const effortWidth = await effortPicker.evaluate(panel => panel.getBoundingClientRect().width);
  check('reasoning sizes its menu to short level names', effortWidth >= 178 && effortWidth <= 182, `width=${effortWidth}`);
  await page.keyboard.press('ArrowDown');
  check('browsing effort does not change the stored default', await modelDefault.getAttribute('aria-selected') === 'true'
    && await effortPicker.getByRole('option', { name: 'None (none)', exact: true }).evaluate(option => option === document.activeElement));
  await page.keyboard.press('End');
  check('the effort list has keyboard access to its last level', await effortPicker.getByRole('option', { name: 'Ultra (ultra)', exact: true }).evaluate(option => option === document.activeElement));
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await effortPicker.waitFor({ state: 'hidden' });
  check('confirming effort closes its popup, names its parameter and restores focus', (await effortChip.innerText()).trim() === 'High'
    && await effortChip.evaluate(button => button === document.activeElement));
  const chipWeight = await effortChip.evaluate(button => getComputedStyle(button.querySelector('span')).fontWeight);
  check('the composer reasoning label uses regular weight', chipWeight === '400', `weight=${chipWeight}`);
  await effortChip.click();
  await until(async () => effortPicker.getByRole('option', { name: 'High (high)', exact: true }).evaluate(option => option === document.activeElement));
  check('reopening effort starts on the selected level', await effortPicker.getByRole('option', { name: 'High (high)', exact: true }).getAttribute('aria-selected') === 'true');
  const selectedStyle = await effortPicker.getByRole('option', { name: 'High (high)', exact: true }).evaluate(row => ({
    fill: getComputedStyle(row).backgroundColor,
    weight: getComputedStyle(row.querySelector('span')).fontWeight,
  }));
  check('the current effort has a filled row and bold name', selectedStyle.fill !== 'rgba(0, 0, 0, 0)' && Number(selectedStyle.weight) >= 600, JSON.stringify(selectedStyle));
  await effortPicker.getByRole('option', { name: 'Extra high (xhigh)', exact: true }).click();
  await effortPicker.waitFor({ state: 'hidden' });
  check('the composer names extra-high reasoning with its parameter spelling', (await effortChip.innerText()).trim() === 'xHigh');
  await effortChip.click();
  await effortPicker.getByRole('option', { name: 'High (high)', exact: true }).click();
  await effortPicker.waitFor({ state: 'hidden' });
  await effortChip.click();
  await effortPicker.getByRole('option', { name: 'High (high)', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await effortPicker.waitFor({ state: 'hidden' });
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
  check('the message carries the presentation the command asked for, once', request.forwardedProps.present === 'ui' && await page.locator('[data-testid="agent-present"]').count() === 0, JSON.stringify(request.forwardedProps));
  check('agent submits a message with Enter as one AG-UI user message', runs.length === 1 && request.protocolVersion === '1.0' && request.messages.length === 1
    && request.messages[0].role === 'user' && request.messages[0].content === 'Disable this provider', JSON.stringify(runs));
  check('agent sends its target and effort as forwarded props and no consent flag', request.forwardedProps.model === 'vision-alias' && request.forwardedProps.client_key_fingerprint === 'playground-identity'
    && request.forwardedProps.reasoning_effort === 'high' && !JSON.stringify(request).includes('has_consent'), JSON.stringify(request.forwardedProps));
  check('agent declares only the display tools it can draw and the follow-up note, and never supplies state', JSON.stringify(request.tools.map(tool => tool.name).sort()) === JSON.stringify(['render_ui', 'suggest_next'])
    && (request.state === undefined || Object.keys(request.state).length === 0), JSON.stringify(request.tools));
  check('agent tells the server the console language and how it writes token counts', JSON.stringify(request.context) === JSON.stringify([{ description: 'console_language', value: 'en' }, { description: 'console_token_style', value: 'en-compact' }]), JSON.stringify(request.context));
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
  await checkConversationExport({ page, check, kind: 'agent', expectedText: 'The approved operation completed.' });
  await page.reload();
  await page.getByText('The approved operation completed.').waitFor();
  // The model is named where the message is written; the key scopes its list.
  const chip = page.locator('[data-testid="target-chip"]');
  const selection = () => chip.innerText();
  await until(async () => (await selection()).includes('vision-alias'), {
    label: 'the restored composer to name the model',
  });
  check('agent restores server-side history and the chosen target after reload', (await selection()).includes('vision-alias') && await page.getByRole('button', { name: 'Reasoning effort: High', exact: true }).count() === 1, await selection());
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.locator('[data-testid="agent-empty"]').waitFor();
  await chip.click();
  const targets = page.locator('[data-testid="target-popover"]');
  await targets.waitFor();
  const keyName = await targets.getByRole('button', { name: 'Client key Test key' }).innerText();
  check('a new conversation keeps the key, model and effort', (await selection()).includes('vision-alias') && keyName.includes('Test key')
    && await targets.getByRole('option', { name: 'vision-alias', exact: true }).getAttribute('aria-selected') === 'true'
    && await page.getByRole('button', { name: 'Reasoning effort: High', exact: true }).count() === 1, `${await selection()} / ${keyName}`);
  await page.keyboard.press('Escape');
  const preference = await page.evaluate(async () => (await (await fetch('/omc/api/v1/preferences')).json()).preferences);
  check('the chosen target is remembered as the operator\'s own preference', preference?.agent_target?.model === 'vision-alias' && preference?.agent_target?.reasoning_effort === 'high', JSON.stringify(preference?.agent_target));
}

/**
 * An external agent's approval link opens a consent screen outside the console's shell, and the
 * Agent page's side panel tells the operator how such an agent is connected in the first place.
 */
export async function agentExternal({ base, page, check }) {
  const operationID = '0123456789abcdef0123456789abcdef0123456789abcdef';
  let operation = { id: operationID, adapter: 'mcp', capability: 'providers_delete', permission: 'destructive', status: 'pending', expires_at_ms: Date.now() + 9 * 60_000, preview: { target: 'provider-test', changes: { provider: 'provider-test' } }, result: { status: 'pending' } };
  const decisions = [];
  await page.route(`**/agent/operations/${operationID}`, route => route.fulfill({ json: operation }));
  await page.route(`**/agent/operations/${operationID}/decision`, async route => {
    decisions.push(JSON.parse(route.request().postData()));
    operation = { ...operation, status: 'success', result: { status: 'success', invalidates: ['management-providers'] } };
    await route.fulfill({ json: operation });
  });
  await page.goto(`${base}/authorize/${operationID}`, { waitUntil: 'domcontentloaded' });

  const screen = page.getByTestId('agent-authorize-page');
  const card = screen.getByTestId('agent-authorization');
  await card.waitFor();
  const text = await screen.innerText();
  check('the consent screen says who asks, on which deployment, for what, and that it is destructive',
    text.includes('Authorize an external agent') && text.includes(new URL(base).host) && text.includes('Delete a provider')
      && text.includes('provider-test') && await screen.getByText('Destructive', { exact: true }).count() === 1 && text.includes('expires in about 9 min'),
    text);
  check('the consent screen stands outside the console shell', await page.locator('.ant-layout-sider, .app-breadcrumb').count() === 0);
  const buttons = await Promise.all(['Deny', 'Allow'].map(name => card.getByRole('button', { name, exact: true }).boundingBox()));
  check('Deny and Allow are equal targets on one row', Math.abs(buttons[0].width - buttons[1].width) <= 1 && Math.abs(buttons[0].y - buttons[1].y) <= 1, JSON.stringify(buttons));
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  check('the consent screen fits its viewport', geometry.scroll <= geometry.width, JSON.stringify(geometry));
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  const outcome = screen.getByTestId('agent-authorize-outcome');
  await outcome.waitFor();
  check('allowing it records one approval and replaces the decision with the outcome',
    decisions.length === 1 && decisions[0].approve === true && await card.count() === 0 && (await outcome.innerText()).trim() === 'Done',
    JSON.stringify(decisions));

  // A read that fails is not a request that is gone: the screen says so and retries in place.
  const unreadID = 'c'.repeat(48);
  const goneID = 'd'.repeat(48);
  // A flag, not a count: StrictMode's second mount repeats the first read.
  let isUnreadable = true;
  await page.route(`**/agent/operations/${unreadID}`, route => {
    return isUnreadable
      ? fulfillFixture(route, { status: 500, json: { error: 'internal_error' } })
      : route.fulfill({ json: { ...operation, id: unreadID, status: 'pending', result: { status: 'pending' } } });
  });
  await page.goto(`${base}/authorize/${unreadID}`, { waitUntil: 'domcontentloaded' });
  const failure = screen.getByTestId('agent-authorize-failed');
  await failure.waitFor();
  check('a failed read keeps the request heading instead of calling it expired',
    await page.getByRole('heading', { name: 'Authorize an external agent' }).count() === 1);
  isUnreadable = false;
  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  await card.waitFor();
  check('retrying a failed read shows the request', await failure.count() === 0);

  await page.route(`**/agent/operations/${goneID}`, route => fulfillFixture(route, { status: 404, json: { error: 'operation_not_found' } }));
  await page.goto(`${base}/authorize/${goneID}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'This authorization request was not found or has expired' }).waitFor();

  // A mistyped address is answered on the screen, without asking the server about it.
  await page.goto(`${base}/authorize/not-an-operation`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'This authorization request was not found or has expired' }).waitFor();

  await page.getByRole('link', { name: 'Open the console', exact: true }).click();
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const guide = page.getByTestId('agent-connect');
  await guide.waitFor();
  const endpoint = `${new URL(base).origin}${new URL(base).pathname.replace(/\/$/, '')}/api/mcp`;
  check('the guide names this deployment\'s own MCP endpoint', await guide.getByTestId('agent-connect-endpoint').innerText() === endpoint, await guide.getByTestId('agent-connect-endpoint').innerText());
  const snippet = guide.getByTestId('agent-connect-snippet');
  check('the default snippet connects Claude Code by URL without the key in it', (await snippet.innerText()).includes(`--transport http oh-my-cpa ${endpoint}`) && (await snippet.innerText()).includes('$OMCPA_CPA_MANAGEMENT_KEY'), await snippet.innerText());
  const clients = guide.getByRole('radio');
  const tiles = await clients.evaluateAll(elements => elements.map(element => ({ border: getComputedStyle(element).borderTopWidth, hasIcon: [...element.firstElementChild.children].some(mark => mark.getClientRects().length > 0), isClipped: element.scrollWidth > element.clientWidth })));
  check('each client is a bounded tile with its own mark and an unclipped name', tiles.length === 4 && tiles.every(tile => tile.border !== '0px' && tile.hasIcon && !tile.isClipped), JSON.stringify(tiles));
  await guide.getByRole('radio', { name: 'Codex', exact: true }).click();
  await snippet.getByText('bearer_token_env_var').waitFor();
  check('choosing another client swaps the snippet and marks the choice', (await snippet.innerText()).includes(`url = "${endpoint}"`) && await guide.getByRole('radio', { name: 'Codex', exact: true }).getAttribute('aria-checked') === 'true', await snippet.innerText());
  const panel = await guide.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  check('the guide fits its drawer without horizontal overflow', panel.scroll <= panel.width + 1, JSON.stringify(panel));
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
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
  const directory = page.getByTestId('agent-directory');
  const retryDirectory = directory.getByRole('button', { name: 'Retry', exact: true });
  await retryDirectory.waitFor();
  isDirectoryUnavailable = false;
  await retryDirectory.click();
  await directory.getByText('providers_delete', { exact: true }).waitFor();
  check('retrying the capability directory preserves the composer draft',
    await composer.inputValue() === 'Delete a provider' && await directory.locator('.omc-load-failure').count() === 0);
  await page.keyboard.press('Escape');
  await until(async () => await page.locator('[data-testid="agent-directory"]:visible').count() === 0, { label: 'the capability drawer to close' });
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
export async function agentStream({ base, page, check, expectProblem }) {
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

  // Hold a real response stream at each observation boundary, so following is measured while
  // reasoning arrives rather than inferred from a completed transcript.
  await page.evaluate(() => {
    const fetchRequest = window.fetch;
    window.fetch = async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!new URL(url, location.href).pathname.endsWith('/agent/run')) return fetchRequest(input, options);
      const encoder = new TextEncoder();
      const body = new ReadableStream({ start(controller) {
        window.__agentReasoningStream = {
          write(events) { controller.enqueue(encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))); },
          close() { controller.close(); window.fetch = fetchRequest; },
        };
      } });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await page.getByLabel('Describe an OMC query or action').fill('Stream reasoning');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => page.evaluate(() => Boolean(window.__agentReasoningStream)), { label: 'the held reasoning response' });
  const emit = events => page.evaluate(events => window.__agentReasoningStream.write(events), events);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  let thought = 'I will create an inline SVG animation.';
  await emit([started('turn-reasoning'), step(1), { type: 'REASONING_START', messageId: 'run-test:thought' },
    { type: 'REASONING_MESSAGE_START', messageId: 'run-test:thought', role: 'reasoning' },
    { type: 'REASONING_MESSAGE_CONTENT', messageId: 'run-test:thought', delta: thought }]);
  const running = page.getByTestId('agent-running');
  const activity = page.getByTestId('agent-activity');
  const reasoningBody = running.locator('[class*="reasoning-body"]');
  await reasoningBody.getByText(thought, { exact: true }).waitFor();
  await settleLayout(page);
  const shortStyle = await reasoningBody.evaluate(body => {
    const sample = document.createElement('span');
    sample.style.color = 'var(--fg-2)';
    body.append(sample);
    const expectedInk = getComputedStyle(sample).color;
    sample.remove();
    return {
      mask: getComputedStyle(body).maskImage,
      height: body.clientHeight,
      scrollHeight: body.scrollHeight,
      ink: getComputedStyle(body.querySelector('[class*="reasoning-text"]')).color,
      expectedInk,
    };
  });
  check('short reasoning stays fully readable without a history fade', shortStyle.mask === 'none' && shortStyle.scrollHeight === shortStyle.height
    && shortStyle.ink === shortStyle.expectedInk, JSON.stringify(shortStyle));
  check('the Agent names thinking once, on the reasoning being written', await running.getByText('Thinking…', { exact: true }).count() === 1
    && await running.getByRole('button', { name: 'Thinking…', exact: true }).count() === 1 && !(await activity.innerText()).includes('Thinking'));
  check('live activity omits the round counter', !/Round\s+\d/.test(await activity.innerText()), await activity.innerText());
  const disclosureBounds = await running.locator('[class*="reasoning-toggle"]').boundingBox();
  const bodyBounds = await reasoningBody.boundingBox();
  const activityBounds = await activity.boundingBox();
  check('reasoning title, content and activity occupy separate rows', bodyBounds.y >= disclosureBounds.y + disclosureBounds.height
    && activityBounds.y >= bodyBounds.y + bodyBounds.height + 8, JSON.stringify({ disclosureBounds, bodyBounds, activityBounds }));
  const liveLabel = running.locator('[class*="reasoning-toggle"] [class*="live-text"]');
  const sweep = await liveLabel.evaluate(label => {
    const style = getComputedStyle(label);
    return { duration: style.animationDuration, easing: style.animationTimingFunction, clip: style.backgroundClip, mask: style.webkitMaskClip, band: style.backgroundSize.split(',')[0].trim(), width: label.getBoundingClientRect().width };
  });
  check('a live glyph highlight crosses in 900ms at a constant pace', sweep.duration === '0.9s' && sweep.easing === 'linear' && sweep.clip.startsWith('text'), JSON.stringify(sweep));
  // Masking the label to its own glyphs draws each one through its outline and thins the stroke.
  check('the live label\'s glyphs are painted once, by a clipped background and no mask', sweep.mask !== 'text', JSON.stringify(sweep));
  check('the highlight is a glint narrower than its label, not a band as wide as it', parseFloat(sweep.band) > 0 && parseFloat(sweep.band) < sweep.width, JSON.stringify(sweep));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check('reduced motion leaves the live label as plain text', await liveLabel.evaluate(label => getComputedStyle(label).animationName === 'none' && getComputedStyle(label).backgroundImage === 'none'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const appendThought = async delta => {
    thought += delta;
    await emit([{ type: 'REASONING_MESSAGE_CONTENT', messageId: 'run-test:thought', delta }]);
  };
  await appendThought('\n\n' + Array.from({ length: 40 }, (_, index) => `Reasoning line ${index}.`).join('\n\n'));
  await reasoningBody.getByText('Reasoning line 39.', { exact: true }).waitFor();
  const isAtLatest = () => reasoningBody.evaluate(body => body.scrollHeight > body.clientHeight && body.scrollHeight - body.clientHeight - body.scrollTop <= 2);
  await until(isAtLatest, { label: 'reasoning to follow its newest line' });
  check('overflowing reasoning fades only the hidden history edge', await reasoningBody.evaluate(body => getComputedStyle(body).maskImage !== 'none'));
  for (const delta of ['\n\n**The next reasoning paragraph.**', '\n\n| Step | Result |\n| --- | --- |\n| Latest | Ready |\n\nTable complete.']) {
    const previousHeight = await reasoningBody.evaluate(body => body.scrollHeight);
    await appendThought(delta);
    await until(() => reasoningBody.evaluate((body, height) => body.scrollHeight > height, previousHeight), { label: 'incremental Markdown layout to grow' });
    await until(isAtLatest, { label: 'incremental Markdown to remain pinned' });
  }
  // A late layout change without another token must also stay pinned once the body is capped.
  await reasoningBody.evaluate(body => { body.firstElementChild.style.paddingBottom = '72px'; });
  await until(isAtLatest, { label: 'delayed content layout to stay at the tail' });
  check('reasoning follows delayed content layout without another token', await isAtLatest());
  await reasoningBody.evaluate(body => { body.firstElementChild.style.paddingBottom = ''; });
  await until(isAtLatest, { label: 'the content layout to return to its natural height' });
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 850 });
  await settleLayout(page);
  await until(isAtLatest, { label: 'reasoning reflow on a phone to remain pinned' });
  const phoneBounds = await reasoningBody.boundingBox();
  const phoneActivityBounds = await activity.boundingBox();
  check('phone reasoning and activity remain separate and within the column', phoneBounds.x >= 0 && phoneBounds.x + phoneBounds.width <= 375
    && phoneActivityBounds.y >= phoneBounds.y + phoneBounds.height + 8, JSON.stringify({ phoneBounds, phoneActivityBounds }));
  await page.setViewportSize(desktopViewport);
  await settleLayout(page);
  await until(isAtLatest, { label: 'reasoning to follow after widening' });
  const reasoningStyle = await reasoningBody.evaluate(body => {
    const style = getComputedStyle(body);
    return { border: style.borderTopWidth, background: style.backgroundColor, height: body.clientHeight };
  });
  check('streaming reasoning is an unframed bounded reading window', reasoningStyle.border === '0px'
    && reasoningStyle.background === 'rgba(0, 0, 0, 0)' && reasoningStyle.height === 168, JSON.stringify(reasoningStyle));
  // A scroll inside rAF is delivered on the next frame, after this frame's ResizeObserver.
  // A late Markdown layout in that gap must not override the reader's movement toward history.
  await reasoningBody.evaluate(body => new Promise(resolve => requestAnimationFrame(() => {
    body.scrollTop = 0;
    body.firstElementChild.style.paddingBottom = '72px';
    resolve();
  })));
  await until(async () => await reasoningBody.getAttribute('data-following') === null, { label: "reasoning to hold the reader's place during layout growth" });
  check('a layout commit in the scroll frame preserves manual scrollback', await reasoningBody.evaluate(body => body.scrollTop === 0));
  check('reading back removes the history fade', await reasoningBody.evaluate(body => getComputedStyle(body).maskImage === 'none'));
  await reasoningBody.evaluate(body => { body.firstElementChild.style.paddingBottom = ''; });
  thought += '\n\nA new line while reading back.';
  await emit([{ type: 'REASONING_MESSAGE_CONTENT', messageId: 'run-test:thought', delta: '\n\nA new line while reading back.' }]);
  await reasoningBody.getByText('A new line while reading back.', { exact: true }).waitFor();
  await settleLayout(page);
  check('new reasoning does not pull a reader who scrolled up', await reasoningBody.evaluate(body => body.scrollTop === 0));
  await reasoningBody.evaluate(body => { body.scrollTop = body.scrollHeight; });
  await until(async () => await reasoningBody.getAttribute('data-following') === 'true', { label: 'reasoning following to resume' });
  thought += '\n\nThe latest reasoning line.';
  await emit([{ type: 'REASONING_MESSAGE_CONTENT', messageId: 'run-test:thought', delta: '\n\nThe latest reasoning line.' }]);
  await reasoningBody.getByText('The latest reasoning line.', { exact: true }).waitFor();
  await until(isAtLatest, { label: 'resumed reasoning to follow the next line' });
  check('returning to the latest line resumes reasoning following', await isAtLatest());
  await reasoningBody.evaluate(body => { body.scrollTop = 0; });
  await until(async () => await reasoningBody.getAttribute('data-following') === null, { label: 'ordinary scrollback to pause following' });
  const liveDisclosure = running.getByRole('button', { name: 'Thinking…', exact: true });
  await liveDisclosure.click();
  await appendThought('\n\nReasoning received while folded.');
  await liveDisclosure.click();
  await reasoningBody.getByText('Reasoning received while folded.', { exact: true }).waitFor();
  await until(isAtLatest, { label: 'reopening live reasoning to show the latest line' });
  check('reopening live reasoning reconnects its layout observer', await isAtLatest());
  // Reasoning can be the first member of a group that later receives a capability call.
  // Keep both updates observable so the timeline must survive the change in its contents.
  await emit([{ type: 'REASONING_MESSAGE_END', messageId: 'run-test:thought' }, { type: 'REASONING_END', messageId: 'run-test:thought' },
    ...toolCall('reasoning-read', 'providers_list'), toolResult('reasoning-read', { status: 'success', data: { providers: [] } })]);
  await running.getByTestId('agent-chain').waitFor();
  check('a reasoning-only group becomes a capability timeline without remounting the page', await page.getByTestId('agent-page').isVisible());
  const settled = { ...initial(), revision: 3, turns: [{ id: 'turn-reasoning', user: 'Stream reasoning', reply: 'Reasoning complete.',
    parts: [{ type: 'thought', content: thought }, { type: 'tool', trace_id: 'reasoning-read' }, { type: 'text', content: 'Reasoning complete.' }],
    status: 'success', traces: [{ id: 'reasoning-read', name: 'providers_list', arguments: '{}', result: { status: 'success', data: { providers: [] } } }] }] };
  // Close in the same task that enqueues the terminal frames: the consumer cancels its reader
  // on RUN_FINISHED, so a later close would race an already-cancelled stream.
  await page.evaluate(events => {
    window.__agentReasoningStream.write(events);
    window.__agentReasoningStream.close();
  }, [...text('run-test:answer', 'Reasoning complete.'), snapshot(settled), finished()]);
  await page.getByText('Reasoning complete.', { exact: true }).waitFor();
  await until(async () => await page.getByTestId('agent-running').count() === 0, { label: 'the streamed turn to settle' });
  const settledTurn = page.locator('[data-testid="agent-turn"]').last();
  const chainDisclosure = settledTurn.getByTestId('agent-chain').getByRole('button', { name: 'Used 1 capabilities', exact: true });
  await until(async () => await chainDisclosure.getAttribute('aria-expanded') === 'false', { label: 'the settled timeline to fold' });
  await chainDisclosure.click();
  const disclosure = settledTurn.getByRole('button', { name: 'Thought process', exact: true });
  await until(async () => await disclosure.getAttribute('aria-expanded') === 'false', { label: 'completed reasoning to fold' });
  const isCaretExpanded = () => disclosure.evaluate(button => {
    const caret = button.querySelector('[class*="reasoning-caret"]');
    const transform = getComputedStyle(caret).transform;
    return transform !== 'none' && Math.abs(new DOMMatrixReadOnly(transform).b - 1) < 0.01;
  });
  await until(async () => !(await isCaretExpanded()), { label: 'collapsed reasoning to restore its right-facing caret' });
  check('collapsed reasoning has an unrotated caret', !(await isCaretExpanded()));
  await disclosure.click();
  check('completed reasoning can be reopened for reading', await disclosure.getAttribute('aria-expanded') === 'true');
  await until(isCaretExpanded, { label: 'expanded reasoning to rotate its caret' });
  check('expanded reasoning has a downward-facing caret', await isCaretExpanded());

  // Keep one real UI tool call open across observations: a component must appear before its
  // argument string finishes, and its scripts must wait until the validated view replaces it.
  // The nonce-scoped draft reloads when appearance settles; each sandbox load trips
  // Playwright's blocked-service-worker shim (two draft documents and the final component).
  expectProblem({ kind: 'pageerror', message: /(?:Failed to read the 'serviceWorker' property|Service worker is disabled because the context is sandboxed)/, count: 3 });
  await page.evaluate(() => {
    const fetchRequest = window.fetch;
    window.fetch = async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!new URL(url, location.href).pathname.endsWith('/agent/run')) return fetchRequest(input, options);
      const encoder = new TextEncoder();
      const body = new ReadableStream({ start(controller) {
        window.__inlineUIStream = {
          write(events) { controller.enqueue(encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))); },
          close() { controller.close(); window.fetch = fetchRequest; },
        };
      } });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await page.getByLabel('Describe an OMC query or action').fill('Build an inline status component');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => page.evaluate(() => Boolean(window.__inlineUIStream)), { label: 'the held inline UI response' });
  const componentHTML = '<div class="omc-stack"><p id="inline-label">Provider status</p><output id="inline-state">Preparing</output><button id="inline-action" onclick="document.getElementById(\'inline-state\').textContent=\'Selected\'">Select scope</button></div><script>document.getElementById("inline-state").textContent="Ready"</script>';
  const argumentsText = JSON.stringify({ title: 'Inline provider status', html: componentHTML });
  const split = argumentsText.indexOf('</div>');
  const writeUI = events => page.evaluate(events => window.__inlineUIStream.write(events), events);
  await writeUI([started('turn-inline'), step(1), ...text('inline:before', 'Status before the component.'),
    { type: 'TOOL_CALL_START', toolCallId: 'inline-ui', toolCallName: 'render_ui' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'inline-ui', delta: argumentsText.slice(0, split) }]);
  const draft = page.getByTestId('agent-view-draft');
  await draft.waitFor();
  const draftFrame = draft.frameLocator('[data-testid="agent-canvas-draft"]');
  await draftFrame.locator('#inline-state').waitFor();
  check('a new UI streams as a frameless component before its argument string is complete',
    await draft.getAttribute('data-frame') === 'none' && await draftFrame.locator('#inline-label').innerText() === 'Provider status');
  await writeUI([{ type: 'TOOL_CALL_ARGS', toolCallId: 'inline-ui', delta: argumentsText.slice(split) }]);
  await until(async () => await draftFrame.locator('script').count() === 1, { label: 'the component markup to reach its draft frame' });
  check('a streamed component preview does not execute model scripts', await draftFrame.locator('#inline-state').innerText() === 'Preparing');
  expectProblem({ kind: 'console', message: /^Executing inline event handler violates the following Content Security Policy directive/, count: 1 });
  await draftFrame.locator('#inline-action').click();
  check('a streamed component preview does not activate inline event handlers', await draftFrame.locator('#inline-state').innerText() === 'Preparing');
  const view = { kind: 'ui', frame: 'none', title: 'Inline provider status', columns: [], rows: [], html: componentHTML };
  const inlineTurn = { id: 'turn-inline', user: 'Build an inline status component', reply: 'Status before the component. Status after the component.',
    parts: [{ type: 'text', content: 'Status before the component.' }, { type: 'tool', trace_id: 'inline-ui' }, { type: 'text', content: 'Status after the component.' }],
    status: 'success', traces: [{ id: 'inline-ui', name: 'render_ui', arguments: argumentsText, result: { status: 'success', data: { rendered: true } }, view }] };
  await page.evaluate(events => { window.__inlineUIStream.write(events); window.__inlineUIStream.close(); }, [
    { type: 'TOOL_CALL_END', toolCallId: 'inline-ui' }, toolResult('inline-ui', { status: 'success', data: { rendered: true } }, { view }),
    ...text('inline:after', 'Status after the component.'), snapshot({ ...initial(), revision: 4, turns: [inlineTurn] }), finished(),
  ]);
  const finishedComponent = page.getByTestId('agent-view').filter({ hasText: 'Inline provider status' });
  await finishedComponent.frameLocator('[data-testid="agent-canvas"]').locator('#inline-state').getByText('Ready', { exact: true }).waitFor();
  check('the completed component keeps its inline frame and activates scripts only in the sandbox',
    await finishedComponent.getAttribute('data-frame') === 'none' && await finishedComponent.locator('iframe').getAttribute('sandbox') === 'allow-scripts'
      && await page.getByTestId('agent-view-draft').count() === 0);
  const activeComponent = finishedComponent.frameLocator('[data-testid="agent-canvas"]');
  await activeComponent.locator('#inline-action').click();
  check('the completed sandbox activates the component event handler', await activeComponent.locator('#inline-state').innerText() === 'Selected');
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
  if (await chain.getByRole('button').first().getAttribute('aria-expanded') === 'false') await chain.getByRole('button').first().click();
  await page.locator('[data-testid="agent-trace"]').first().waitFor();
  check('a database query stays a call row without a result preview', await page.locator('[data-testid="agent-trace"]').first().getByRole('button').count() === 1 && await page.getByText(privateQueryCell, { exact: false }).count() === 0);
  // scrollWidth counts content past a clipped edge too, so this proves nothing is wider than the
  // column rather than only that the overflow is hidden.
  const transcript = await page.locator('[data-testid="agent-transcript"]').evaluate(box => ({ scroll: box.scrollWidth, client: box.clientWidth }));
  check('a long call digest does not widen the transcript on a phone', transcript.scroll <= transcript.client, JSON.stringify(transcript));
  const composer = await page.locator('[data-testid="agent-page"] form').last().boundingBox();
  check('the Agent composer starts compact on a phone', composer.height <= 90, `height=${composer.height}`);
  // On a phone the model a message will reach stays named in the composer, never behind a sheet.
  const phoneChip = await page.locator('[data-testid="target-chip"]').boundingBox();
  check('Agent keeps its model named in the composer on a phone', !!phoneChip && phoneChip.x >= 0 && phoneChip.x + phoneChip.width <= page.viewportSize().width, JSON.stringify(phoneChip));
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, height: innerHeight, bottom: document.querySelector('[data-testid="agent-page"]').getBoundingClientRect().bottom }));
  check('Agent composer fits a narrow viewport', geometry.scroll <= geometry.width && geometry.bottom <= geometry.height + 1, JSON.stringify(geometry));

  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
  const directory = page.locator('[data-testid="agent-directory"]');
  await directory.waitFor();
  await page.goBack();
  await until(async () => await page.locator('[data-testid="agent-directory"]:visible').count() === 0);
  check('Back dismisses the drawer without navigating', new URL(page.url()).pathname.endsWith('/agent'));
  const queryCall = page.locator('[data-testid="agent-trace"]').first();
  await queryCall.getByRole('button').first().click();
  const details = queryCall.locator('[data-testid="agent-call-panel"]');
  await details.getByText('Arguments', { exact: true }).waitFor();
  check('a call opens its request under its own row, with no drawer', await page.locator('[data-testid="agent-drawer"]:visible').count() === 0
    && await queryCall.getByRole('button').first().getAttribute('aria-expanded') === 'true');
  check('query details omit raw results from an older session', !(await details.innerText()).includes(privateQueryCell));
  const opened = await page.locator('[data-testid="agent-transcript"]').evaluate(box => ({ scroll: box.scrollWidth, client: box.clientWidth }));
  check('an opened call\'s long request does not widen the transcript on a phone', opened.scroll <= opened.client, JSON.stringify(opened));
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
  // A message can be queued during a run, so what it is sent with stays choosable during one.
  check('the model and the reasoning effort stay choosable while a run works', await page.getByTestId('target-chip').isEnabled() && await page.getByTestId('effort-chip').isEnabled());
  check('the composer is cleared once the message is sent', await input.inputValue() === '');
  const bubble = await transcript.locator('[data-role="user"]').last().evaluate(element => element.firstElementChild.getBoundingClientRect().height);
  check('a single-line user message has compact vertical padding', bubble < 50, `height=${bubble}`);
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  check('an empty running composer shows stop without a queue button', await page.getByRole('button', { name: 'Queue', exact: true }).count() === 0);
  await page.mouse.move(0, 0);
  const stopStyle = await page.getByRole('button', { name: 'Stop', exact: true }).evaluate(element => {
    const style = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent-hover)'; element.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return { fill: style.backgroundColor, expected, shadow: style.boxShadow };
  });
  check('Stop takes the primary fill from the theme, without a shadow', stopStyle.fill === stopStyle.expected && stopStyle.shadow === 'none', JSON.stringify(stopStyle));
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

  check('the queue says how many messages wait and when they go', (await page.getByTestId('composer-queue').innerText()).includes('1 queued · sends when this finishes'));
  check('a message sent during a run waits in the queue instead of starting a second run', runs.length === 1 && await page.locator('[data-testid="composer-queue-item"]').getByText('And the day before?').isVisible(), `runs=${runs.length}`);
  releaseResult();
  await page.getByText('Two models failed most.').waitFor();
  await page.getByText('Queued answer.').waitFor();
  check('the queued message goes out once the run settles, as its own run', runs.length === 2 && runs[1].messages[0].content === 'And the day before?' && await page.locator('[data-testid="composer-queue-item"]').count() === 0, JSON.stringify(runs.map(run => run.messages)));
  const turn = page.locator('[data-testid="agent-turn"]').first();
  const chain = turn.locator('[data-testid="agent-chain"]');
  await page.getByText('Two models failed most.').waitFor();
  check('a finished stretch of reasoning folds back behind its answer', await turn.getByRole('button', { name: 'Thought process', exact: true }).evaluateAll(buttons => buttons.every(button => button.getAttribute('aria-expanded') === 'false')));
  if (await chain.getByRole('button').first().getAttribute('aria-expanded') === 'false') await chain.getByRole('button').first().click();
  for (const title of await turn.getByText('Thought process', { exact: true }).all()) await title.click();
  await turn.getByText('One model dominates.').waitFor();
  const content = await turn.innerText();
  const positions = ['Compare failures by model first.', 'Let me read the last hour.', 'Aggregate usage', 'One model dominates.', 'Two models failed most.'].map(fragment => content.indexOf(fragment));
  check('a turn is drawn in the order the model worked', positions.every(position => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]), JSON.stringify(positions));
  check('each stretch of reasoning keeps its own place', await turn.getByText('Thought process', { exact: true }).count() === 2);
  // A call row opens in place: the request, then the receipt the model was given.
  const firstCall = turn.locator('[data-testid="agent-trace"]').first();
  const railX = await chain.locator('[data-step-mark]').evaluateAll(marks => marks.map(mark => Math.round(mark.getBoundingClientRect().left)));
  check('every step of a timeline hangs from one rail', railX.length >= 1 && railX.every(x => x === railX[0]), JSON.stringify(railX));
  await firstCall.getByRole('button').first().click();
  const details = firstCall.locator('[data-testid="agent-call-panel"]');
  await details.getByText('Arguments', { exact: true }).waitFor();
  check('a call opens its arguments and result under its own row', (await details.innerText()).includes('group_by') && (await details.innerText()).includes('failed')
    && (await details.innerText()).includes('usage_aggregate') && await page.locator('[data-testid="agent-drawer"]:visible').count() === 0, await details.innerText());
  await firstCall.getByRole('button').first().click();
  await until(async () => !(await details.isVisible()), { label: 'the call to fold its details away' });
  check('a folded call leaves its request out of reach', await firstCall.getByRole('button').first().getAttribute('aria-expanded') === 'false');
  await verifyAgentRecovery({ base, page, check });
}

/**
 * Display calls draw the rows the server froze on the trace, never the model's text: a table is a
 * table with its own CSV actions, and a chart can be read as the data behind it.
 */
export async function agentViews({ base, page, check, expectProblem }) {
  const rows = [{ model: 'gpt-4.1', requests: 120, tokens: 1204300 }, { model: 'gemini-2.5', requests: 80, tokens: 86400 }];
  // A conversation stored before charts and tables became canvases still holds their views.
  const retiredView = { kind: 'table', title: 'Stored before canvases', columns: ['model', 'requests'], rows, source: { call_id: 'call-usage', path: 'rows' } };
  // The common figures come from the kit the canvas is given, not from hand-written marks.
  const figureView = { kind: 'canvas', title: 'Tokens by model', columns: ['model', 'requests', 'tokens'], rows, source: { call_id: 'call-usage', path: 'rows' },
    html: '<div id="chart"></div><div id="table"></div><script>OMC.chart("#chart",{type:"column",x:"model",y:["tokens"],unit:"tokens"});OMC.table("#table",{columns:[{field:"model",label:"Model"},{field:"tokens",label:"Tokens",unit:"tokens"}]})</script>' };
  const panelView = { kind: 'panel', title: 'Last 24 hours', columns: [], rows: [], blocks: [
    { type: 'stats', items: [{ label: 'Requests', value: '1,204', delta: '+12%', tone: 'success', icon: 'TrendingUp' }, { label: 'Spend', value: '$4.20', icon: 'no-such-icon' }] },
    { type: 'callout', tone: 'warning', text: 'Two credentials are cooling down.' },
    { type: 'steps', items: [{ label: 'Check quota', status: 'done' }, { label: 'Rotate the key', status: 'active', text: 'After the current window' }] },
    { type: 'meters', items: [{ label: 'Daily budget', value: '$8 of $10', share: 0.8, tone: 'warning' }] },
    { type: 'links', items: [{ label: 'Open quota', route: 'quota' }] },
  ] };
  // The canvas tries every way out it has; the checks below are that none of them leaves the page.
  const canvasView = { kind: 'ui', frame: 'none', title: 'Routing sketch', columns: ['model', 'requests'], rows,
    html: '<div id="mark" style="height:300px"><label class="omc-field">Scope<select id="scope"><option value="all">All models</option><option value="first">First model</option></select></label>rows <b id="count"></b><button id="prepare" type="button">Explore last week</button></div><script>document.getElementById("count").textContent=String(OMC_DATA.length);document.getElementById("scope").onchange=function(){document.getElementById("count").textContent=this.value==="first"?"1":String(OMC_DATA.length)};document.getElementById("prepare").onclick=function(){OMC.compose("Compare requests last week")};fetch("/canvas-leak-fetch").catch(function(){});new Image().src="/canvas-leak-image";try{document.getElementById("count").dataset.cookie=String(document.cookie.length)}catch(error){document.getElementById("count").dataset.cookie="denied"}</script>' };
  // A request the policy refuses is still announced before it fails with `csp`; one that failed any
  // other way, or did not fail, got as far as the network.
  const leaks = new Set();
  page.on('request', request => { if (request.url().includes('canvas-leak')) leaks.add(request); });
  page.on('requestfailed', request => { if (request.failure()?.errorText === 'csp') leaks.delete(request); });
  // The sketch is built twice: once on arrival and once when the theme is switched below.
  expectProblem({ kind: 'console', message: /canvas-leak-fetch' violates the following Content Security Policy/, count: 2 });
  expectProblem({ kind: 'console', message: /^Fetch API cannot load .*canvas-leak-fetch/, count: 2 });
  expectProblem({ kind: 'console', message: /canvas-leak-image' violates the following Content Security Policy/, count: 2 });
  expectProblem({ kind: 'requestfailed', url: /canvas-leak-image$/, message: /^csp$/, count: 2 });
  // Playwright's own service-worker block probes `navigator.serviceWorker` in each rebuilt frame,
  // which a frame without an origin refuses: the chart and the sketch, once each.
  expectProblem({ kind: 'pageerror', message: /^Failed to read the 'serviceWorker' property from 'Navigator'/, count: 2 });
  expectProblem({ kind: 'console', message: /^Framing 'http:\/\/127\.0\.0\.1:9\/' violates the following Content Security Policy directive: "frame-src/, count: 1 });
  // The harness blocks service workers by reading the property in every frame, which a frame
  // without an origin refuses; the canvas itself never touches it.
  expectProblem({ kind: 'pageerror', message: /Service worker is disabled because the context is sandboxed/, count: 4 });
  await page.route('**/agent/session', route => route.fulfill({ json: { ...initial(), revision: 2, turns: [{
    id: 'turn-views', user: 'Chart requests by model', reply: 'Here they are.', status: 'success', started_at_ms: Date.now() - 900, ended_at_ms: Date.now(),
    usage: { input_tokens: 5000, output_tokens: 200, total_tokens: 5200, context_tokens: 3200 }, suggestions: ['Compare with last week'],
    parts: [{ type: 'tool', trace_id: 'call-usage' }, { type: 'tool', trace_id: 'call-table' }, { type: 'tool', trace_id: 'call-panel' }, { type: 'text', content: 'Before the figures.' }, { type: 'tool', trace_id: 'call-figure' }, { type: 'text', content: 'Between the figures.' }, { type: 'tool', trace_id: 'call-canvas' }, { type: 'text', content: 'Here they are.' }],
    traces: [
      { id: 'call-usage', name: 'usage_aggregate', arguments: '{}', result: { status: 'success', data: { rows } } },
      { id: 'call-table', name: 'render_table', arguments: '{"title":"Stored before canvases"}', result: { status: 'success', data: { rendered: true, rows: 2 } }, view: retiredView },
      { id: 'call-panel', name: 'render_view', arguments: '{"title":"Last 24 hours"}', result: { status: 'success', data: { rendered: true, blocks: 5 } }, view: panelView },
      { id: 'call-figure', name: 'render_canvas', arguments: '{"title":"Tokens by model"}', result: { status: 'success', data: { rendered: true, rows: 2 } }, view: figureView },
      { id: 'call-canvas', name: 'render_canvas', arguments: '{"title":"Routing sketch"}', result: { status: 'success', data: { rendered: true, rows: 2 } }, view: canvasView },
    ],
  }] } }));
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.getByText('Here they are.').waitFor();
  check('a display call is drawn outside the call chain, where the answer reads', await page.locator('[data-testid="agent-chain"] [data-testid="agent-view"]').count() === 0);
  check('a stored chart or table is no longer drawn, and its call stays in the record',
    await page.locator('[data-testid="agent-view"]').count() === 3 && await page.getByText('Stored before canvases').count() === 0);

  // The kit draws the chart and the table from the frozen rows, in the console's token style.
  const figure = page.locator('[data-testid="agent-view"][data-kind="canvas"]').filter({ hasText: 'Tokens by model' });
  const drawn = figure.frameLocator('[data-testid="agent-canvas"]');
  await drawn.locator('#chart rect').first().waitFor();
  check('a canvas charts its rows with the kit', await drawn.locator('#chart rect').count() === 2 && await drawn.locator('#chart svg text').filter({ hasText: 'gpt-4.1' }).count() === 1);
  const cells = () => drawn.locator('#table tbody td').allInnerTexts();
  check('a canvas table formats tokens the way the console writes them', (await cells()).join('|') === 'gpt-4.1|1.2M|gemini-2.5|86.4K', (await cells()).join('|'));
  await drawn.locator('#table th').filter({ hasText: 'Tokens' }).click();
  check('a canvas table sorts by a column', (await cells())[0] === 'gemini-2.5' && await drawn.locator('#table th[aria-sort="ascending"]').count() === 1);

  // A normal dashboard may exceed the old 1,600px viewport. Its last row belongs to the
  // transcript, not to a nested scrolling viewport that narrows the chart on classic scrollbars.
  const frameGeometry = () => drawn.locator('html').evaluate(root => ({
    contentHeight: root.scrollHeight, viewportHeight: root.clientHeight,
    contentWidth: root.scrollWidth, viewportWidth: root.clientWidth,
  }));
  await drawn.locator('body').evaluate(body => {
    const section = document.createElement('section');
    section.id = 'tall-dashboard';
    section.style.height = '1800px';
    section.textContent = 'Additional comparison rows';
    const footer = document.createElement('p');
    footer.id = 'dashboard-footer';
    footer.textContent = 'Last comparison row';
    body.append(section, footer);
  });
  await until(async () => (await frameGeometry()).viewportHeight > 1800, { label: 'the dashboard frame to grow with its content' });
  const dashboardGeometry = await frameGeometry();
  const footerGeometry = await drawn.locator('#dashboard-footer').evaluate(footer => ({
    bottom: footer.getBoundingClientRect().bottom, viewportHeight: innerHeight,
  }));
  check('an interactive dashboard fits vertically without clipping its last row or adding root scrollbars',
    dashboardGeometry.contentHeight <= dashboardGeometry.viewportHeight + 1
      && dashboardGeometry.contentWidth <= dashboardGeometry.viewportWidth + 1
      && footerGeometry.bottom <= footerGeometry.viewportHeight, JSON.stringify({ dashboardGeometry, footerGeometry }));
  await drawn.locator('body').evaluate(body => {
    body.querySelector('#tall-dashboard').remove();
    body.querySelector('#dashboard-footer').remove();
  });
  await until(async () => (await frameGeometry()).viewportHeight < 1000, { label: 'the dashboard frame to shrink after content is removed' });

  const componentRadii = await drawn.locator('body').evaluate(body => {
    const samples = document.createElement('section');
    samples.innerHTML = '<div class="omc-card"></div><div class="omc-callout"></div><div class="omc-tabs"><button>Scope</button></div><button class="omc-diagram-node">Provider</button>';
    body.append(samples);
    const radii = [...samples.querySelectorAll('.omc-card,.omc-callout,.omc-tabs,.omc-tabs button,.omc-diagram-node')]
      .map(element => getComputedStyle(element).borderRadius);
    samples.remove();
    return radii;
  });
  check('interactive components use the console surface and control corners',
    componentRadii.join('|') === '6px|6px|6px|4px|6px', componentRadii.join('|'));

  const download = page.waitForEvent('download');
  await figure.getByRole('button', { name: 'Save as image', exact: true }).click();
  const saved = await download;
  check('a canvas saves as a picture of itself', /^tokens-by-model-\d{8}-\d{6}\.png$/.test(saved.suggestedFilename()), saved.suggestedFilename());

  await figure.getByRole('button', { name: 'Full screen', exact: true }).click();
  const full = page.getByRole('dialog', { name: 'Tokens by model' });
  await full.frameLocator('[data-testid="agent-canvas"]').locator('#chart rect').first().waitFor();
  const cover = await full.evaluate(element => { const box = element.getBoundingClientRect(); return [box.left, box.top, innerWidth - box.right, innerHeight - box.bottom]; });
  const frameBox = await full.locator('[data-testid="agent-canvas"]').boundingBox();
  check('a full-screen canvas takes the viewport and gives its frame the height', cover.every(edge => edge === 0) && (frameBox?.height ?? 0) > 600, `${cover} ${frameBox?.height}`);
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Tab');
  check('Tab stays inside a full-screen canvas', await full.evaluate(element => element.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  await full.waitFor({ state: 'detached' });
  check('Escape returns a full-screen canvas to its place in the answer', await figure.getByRole('button', { name: 'Full screen', exact: true }).count() === 1);
  await until(async () => await figure.getByRole('button', { name: 'Full screen', exact: true }).evaluate(button => button === document.activeElement), { label: 'focus to return to the inline fullscreen control' });

  const panel = page.locator('[data-testid="agent-view"][data-kind="panel"]');
  await panel.locator('svg[data-icon="trending-up"]').waitFor();
  check('a panel draws each block the model chose', await panel.getByText('1,204').count() === 1 && await panel.getByText('Two credentials are cooling down.').count() === 1
    && await panel.getByRole('img', { name: 'In progress' }).count() === 1 && await panel.getByRole('meter', { name: 'Daily budget' }).getAttribute('aria-valuenow') === '80');
  check('an icon is resolved from any Lucide name, and an unknown one is a neutral mark rather than a failure',
    await panel.locator('svg[data-icon="trending-up"] path').count() >= 1 && await panel.locator('svg[data-icon="neutral"]').count() === 1);
  check('a panel link leads to a console page under the base path', (await panel.getByRole('link', { name: 'Open quota' }).getAttribute('href') ?? '').endsWith('/omc/quota'));
  check('a panel fits its column', await panel.evaluate(element => element.scrollWidth <= element.clientWidth));

  const sketch = page.getByRole('figure', { name: 'Routing sketch', exact: true });
  const canvas = sketch.locator('[data-testid="agent-canvas"]');
  const positions = await page.locator('[data-testid="agent-turn"]').evaluate(turn => {
    const before = [...turn.querySelectorAll('p')].find(paragraph => paragraph.textContent === 'Before the figures.');
    const between = [...turn.querySelectorAll('p')].find(paragraph => paragraph.textContent === 'Between the figures.');
    const after = [...turn.querySelectorAll('p')].find(paragraph => paragraph.textContent === 'Here they are.');
    const figures = turn.querySelectorAll('[data-testid="agent-view"]');
    const comesBefore = (first, second) => Boolean(first?.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    return comesBefore(before, figures[1]) && comesBefore(figures[1], between)
      && comesBefore(between, figures[2]) && comesBefore(figures[2], after);
  });
  check('each figure stays between the text written before and after its call', positions);
  const frameless = await sketch.evaluate(figure => {
    const style = getComputedStyle(figure);
    const title = getComputedStyle(figure.querySelector('[class*="view-title"]'));
    return { border: style.borderTopWidth, background: style.backgroundColor, titleWidth: title.width, name: figure.getAttribute('aria-label') };
  });
  check('a frameless UI has no card ground or title bar and retains its accessible name', frameless.border === '0px'
    && frameless.background === 'rgba(0, 0, 0, 0)' && frameless.titleWidth === '1px' && frameless.name === 'Routing sketch', JSON.stringify(frameless));
  const inner = sketch.frameLocator('[data-testid="agent-canvas"]');
  await inner.locator('#count').waitFor();
  check('a canvas is a script-only sandbox that receives its frozen rows', await canvas.getAttribute('sandbox') === 'allow-scripts' && await inner.locator('#count').innerText() === '2');
  await until(async () => (await canvas.boundingBox())?.height === 300, { label: 'the canvas to take its reported height' });
  check('a canvas frame takes the height its content reports', (await canvas.boundingBox())?.height === 300);
  const UIRequests = [];
  const trackUIRequest = request => { if (new URL(request.url()).pathname.endsWith('/agent/run')) UIRequests.push(request); };
  page.on('request', trackUIRequest);
  await inner.locator('#scope').selectOption('first');
  check('an inline component filters its frozen data locally', await inner.locator('#count').innerText() === '1' && UIRequests.length === 0);
  await inner.locator('#scope').selectOption('all');
  await inner.getByRole('button', { name: 'Explore last week', exact: true }).click();
  const followUp = sketch.getByTestId('agent-ui-draft');
  await followUp.waitFor();
  check('an interactive component offers a reviewed follow-up without starting a run',
    (await followUp.innerText()).includes('Compare requests last week') && UIRequests.length === 0);
  await followUp.getByRole('button', { name: 'Copy to composer', exact: true }).click();
  check('reviewing an inline component copies its draft without executing it',
    await page.getByLabel('Describe an OMC query or action').inputValue() === 'Compare requests last week' && UIRequests.length === 0);
  await page.getByLabel('Describe an OMC query or action').fill('');
  page.off('request', trackUIRequest);

  check('a canvas reads the theme and has no origin of its own', await inner.locator('body').evaluate(body => getComputedStyle(body).getPropertyValue('--accent').trim() !== '' && window.origin === 'null')
    && ['0', 'denied'].includes(await inner.locator('#count').getAttribute('data-cookie') ?? ''));
  // One switch, not several: the frame is rebuilt from the values the page holds after the switch.
  const modeBefore = await page.evaluate(() => document.documentElement.dataset.themeMode);
  // The control cycles three preferences, and one of them may resolve to the mode already shown.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.evaluate(mode => document.documentElement.dataset.themeMode !== mode, modeBefore)) break;
    await page.getByRole('button', { name: /^Theme:/ }).click();
  }
  const pageSurface = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  const frameSurface = () => inner.locator('body').evaluate(body => getComputedStyle(body).getPropertyValue('--bg').trim());
  await until(async () => await frameSurface() === await pageSurface(), { label: 'the canvas to follow one theme switch' });
  check('a canvas follows the theme on the switch that changes it', await frameSurface() === await pageSurface());
  // Self-navigation is the one exit the frame's own policy does not close; the console's frame policy does.
  await inner.locator('body').evaluate(() => { window.location.href = 'http://127.0.0.1:9/canvas-leak-navigation'; }).catch(() => undefined);
  await page.waitForFunction(() => { try { return [...document.querySelectorAll('[data-testid="agent-canvas"]')].at(-1)?.contentDocument === null; } catch { return true; } });
  check('nothing a canvas tries reaches the network', leaks.size === 0, [...leaks].map(request => request.url()).join(' '));
  // Source is one of the figure's icon actions, and the same button brings the canvas back.
  await sketch.getByRole('button', { name: 'View source', exact: true }).click();
  check('a canvas can be read as the markup behind it', await sketch.locator('pre').innerText().then(text => text.includes('canvas-leak-fetch')));
  // Not pressed here: drawing this canvas again would repeat the leak attempts above.
  check('the same action offers the way back to the canvas', await sketch.getByRole('button', { name: 'View rendered UI', exact: true }).count() === 1 && await sketch.locator('.ant-segmented').count() === 0);

  // The fixture's catalog lists a 4,000-token window for the session's model, and the turn's last
  // round read 3,200: the readout is the last round's input, not the turn's summed input.
  const readout = page.locator('[data-testid="context-readout"]');
  check('the composer states the share of the context window in use', await readout.innerText() === '80%' && await readout.getAttribute('data-tone') === 'warning',
    `${await readout.innerText()} ${await readout.getAttribute('data-tone')}`);
  await page.locator('[data-testid="agent-follow-ups"]').getByRole('button', { name: 'Compare with last week' }).click();
  check('a follow-up question fills the composer without sending', await page.getByLabel('Describe an OMC query or action').inputValue() === 'Compare with last week');

}

/**
 * `ask_question` takes the composer's place: the agent's options, a typed answer beside them, and
 * sending the reply continues the run.
 */
export async function agentReplace({ base, page, check }) {
  const answered = (id, user, reply, traces = []) => ({ id, user, reply, parts: [...traces.map(trace => ({ type: 'tool', trace_id: trace.id })), { type: 'text', content: reply }], status: 'success', started_at_ms: Date.now() - 500, ended_at_ms: Date.now(), traces });
  let conversation = { ...initial(), revision: 2, turns: [answered('turn-old', 'Which provder fails most?', 'First answer.', [{ id: 'call-list', name: 'providers_list', arguments: '{}', result: { status: 'success', data: {} } }])] };
  const runs = [];
  await page.route('**/agent/session', route => route.fulfill({ json: conversation }));
  await page.route('**/agent/run', async route => {
    const body = JSON.parse(route.request().postData());
    runs.push(body);
    const reply = runs.length === 1 ? 'Second answer.' : 'Third answer.';
    const turn = answered(`turn-${runs.length}`, body.messages[0].content, reply);
    conversation = { ...conversation, revision: conversation.revision + 1, turns: [turn] };
    await route.fulfill({ contentType: 'text/event-stream', body: sse([started(turn.id), step(1), ...text(`message-${runs.length}`, reply), snapshot(conversation), finished()]) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  const workspace = page.locator('[data-testid="agent-page"]');
  await workspace.getByText('First answer.', { exact: true }).waitFor();

  await workspace.getByRole('button', { name: 'Retry', exact: true }).click();
  await workspace.getByText('Second answer.', { exact: true }).waitFor();
  check('a retry asks the same question in the turn\'s place', runs[0].messages[0].content === 'Which provder fails most?' && runs[0].forwardedProps.replace_turn === 'turn-old', JSON.stringify(runs[0].forwardedProps));
  check('the replaced answer is gone', await workspace.getByText('First answer.', { exact: true }).count() === 0);

  await workspace.getByRole('button', { name: 'Edit and resend', exact: true }).click();
  const composer = workspace.locator('textarea[name="input"]');
  await until(async () => await composer.inputValue() === 'Which provder fails most?', { label: 'the message to return to the composer' });
  check('editing says that sending replaces the message', await page.locator('[data-testid="agent-editing"]').isVisible());
  await composer.fill('Which provider fails most?');
  await page.keyboard.press('Enter');
  await workspace.getByText('Third answer.', { exact: true }).waitFor();
  check('an edit sends the new wording in the turn\'s place', runs[1].messages[0].content === 'Which provider fails most?' && runs[1].forwardedProps.replace_turn === 'turn-1', JSON.stringify(runs[1].forwardedProps));
  check('the editing notice goes once the message is sent', await page.locator('[data-testid="agent-editing"]').count() === 0);

  // A turn that changed something is part of the record: it can be neither retried nor edited.
  conversation = { ...conversation, revision: conversation.revision + 1, turns: [answered('turn-write', 'Disable it', 'Disabled.', [{ id: 'call-write', name: 'providers_set_status', arguments: '{}', result: { status: 'success', data: {} } }])] };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await workspace.getByText('Disabled.', { exact: true }).waitFor();
  check('a turn that made a change offers no retry or edit', await workspace.getByRole('button', { name: 'Retry', exact: true }).count() === 0 && await workspace.getByRole('button', { name: 'Edit and resend', exact: true }).count() === 0);
}

export async function agentAttach({ base, page, check }) {
  let conversation = initial();
  const runs = [];
  await page.route('**/agent/session', route => route.fulfill({ json: conversation }));
  await page.route('**/agent/run', async route => {
    const body = JSON.parse(route.request().postData());
    runs.push(body);
    const content = body.messages[0].content;
    const sentImages = Array.isArray(content) ? content.filter(part => part.type === 'binary') : [];
    const words = Array.isArray(content) ? content.find(part => part.type === 'text')?.text ?? '' : content;
    conversation = { ...conversation, revision: conversation.revision + 1, turns: [{ id: 'turn-file', user: words,
      ...(sentImages.length ? { images: sentImages.map((part, index) => ({ id: `image-${index}`, media_type: part.mimeType, bytes: 68 })) } : {}), reply: 'Two errors.', parts: [{ type: 'text', content: 'Two errors.' }], status: 'success', started_at_ms: Date.now() - 500, ended_at_ms: Date.now(), traces: [] }] };
    await route.fulfill({ contentType: 'text/event-stream', body: sse([started('turn-file'), step(1), ...text('message-file', 'Two errors.'), snapshot(conversation), finished()]) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  const workspace = page.locator('[data-testid="agent-page"]');
  await workspace.locator('[data-testid="agent-empty"]').waitFor();
  // The composer opens the system picker on demand; there is no file input in the page to fill.
  const attach = async file => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), workspace.getByRole('button', { name: 'Attach images or text files', exact: true }).click()]);
    await chooser.setFiles(file);
  };

  // A binary file is refused where it is added, so it can never reach a model as text.
  await attach({ name: 'core.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255, 254, 0]) });
  await page.locator('.omc-toast-warning').waitFor();
  check('a file that is not text is refused', await workspace.getByText('core.bin', { exact: true }).count() === 0);

  await attach({ name: 'gateway.log', mimeType: 'text/plain', buffer: Buffer.from('ERROR upstream timeout\nERROR upstream reset\n') });
  await workspace.getByText('gateway.log', { exact: true }).waitFor();
  const composer = workspace.locator('textarea[name="input"]');
  await composer.fill('How many errors?');
  await page.keyboard.press('Enter');
  await workspace.getByText('Two errors.', { exact: true }).waitFor();
  const sent = runs[0]?.messages[0]?.content ?? '';
  check('the file travels inside the message as a named block', sent.startsWith('How many errors?') && sent.includes('<file name="gateway.log">\nERROR upstream timeout') && sent.trimEnd().endsWith('</file>'), sent);
  const files = workspace.locator('[data-testid="agent-sent-files"]');
  await files.waitFor();
  const bubble = await workspace.locator('[data-role="user"]').first().innerText();
  check('the sent message shows the file by name, not its content', (await files.innerText()).includes('gateway.log') && bubble.includes('How many errors?') && !bubble.includes('upstream timeout'), bubble);

  // Editing shows the words alone; the file stays with the message and goes out again.
  await workspace.getByRole('button', { name: 'Edit and resend', exact: true }).click();
  await until(async () => await composer.inputValue() === 'How many errors?', { label: 'the words to return to the composer' });
  check('an edited message names the file it still carries', (await page.locator('[data-testid="agent-editing"]').innerText()).includes('gateway.log'));
  await composer.fill('How many distinct errors?');
  await page.keyboard.press('Enter');
  await until(() => runs.length === 2, { label: 'the edited message to be sent' });
  const resent = runs[1].messages[0].content;
  check('the edit replaces the turn and keeps its file', runs[1].forwardedProps.replace_turn === 'turn-file' && resent.startsWith('How many distinct errors?') && resent.includes('<file name="gateway.log">'), resent);

  // An image travels beside the message as bytes and comes back as a reference the page reads
  // from the server; it needs no words of its own.
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  let imageReads = 0;
  await page.route('**/agent/images/image-0', route => { imageReads += 1; return route.fulfill({ contentType: 'image/png', body: pixel }); });
  await attach({ name: 'notes.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await page.locator('.omc-toast-warning').last().waitFor();
  await attach({ name: 'chart.png', mimeType: 'image/png', buffer: pixel });
  await workspace.locator('form img[alt="chart.png"]').waitFor();
  check('an attached image is previewed in the composer and an unsupported one is refused', await workspace.locator('form img').count() === 1);
  await workspace.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => runs.length === 3, { label: 'the image to be sent' });
  const parts = runs[2].messages[0].content;
  check('an image alone is a message, sent as bytes beside no text', Array.isArray(parts) && parts.length === 1 && parts[0].type === 'binary' && parts[0].mimeType === 'image/webp'
    && Buffer.from(parts[0].data, 'base64').subarray(0, 4).toString() === 'RIFF'
    && Buffer.from(parts[0].data, 'base64').subarray(8, 12).toString() === 'WEBP'
    && Buffer.from(parts[0].data, 'base64').length <= 512 * 1024, JSON.stringify(parts).slice(0, 200));
  const thumbnails = workspace.locator('[data-testid="agent-sent-images"] img');
  await until(async () => imageReads > 0 && await thumbnails.count() === 1, { label: 'the stored image to be read back' });
  check('the sent image is shown from the conversation\'s own store', (await thumbnails.getAttribute('src')).endsWith('/api/v1/agent/images/image-0'));
}

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
  // The server's clock runs ahead of the browser's, as a deployment's may: its stamps are in the
  // browser's future, and the `Date` header is the reading that brings them back.
  const SERVER_AHEAD_MS = 90_000;
  const serverNow = () => Date.now() + SERVER_AHEAD_MS;
  await page.route('**/agent/session', route => route.fulfill({ json: conversation, headers: { date: new Date(serverNow()).toUTCString() } }));
  await page.route('**/agent/runs/*/cancel', route => { cancelCount++; return route.fulfill({ json: { is_cancelled: true } }); });
  await page.route('**/agent/run', route => {
    generationCount++;
    runID = route.request().headers()['x-omc-run-id'];
    conversation = { ...initial(), active_run_id: runID, revision: 2, turns: [{ id: 'recover-turn', user: 'Recover this run', reply: '', status: 'running', traces: [], started_at_ms: serverNow() - 4000 }] };
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
  check('the message box stays writable while a rejoined run works', await page.getByLabel('Describe an OMC query or action').isEnabled());
  check('Agent refresh reattaches without sending Stop or starting another model call', generationCount === 1 && cancelCount === 0, JSON.stringify({ generationCount, cancelCount, subscriptionCount }));
  const elapsed = page.locator('[data-testid="agent-activity"] [data-live-elapsed]');
  await elapsed.waitFor();
  const recovered = await elapsed.innerText();
  check('a rejoined run counts from when it started, on the browser\'s clock', /^\d+\.\ds$/.test(recovered) && parseFloat(recovered) >= 3 && parseFloat(recovered) < 60, recovered);
  await until(async () => parseFloat(await elapsed.innerText()) > parseFloat(recovered), { label: 'the rejoined run\'s timer to keep counting' });
  release();
  await page.getByText('Recovered complete.', { exact: true }).waitFor();
  check('Agent replay replaces partial text and restores one complete answer', await page.getByText('Recovered complete.', { exact: true }).count() === 1 && await page.getByText('Partial answer', { exact: true }).count() === 0 && generationCount === 1);
}
