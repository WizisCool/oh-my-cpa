import { until } from '../harness.mjs';

export function playgroundFixtures() {
  return [
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
  let cancelled = false;
  const external = [];
  context.on('request', request => { if (request.url().startsWith('http') && new URL(request.url()).origin !== new URL(base).origin) external.push(request.url()); });
  await page.route('**/playground/chat', async route => {
    calls.push(JSON.parse(route.request().postData()));
    if (mode === 'wait') {
      // A cancellable pending fetch exercises the Sender and unmount cleanup;
      // the Go tests separately assert cancellation reaches the upstream socket.
      await new Promise(resolve => setTimeout(resolve, 1200));
      try { await route.fulfill({ contentType: 'text/event-stream', body: frame('delta', { content: 'too late' }) }); } catch { cancelled = true; }
      return;
    }
    const answer = mode === 'error' ? 'Partial response' : 'A streamed answer\n\n' + 'Additional detail line.\n\n'.repeat(10) + '![tracking](https://tracking.invalid/x.png)\n<img src="https://tracking.invalid/html.png" onerror="window.__playgroundInjected=1">';
    await route.fulfill({ contentType: 'text/event-stream', body:
      frame('meta', { model: 'vision-alias', started_at_ms: Date.now() }) + frame('delta', { content: answer }) +
      (mode === 'error' ? frame('error', { code: 'upstream_rejected', upstream_status: 400 }) :
        frame('usage', { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) + frame('done', { finish_reason: 'stop', first_content_ms: 42, duration_ms: 90 })) });
  });
  await page.goto(`${base}/playground`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="playground-page"]').waitFor();
  const input = page.getByPlaceholder('Enter a message, or paste an image…');
  await page.getByLabel('Model', { exact: true }).click();
  await page.locator('.ant-select-item-option:visible', { hasText: 'vision-alias' }).click();
  check('playground has no attach-image button', await page.getByRole('button', { name: 'Attach images', exact: true }).count() === 0);
  await input.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'test.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, imageBytes.toString('base64'));
  await page.getByAltText('test.png').waitFor();
  // Exactly one attachment from one paste. Both `onPaste` and `onPasteFile` used to be
  // wired, and the dual-handler path added the same image twice; asserting only that the
  // first image existed let that through.
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
  await page.getByLabel('Custom request body (JSON)', { exact: true }).fill('');
  // `submit` returns silently while any clause of its send gate is false - including the custom
  // body the check above just made invalid - so acting before the gate reopens sends nothing and
  // leaves the transcript empty. Wait on the affordance the action depends on.
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await until(async () => await send.isEnabled(), { label: 'the composer to accept a corrected custom body' });
  await input.press('Enter');
  // Assert the action had an effect before waiting on anything downstream. A press the composer
  // refuses is silent, and without this the only symptom is a rendering wait ten seconds later
  // that says nothing about which step failed - which is how this scenario's own CI failure had
  // to be diagnosed from a screenshot. The refusal is rare (unreproduced in 64 local attempts,
  // including under a one-CPU constraint) and the path predates this change; what is fixed here
  // is that it now reports itself at the step that broke.
  await until(() => calls.length === 1, { label: 'the first turn to reach the upstream', timeoutMs: 5000 });
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
  check('playground turn footer renders metrics and tps', await page.locator('.ant-bubble-list .anticon-thunderbolt').count() > 0 && await page.locator('.ant-bubble-list .anticon-field-time').count() > 0);
  // The displayed rate is the shared formula's, not a second one computed for this footer:
  // the fixture streams 8 output tokens over 90ms with a 42ms first token, a 48ms residual
  // below the 50ms floor, so the rate must be the end-to-end fallback 8*1000/90 = 88.89 t/s
  // rather than the 8*1000/48 = 166.67 t/s a residual-window division would give. This asserts
  // formula parity with the request records; it is not a claim about any particular reported
  // rate, which depends on that call's own timings.
  check('the footer tps matches the shared request-record formula', (await page.locator('[data-testid="playground-page"]').innerText()).includes('88.89 t/s'), 'expected the shared formula\'s rate, not a residual-window division');
  check('model output does not fetch external images or execute HTML', external.length === 0 && !await page.evaluate(() => window.__playgroundInjected), external.join(','));
  await page.getByLabel('System prompt', { exact: true }).fill('Changed system prompt');
  await page.getByRole('tab', { name: 'Turn diagnostics', exact: true }).click();
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  check('request diagnostics preserve the original snapshot and omit image bytes', (await page.locator('aside pre').innerText()).includes('Original system prompt') && (await page.locator('aside pre').innerText()).includes('"reasoning_effort": "medium"') && !(await page.locator('aside pre').innerText()).includes('iVBOR'), 'snapshot and image redaction');
  const codeBg = await page.locator('aside pre').evaluate(el => getComputedStyle(el).backgroundColor);
  check('code highlighter background does not use hardcoded one-light', !codeBg.includes('250, 250') && codeBg !== 'rgb(250, 250, 250)');
  mode = 'error'; await input.fill('Next question'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Partial response', { exact: true }).waitFor();
  await until(async () => await page.getByRole('button', { name: 'Retry', exact: true }).isEnabled(), {
    label: 'the retry affordance after a partial response',
  });
  check('multi-turn request contains the completed assistant answer', calls[1].messages.length === 3 && calls[1].messages[1].role === 'assistant', JSON.stringify(calls[1].messages));
  mode = 'success'; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await until(() => calls.length === 3, { label: 'the retry to reach the upstream' });
  check('retry reuses the same request instead of appending a partial answer', JSON.stringify(calls[2]) === JSON.stringify(calls[1]), 'request snapshot equality');
  await until(async () => await page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), {
    label: 'the composer to accept a new conversation',
  });

  // The transcript scrolls in reverse (the library anchors the newest message natively), so the
  // newest message is at scrollTop 0 and the oldest at -(scrollHeight - clientHeight).
  const scrollBox = page.locator('.ant-bubble-list-scroll-box');
  const distanceFromLatest = () => scrollBox.evaluate(el => Math.abs(el.scrollTop));
  await scrollBox.evaluate(el => { el.scrollTop = -el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await until(async () => await page.getByRole('button', { name: 'Back to latest', exact: true }).isVisible(), {
    label: 'the back-to-latest control after scrolling away',
  });
  check('scrolling away from the newest message displays back to latest button', await page.getByRole('button', { name: 'Back to latest', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await until(async () => await distanceFromLatest() < 48, { label: 'the transcript to return to the newest message' });
  check('back to latest button returns to the newest message', await distanceFromLatest() < 48);

  mode = 'wait'; await input.fill('Please wait'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  check('running turn hides footer metrics until completion', await page.locator('.ant-bubble-list .anticon-thunderbolt').count() === 2);
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
}
