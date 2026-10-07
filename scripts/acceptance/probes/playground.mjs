import { abortFixture } from '../browser-guard.mjs';
import { until } from '../harness.mjs';

export function playgroundFixtures() {
  return [
    [(url, method) => method === 'GET' && url.pathname.endsWith('/usage/ingest-status'), () => ({ enabled:true, healthy:true, collector:{mode:'http_pull',captured:0,coverage_gaps:0},stats:{pending:0} })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/usage/facets'), () => ({window:{from:0,to:Date.now(),bucket_ms:60_000}, facets:[]})],
    [url => url.pathname.endsWith('/runs/active'), () => ({ run: null })],
    [url => url.pathname.endsWith('/management/api-keys'), () => ({ keys: [{ index: 0, key: 'fixture…mask', usage_fingerprint: 'playground-identity', alias: 'Test key', alias_version: 1, length: 20, fingerprint: 'legacy-identity' }], total: 1 })],
    [url => url.pathname.endsWith('/playground/models'), () => ({ models: [{ id: 'vision-alias', call_point: 'vision-alias', vision: 'unknown' }, { id: 'text-only', call_point: 'text-only', vision: 'unknown' }] })],
  ];
}
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const frame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

export async function playground({ base, page, check, context }) {
  // Plain-HTTP deployments do not expose crypto.randomUUID; make the acceptance
  // path exercise the same fallback a non-secure-context browser uses.
  await page.addInitScript(() => {
    try { Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true }); } catch { /* leave the native API when it is not configurable */ }
  });
  const calls = [];
  let mode = 'success';
  let hasMeasurableTiming = false;
  let cancelled = false;
  let releaseCancelled;
  const cancelledRequest = new Promise(resolve => { releaseCancelled = resolve; });
  await page.route('**/playground/runs/*/cancel', async route => { cancelled = true; releaseCancelled(); await route.fulfill({ json: { is_cancelled: true } }); });
  const external = [];
  context.on('request', request => { if (request.url().startsWith('http') && new URL(request.url()).origin !== new URL(base).origin) external.push(request.url()); });
  await page.route('**/playground/chat', async route => {
    const { recovery_turn, ...request } = JSON.parse(route.request().postData());
    calls.push(request);
    if (mode === 'wait') {
      // Hold the task until the explicit server cancellation arrives; a subscriber
      // disconnect on its own is not an upstream cancellation.
      await cancelledRequest;
      try { await route.fulfill({ contentType: 'text/event-stream', body: frame('error', { code: 'cancelled' }) }); } catch { cancelled = true; }
      return;
    }
    const answer = mode === 'error' ? 'Partial response' : 'A streamed answer\n\n' + 'Additional detail line.\n\n'.repeat(10) + '![tracking](https://tracking.invalid/x.png)\n<img src="https://tracking.invalid/html.png" onerror="window.__playgroundInjected=1">';
    await route.fulfill({ contentType: 'text/event-stream', body:
      frame('meta', { model: 'vision-alias', started_at_ms: Date.now() }) +
      (mode === 'error' ? '' : frame('request', { request_id: '0000002a' })) + frame('delta', { content: answer }) +
      (mode === 'error' ? frame('error', { code: 'upstream_rejected', upstream_status: 400 }) :
        frame('usage', { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) + frame('done', { finish_reason: 'stop', first_content_ms: hasMeasurableTiming ? 1000 : 42, duration_ms: hasMeasurableTiming ? 2000 : 90 })) });
  });
  await page.goto(`${base}/playground`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="playground-page"]').waitFor();
  const input = page.getByPlaceholder('Enter a message, or paste an image…');
  await page.getByLabel('Model', { exact: true }).click();
  await page.locator('.ant-select-item-option:visible', { hasText: 'vision-alias' }).click();
  check('playground offers one image picker beside paste', await page.getByRole('button', { name: 'Add image', exact: true }).count() === 1);
  await input.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'test.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, imageBytes.toString('base64'));
  await page.getByAltText('test.png').waitFor();
  // Exactly one attachment from one paste: a second paste handler beside the composer's own would
  // add the same image twice, and asserting only that the first image existed would let that through.
  check('one pasted image produces exactly one attachment', await page.getByAltText('test.png').count() === 1, `attachments=${await page.getByAltText('test.png').count()}`);
  await page.getByLabel('System prompt', { exact: true }).fill('Original system prompt');
  await page.getByLabel('Reasoning effort', { exact: true }).click();
  await page.locator('.ant-select-item-option:visible', { hasText: 'Medium (medium)' }).click();
  await page.getByLabel('User-Agent', { exact: true }).fill('AcmeClient/9.9');
  // A custom body that is not one JSON object is reported beside the field and blocks the send,
  // rather than being discovered after the message has left the composer.
  await page.getByLabel('Custom request body (JSON)', { exact: true }).fill('[1, 2]');
  await input.fill('Inspect this image');
  check('an invalid custom body is flagged in place and blocks sending', await page.getByText('Custom body must be a valid JSON object').isVisible() && await page.getByRole('button', { name: 'Send', exact: true }).isDisabled());
  // Correcting the body and pressing Enter happen in one task, so the keypress lands in the same
  // commit that reopens the send gate and before any later render. A composer that decides Enter
  // from its own copy of the send state, updated by an effect one render after the button, refuses
  // a key arriving inside that window in silence; doing both in one task hits the window every
  // time, so the check fails on that design rather than on the runner's speed.
  await page.evaluate(() => {
    const body = document.getElementById('playground-custom-body');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(body, '');
    body.dispatchEvent(new Event('input', { bubbles: true }));
    const composer = document.querySelector('textarea[aria-label="Enter a message, or paste an image…"]');
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  });
  await until(() => calls.length === 1, { label: 'Enter pressed as the send gate reopens to reach the upstream', timeoutMs: 5000 });
  await until(async () => await page.getByText('Complete', { exact: true }).count() > 0, {
    label: 'the first streamed turn to complete',
  });
  check('playground sends exactly one request under StrictMode', calls.length === 1, `calls=${calls.length}`);
  check('playground sends the selected call point, reasoning effort, only a fingerprint and an inline image', calls[0].model === 'vision-alias' && calls[0].reasoning_effort === 'medium' && calls[0].client_key_fingerprint === 'playground-identity' && calls[0].messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'), JSON.stringify(calls[0]).slice(0, 200));
  // The User-Agent parameter is a transport header, so it travels as its own field and
  // must not also appear inside the chat payload the gateway receives.
  check('the operator-set user-agent is forwarded as its own field, not in the payload', calls[0].user_agent === 'AcmeClient/9.9' && JSON.stringify(calls[0].messages).includes('AcmeClient/9.9') === false, `user_agent=${JSON.stringify(calls[0].user_agent)}`);
  // One attachment must also mean one image on the wire; the duplicate used to reach here.
  check('one pasted image is sent as exactly one image part', (() => {
    const parts = calls[0].messages[0].content.filter(part => part.type === 'image_url');
    return parts.length === 1 && parts[0].image_url.url.startsWith('data:image/png;base64,');
  })(), JSON.stringify(calls[0].messages[0].content.map(p => p.type)));
  check('playground renders the streamed answer and measured timing', await page.getByText('A streamed answer').count() > 0 && (await page.locator('[data-testid="playground-page"]').innerText()).includes('42'), 'expected content and first-content timing');
  const transcript = page.locator('[data-testid="playground-transcript"]');
  check('playground turn footer renders metrics and tps', await transcript.locator('.anticon-thunderbolt').count() > 0 && await transcript.locator('.anticon-field-time').count() > 0);
  // The displayed rate is the shared formula's, not a second one computed for this footer:
  // the fixture streams 8 output tokens over 90ms with a 42ms first token, a 48ms residual
  // below the 50ms floor, so the rate must be the end-to-end fallback 8*1000/90 = 88.89 t/s
  // rather than the 8*1000/48 = 166.67 t/s a residual-window division would give. This asserts
  // formula parity with the request records; it is not a claim about any particular reported
  // rate, which depends on that call's own timings.
  check('the footer tps matches the shared request-record formula', (await page.locator('[data-testid="playground-page"]').innerText()).includes('88.89 t/s'), 'expected the shared formula\'s rate, not a residual-window division');
  const viewRequest = answer => answer.getByRole('button', { name: 'View in request records', exact: true });
  check('a turn CPA named links to its request record', await viewRequest(page.locator('[data-testid="playground-answer"]').first()).isEnabled());
  check('model output does not fetch external images or execute HTML', external.length === 0 && !await page.evaluate(() => window.__playgroundInjected), external.join(','));
  await page.getByLabel('System prompt', { exact: true }).fill('Changed system prompt');
  await page.getByRole('tab', { name: 'Turn diagnostics', exact: true }).click();
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  check('request diagnostics preserve the original snapshot and omit image bytes', (await page.locator('aside pre').innerText()).includes('Original system prompt') && (await page.locator('aside pre').innerText()).includes('"reasoning_effort": "medium"') && !(await page.locator('aside pre').innerText()).includes('iVBOR'), 'snapshot and image redaction');
  const codeBg = await page.locator('aside pre').evaluate(el => getComputedStyle(el).backgroundColor);
  check('code highlighter background does not use hardcoded one-light', !codeBg.includes('250, 250') && codeBg !== 'rgb(250, 250, 250)');
  // The send button carries the same guarantee as Enter: typing into an empty composer reopens the
  // gate, and a click in that same task must send rather than meet a stale copy of it.
  mode = 'error';
  await page.evaluate(() => {
    const composer = document.querySelector('textarea[aria-label="Enter a message, or paste an image…"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, 'Next question');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[aria-label="Send"]').click();
  });
  await until(() => calls.length === 2, { label: 'a click as the send gate reopens to reach the upstream', timeoutMs: 5000 });
  await page.getByText('Partial response', { exact: true }).waitFor();
  const regenerate = page.getByRole('button', { name: 'Regenerate', exact: true });
  await until(async () => await regenerate.isEnabled(), {
    label: 'the regenerate affordance after a partial response',
  });
  check('a turn CPA never named offers no request link', await viewRequest(page.locator('[data-testid="playground-answer"]').last()).isDisabled());
  check('multi-turn request contains the completed assistant answer', calls[1].messages.length === 3 && calls[1].messages[1].role === 'assistant', JSON.stringify(calls[1].messages));
  hasMeasurableTiming = true;
  mode = 'success'; await regenerate.click();
  await until(() => calls.length === 3, { label: 'the regenerate to reach the upstream' });
  check('regenerating reuses the same request instead of appending a partial answer', JSON.stringify(calls[2]) === JSON.stringify(calls[1]), 'request snapshot equality');
  await until(async () => (await transcript.innerText()).includes('8.00 t/s'), { label: 'the measurable TPS result' });
  // Match this request's observed output and timing exactly, independently of unrelated list fixtures.
  await page.route('**/api/**/usage/events?*', route => route.fulfill({ json: {
    items: [{ id: 1, event_key: 'tps-fixture', request_id: '0000002a', timestamp_ms: Date.now(),
      provider: 'openai', model: 'vision-alias', failed: false, generate: true, stream: true,
      latency_ms: 2000, ttft_ms: 1000, tokens: { input: 12, output: 8, total: 20, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
      source: 'hmac:tps-fixture', auth_index: 'credential-fixture', api_group_key: 'hmac:tps-fixture', executor_type: 'openai' }],
    has_more: false, limit: 50,
  } }));
  for (const [label, expected] of [['Include first-token latency', '4.00 t/s'], ['Exclude first-token latency', '8.00 t/s']]) {
    await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
    const tpsRow = page.locator('.settings-toggle-row').filter({ hasText: 'TPS calculation mode' });
    const write = page.waitForResponse(response => response.url().endsWith('/preferences/omc_tps_calculation_mode') && response.request().method() === 'PUT');
    await tpsRow.locator('.ant-segmented-item').filter({ hasText: label }).click();
    await write;
    await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
    await until(async () => (await page.locator('.req-tps-val').first().innerText()) === expected, { label: 'the request record TPS mode' });
    check(`request records honor ${label}`, (await page.locator('.req-tps-val').first().innerText()) === expected);
    await page.goto(`${base}/playground`, { waitUntil: 'domcontentloaded' });
    await until(async () => (await transcript.innerText()).includes(expected), { label: 'the restored Playground TPS mode' });
    check(`historical Playground answers honor ${label} without inference`, (await transcript.innerText()).includes(expected) && calls.length === 3);
  }

  await until(async () => await page.getByRole('button', { name: 'Edit and resend', exact: true }).isEnabled(), { label: 'the last message to become editable' });
  // Editing the last message asks the same request again with different words: the edited text
  // replaces the question and its answer rather than adding a turn.
  const answersBeforeEdit = await page.locator('[data-testid="playground-answer"]').count();
  await page.getByRole('button', { name: 'Edit and resend', exact: true }).click();
  const editor = page.getByLabel('Edit and resend', { exact: true }).and(page.locator('textarea'));
  await editor.fill('Next question, reworded');
  await page.getByRole('button', { name: 'Resend', exact: true }).click();
  await until(() => calls.length === 4, { label: 'the edited message to reach the upstream' });
  check('an edited last message replaces its turn and carries the new text', calls[3].messages.length === calls[2].messages.length
    && JSON.stringify(calls[3].messages.at(-1)).includes('Next question, reworded')
    && JSON.stringify(calls[3].messages.slice(0, -1)) === JSON.stringify(calls[2].messages.slice(0, -1)), JSON.stringify(calls[3].messages).slice(0, 300));
  await page.getByText('Next question, reworded', { exact: true }).waitFor();
  check('the edit leaves one answer in the reworded turn\'s place', await page.locator('[data-testid="playground-answer"]').count() === answersBeforeEdit, `answers=${await page.locator('[data-testid="playground-answer"]').count()}`);
  await until(async () => await page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), {
    label: 'the composer to accept a new conversation',
  });

  const distanceFromLatest = () => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await transcript.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await until(async () => await page.getByRole('button', { name: 'Back to latest', exact: true }).isVisible(), {
    label: 'the back-to-latest control after scrolling away',
  });
  check('scrolling away from the newest message displays back to latest button', await page.getByRole('button', { name: 'Back to latest', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await until(async () => await distanceFromLatest() < 48, { label: 'the transcript to return to the newest message' });
  check('back to latest button returns to the newest message', await distanceFromLatest() < 48);

  mode = 'wait'; await input.fill('Please wait'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  const runningAnswer = page.locator('[data-testid="playground-answer"]').last();
  check('running turn hides footer metrics until completion', await runningAnswer.locator('.anticon-thunderbolt, .anticon-field-time').count() === 0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const lastAnswer = page.locator('[data-testid="playground-answer"]').last();
  await lastAnswer.getByText('Stopped', { exact: true }).waitFor();
  check('stop preserves an explicit cancelled state', await lastAnswer.getByText('Stopped', { exact: true }).count() === 1, String(cancelled));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => await page.getByText('A streamed answer').count() > 0, {
    label: 'the persisted conversation after a reload',
  });
  check('refresh restores latest session including conversation across devices', await page.getByText('A streamed answer').count() > 0, 'persisted conversation');
  await until(async () => await distanceFromLatest() < 48, { label: 'the reloaded transcript to settle on the newest message' });
  check('conversation opens on the newest message after reload', await distanceFromLatest() < 48);
  await until(async () => (await page.locator('[data-testid="playground-page"]').innerText()).includes('vision-alias'), {
    label: 'the reloaded transcript to name its model',
  });
  const preference = await page.evaluate(async () => {
    const response = await fetch('/omc/api/v1/preferences');
    return (await response.json()).preferences;
  });
  check('the session persists through reload as one preference', preference?.playground_session?.model === 'vision-alias' && !('playground_selection' in (preference ?? {})), JSON.stringify(preference));
  const stored = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
  // The id survives the reload and is the whole filter: the list opens on that one request.
  await viewRequest(page.locator('[data-testid="playground-answer"]').first()).click();
  await until(() => new URL(page.url()).pathname.endsWith('/usage/events'), { label: 'the request link to open the request records' });
  const requestLink = new URL(page.url()).searchParams;
  check('the request link filters by the turn\'s request id', requestLink.get('request_id') === '0000002a' && !requestLink.has('api_key') && !requestLink.has('model') && !requestLink.has('ua'), page.url());
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="playground-page"]').waitFor();
  check('conversation and prompt were not persisted in browser storage', !stored.includes('Original system prompt') && !stored.includes('Inspect this image'), 'browser storage inspected');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.locator('[data-testid="playground-empty"]').waitFor();
  check('new conversation clears messages and discards stored turns', await page.getByText('A streamed answer').count() === 0, 'empty conversation');
  const head = await page.locator('[data-testid="playground-page"] header').innerText();
  check('new conversation keeps the key and model', head.includes('Test key') && head.includes('vision-alias'), head);
  await until(async () => (await page.evaluate(async () => (await (await fetch('/omc/api/v1/preferences')).json()).preferences))?.playground_session?.turns?.length === 0, {
    label: 'the stored session to drop its turns',
  });
  const storedSession = (await page.evaluate(async () => (await (await fetch('/omc/api/v1/preferences')).json()).preferences)).playground_session;
  check('the stored session keeps its target after a new conversation', storedSession.model === 'vision-alias' && storedSession.client_key_fingerprint === 'playground-identity', JSON.stringify(storedSession));
  await verifyPlaygroundRecovery({ base, page, check });
}

export async function playgroundNarrow({ base, page, check }) {
  await page.goto(`${base}/playground`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="playground-page"]').waitFor();
  await page.getByRole('button', { name: 'Parameters', exact: true }).click();
  await page.locator('.ant-drawer-section').waitFor();
  await page.goBack();
  await until(async () => await page.locator('.ant-drawer-section:visible').count() === 0, {
    label: 'Back to close the settings drawer',
  });
  check('Back closes playground settings without leaving the page', new URL(page.url()).pathname.endsWith('/playground'), page.url());
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollHeight, height: innerHeight,
    page: document.querySelector('[data-testid="playground-page"]').getBoundingClientRect().bottom }));
  check('playground fits a 320px phone and keeps its composer inside the viewport', geometry.scroll <= geometry.width && geometry.page <= geometry.height + 1, JSON.stringify(geometry));
  // One line with send beside it: on a phone the keyboard takes half the screen, and a two-line box
  // with a separate send row left the conversation a strip between them.
  // The placeholder alone may wrap at 320px, and autosize measures it, so the height bound allows
  // two lines; the claim that matters is that no separate send row exists.
  const composer = await page.evaluate(() => {
    const frame = [...document.querySelectorAll('[data-testid="playground-page"] form')].at(-1);
    const input = frame.querySelector('textarea');
    const send = frame.querySelector('button[aria-label="Send"]');
    const inputBox = input.getBoundingClientRect();
    const sendBox = send.getBoundingClientRect();
    const isSendInline = sendBox.top < inputBox.bottom && sendBox.bottom > inputBox.top;
    return { height: frame.getBoundingClientRect().height, hasFootRow: frame.childElementCount > 1 && !isSendInline, isSendInline };
  });
  check('the playground composer has send beside the input and no separate row on a phone', !composer.hasFootRow && composer.isSendInline && composer.height <= 72, JSON.stringify(composer));
}


async function verifyPlaygroundRecovery({ base, page, check }) {
  let generationCount = 0;
  let subscriptions = 0;
  let cancelCount = 0;
  let active = null;
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  await page.route('**/playground/runs/active', route => route.fulfill({ json: { run: active } }));
  await page.route('**/playground/runs/*/cancel', route => { cancelCount++; return route.fulfill({ json: { is_cancelled: true } }); });
  await page.route('**/playground/chat', route => {
    generationCount++;
    const request = JSON.parse(route.request().postData());
    const id = route.request().headers()['x-omc-run-id'];
    const startedAt = Date.now();
    active = { id, started_at_ms: startedAt, is_running: true, request: { id, request, keyLabel: 'Test key', user: request.messages.at(-1), reply: '', status: 'running', startedAt, events: [], eventBytes: 0, isTruncated: false } };
    return route.fulfill({ contentType: 'text/event-stream', body: frame('meta', { started_at_ms: startedAt }) + frame('delta', { content: 'Partial recovery answer' }) });
  });
  await page.route('**/playground/runs/*', async route => {
    if (route.request().method() === 'POST') { cancelCount++; await route.fulfill({ json: { is_cancelled: true } }); return; }
    if (route.request().url().endsWith('/active')) { await route.fulfill({ json: { run: active } }); return; }
    subscriptions++;
    if (subscriptions === 1) { await abortFixture(route, 'internetdisconnected'); return; }
    await completion;
    active = { ...active, is_running: false };
    try { await route.fulfill({ contentType: 'text/event-stream', body: frame('meta', { started_at_ms: active.started_at_ms }) + frame('delta', { content: 'Recovered playground answer' }) + frame('done', { duration_ms: 1200, finish_reason: 'stop' }) }); } catch { /* The old subscriber was closed by reload. */ }
  });
  await page.getByPlaceholder('Enter a message, or paste an image…').fill('Recover playground');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => subscriptions >= 2, { label: 'Playground to reconnect after a socket error' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await until(() => subscriptions >= 3, { label: 'Playground refresh to subscribe to the same task' });
  check('Playground reload keeps one generation and does not cancel it', generationCount === 1 && cancelCount === 0, JSON.stringify({ generationCount, subscriptions, cancelCount }));
  release();
  await page.getByText('Recovered playground answer', { exact: true }).waitFor();
  check('Playground replay restores a complete answer without duplicated partial text', await page.getByText('Recovered playground answer', { exact: true }).count() === 1 && await page.getByText('Partial recovery answer', { exact: true }).count() === 0);
  await until(async () => (await page.evaluate(async () => (await (await fetch('/omc/api/v1/preferences')).json()).preferences)).playground_session?.last_run_id === active.id, { label: 'recovered final result to be persisted' });
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.locator('[data-testid="playground-empty"]').waitFor();
  await until(async () => (await page.evaluate(async () => (await (await fetch('/omc/api/v1/preferences')).json()).preferences)).playground_session?.turns?.length === 0, { label: 'new conversation to persist' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  check('a retained completed journal cannot resurrect a cleared conversation', await page.getByText('Recovered playground answer', { exact: true }).count() === 0 && generationCount === 1);
}
