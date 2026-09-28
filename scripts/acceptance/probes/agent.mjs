import { until } from '../harness.mjs';
import { playgroundFixtures } from './playground.mjs';

const initial = () => ({ id: 'agent-test-session', revision: 1, model: 'vision-alias', client_key_fingerprint: 'playground-identity', turns: [], omitted: 0 });
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
const frame = event => `data: ${JSON.stringify(event)}\n\n`;

export async function agentWorkspace({ base, page, check }) {
  let conversation = initial();
  let operation = { id: 'operation-test', capability: 'providers_delete', status: 'pending', preview: { target: 'provider-test', challenge: 'provider-test', changes: { provider: 'provider-test' } }, result: { status: 'pending' } };
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
    conversation = { ...conversation, revision: conversation.revision + 1, turns: [{ id: 'turn-test', user: 'Disable this provider', reply: isFirst ? '' : 'The approved operation completed.', status: isFirst ? 'pending' : 'success', started_at_ms: Date.now() - 1200, ended_at_ms: Date.now(), traces: [{ id: 'tool-test', name: 'providers_delete', result: isFirst ? { status: 'pending', operation_id: operation.id } : { status: 'success', data: { is_updated: true } } }] }] };
    await route.fulfill({ contentType: 'text/event-stream', body: frame({ type: 'state', conversation }) });
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
  await directory.getByLabel('Filter by name or description').fill('');

  // The empty state teaches the request shapes this deployment can answer.
  check('agent empty state offers example prompts', await page.getByText('Try one of these').count() === 1);
  // Sending needs no separate grant: the composer states where a message and the data the agent
  // reads will go, and sending is the act it describes.
  check('agent states where its data goes beside the composer', await page.getByText('Messages and the OMC data the agent reads are sent to the selected CPA model and its upstream. Do not enter secrets in chat.').isVisible());
  check('agent has no consent checkbox to tick before sending', await page.getByRole('checkbox').count() === 0);

  await page.getByRole('button', { name: 'Reasoning effort: Default', exact: true }).click();
  await page.getByRole('menuitem', { name: 'High (high)' }).click();
  await page.getByLabel('Describe an OMC query or action').fill('Disable this provider');
  check('agent can send as soon as a message is typed', await page.getByRole('button', { name: 'Send', exact: true }).isEnabled());
  // Enter is the composer's primary submit. It is asserted rather than the button, because the two
  // are separate paths through the chat component and only the button used to work.
  await page.getByLabel('Describe an OMC query or action').press('Enter');
  await page.getByLabel('Enter target identifier to confirm').waitFor();
  check('agent submits a message with Enter', runs.length === 1 && runs[0].message === 'Disable this provider', JSON.stringify(runs));
  check('agent sends the chosen reasoning effort and no consent flag', runs[0].reasoning_effort === 'high' && !('has_consent' in runs[0]), JSON.stringify(runs[0]));
  check('agent cannot submit destructive approval without target challenge', await page.getByRole('button', { name: 'Approve execution' }).isDisabled());
  await page.getByLabel('Enter target identifier to confirm').fill('provider-test');
  // The approval gate opens only once the typed identifier has committed, and a click that
  // lands first is swallowed rather than reported. Wait for the affordance the click depends on.
  await until(async () => await page.getByRole('button', { name: 'Approve execution' }).isEnabled(), {
    label: 'the approval gate to open for the typed target identifier',
  });
  await page.getByRole('button', { name: 'Approve execution' }).click();
  await until(() => decisions.length === 1, { label: 'the approval decision reach the server' });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByText('The approved operation completed.').waitFor();
  check('agent resumes server conversation instead of supplying tool history', runs.length === 2 && runs[1].message === '' && !('messages' in runs[1]) && !('tools' in runs[1]));
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

export async function agentFailureCopy({ base, page, check }) {
  await page.route('**/agent/run', route => route.fulfill({ contentType: 'text/event-stream', body: frame({ type: 'error', content: 'operation_outcome_unknown' }) }));
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.getByLabel('Describe an OMC query or action').fill('Delete a provider');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // A failure states what happened and what to do, and keeps the machine code beneath it for a
  // support conversation rather than making the code the message.
  await page.getByText('The operation may have taken effect but its outcome is unconfirmed. Inspect the target resource before retrying.').waitFor();
  check('agent reports a failure as a sentence with the code beneath it', await page.getByText('operation_outcome_unknown').count() >= 1);
}

/**
 * A streamed answer must arrive in a bounded number of paints.
 *
 * This is the property the run loop's coalescing exists for, and it is the one that regresses
 * silently: dispatching every frame straight into React state still renders the same answer, just
 * two hundred times, and nothing in a screenshot can tell the difference. The probe counts the
 * mutations the running bubble actually receives while a 200-frame answer streams in.
 */
export async function agentStream({ base, page, check }) {
  const answer = Array.from({ length: 200 }, (_, index) => `token${index}`).join(' ');
  await page.route('**/agent/run', route => {
    const body = Array.from({ length: 200 }, (_, index) => frame({ type: 'delta', content: `token${index} ` })).join('')
      + frame({ type: 'state', conversation: {
        id: 'agent-test-session',
        revision: 2,
        model: 'vision-alias',
        client_key_fingerprint: 'playground-identity',
        omitted: 0,
        turns: [{ id: 'turn-stream', user: 'Stream', reply: answer, status: 'success', traces: [], started_at_ms: Date.now() - 500, ended_at_ms: Date.now() }],
      } });
    return route.fulfill({ contentType: 'text/event-stream', body });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  await page.evaluate(() => {
    const target = { count: 0 };
    Object.defineProperty(window, '__agentUpdates', { value: target, configurable: true });
    // Observed from the page rather than from the running bubble, because that bubble is one of
    // the things the run creates: an observer attached to it can only ever see the frames that
    // arrive after it exists. Records are filtered to the bubble's subtree instead, which counts
    // the chat's own transient renders out.
    const isInsideRunningBubble = node => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return Boolean(element?.closest?.('[data-testid="agent-running"]'));
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (isInsideRunningBubble(record.target)) target.count += 1;
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
}

export async function agentNarrow({ base, page, check }) {
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  // On a phone the target stays in the head rather than behind a settings sheet: which model a
  // message will reach is never one tap away.
  check('Agent keeps its key and model selectors visible on a phone', await page.getByLabel('Model', { exact: true }).isVisible() && await page.getByLabel('Client key', { exact: true }).isVisible());
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, height: innerHeight, bottom: document.querySelector('[data-testid="agent-page"]').getBoundingClientRect().bottom }));
  check('Agent composer fits a narrow viewport', geometry.scroll <= geometry.width && geometry.bottom <= geometry.height + 1, JSON.stringify(geometry));

  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
  const directory = page.locator('[data-testid="agent-directory"]');
  await directory.waitFor();
  await page.goBack();
  await until(async () => await page.locator('[data-testid="agent-directory"]:visible').count() === 0);
  check('Back dismisses the capability directory without navigating', new URL(page.url()).pathname.endsWith('/agent'));
}

/**
 * The operator's message is in the transcript the moment it is sent, not when the run ends, and a
 * turn is drawn in the order the model worked - reasoning, a remark, a capability call, more
 * reasoning, the answer - rather than in fixed slots for reasoning, calls and answer.
 */
export async function agentLive({ base, page, check }) {
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const trace = { id: 'call-usage', name: 'usage_aggregate', result: { status: 'success', data: { window: '1h', failed: 6 } } };
  const parts = [
    { type: 'thought', content: 'Compare failures by model first.' },
    { type: 'text', content: 'Let me read the last hour.' },
    { type: 'tool', trace_id: trace.id },
    { type: 'thought', content: 'One model dominates.' },
    { type: 'text', content: 'Two models failed most.' },
  ];
  await page.route('**/agent/run', async route => {
    await released;
    await route.fulfill({ contentType: 'text/event-stream', body:
      frame({ type: 'thought', content: parts[0].content, round: 1 })
      + frame({ type: 'delta', content: parts[1].content, round: 1 })
      + frame({ type: 'tool', trace })
      + frame({ type: 'thought', content: parts[3].content, round: 2 })
      + frame({ type: 'delta', content: parts[4].content, round: 2 })
      + frame({ type: 'state', conversation: {
        id: 'agent-test-session',
        revision: 2,
        model: 'vision-alias',
        client_key_fingerprint: 'playground-identity',
        omitted: 0,
        turns: [{ id: 'turn-live', user: 'Which models failed?', reply: 'Let me read the last hour.\n\nTwo models failed most.', parts, status: 'success', traces: [trace], started_at_ms: Date.now() - 900, ended_at_ms: Date.now() }],
      } }) });
  });
  await page.goto(`${base}/agent`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="agent-page"]').waitFor();
  const input = page.getByLabel('Describe an OMC query or action');
  await input.fill('Which models failed?');
  await input.press('Enter');
  const transcript = page.locator('.ant-bubble-list');
  await transcript.getByText('Which models failed?', { exact: true }).waitFor({ timeout: 2000 });
  check('the sent message appears before the run answers', await transcript.getByText('Which models failed?', { exact: true }).isVisible() && await page.locator('[data-testid="agent-activity"]').isVisible());
  check('the composer is cleared once the message is sent', await input.inputValue() === '');
  release();
  await page.getByText('Two models failed most.').waitFor();
  const turn = page.locator('[data-testid="agent-turn"]').last();
  for (const title of await turn.getByText('Thought process', { exact: true }).all()) await title.click();
  await turn.getByText('One model dominates.').waitFor();
  const text = await turn.innerText();
  const positions = ['Compare failures by model first.', 'Let me read the last hour.', 'usage_aggregate', 'One model dominates.', 'Two models failed most.'].map(fragment => text.indexOf(fragment));
  check('a turn is drawn in the order the model worked', positions.every(position => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]), JSON.stringify(positions));
  check('each stretch of reasoning keeps its own place', await turn.getByText('Thought process', { exact: true }).count() === 2);
}
