import { until } from '../harness.mjs';

/**
 * The dashboard's live routing panel: the models called in the last minute, the
 * credentials that answered them, and a request stored while the reader watches
 * travelling out to its credential and back.
 *
 * Only a browser can establish that the lanes land on the rows they join (they
 * are drawn from measured anchors, not from the layout's intent), that a new
 * request sends a packet out and a response back while an old one never does,
 * that a model arrives as a row and leaves when its minute is up, and that a
 * phone is not given the panel at all. The live stream is served as a short
 * SSE body that ends at once, so the browser reconnects every second and each
 * `ready` re-reads - the same path a stored record takes in production. The
 * model behind it is pinned in `scripts/test-usage-routing.ts`.
 */

function record(id, at, fields) {
  return {
    id,
    timestamp_ms: at - 900,
    provider: 'codex',
    model: 'gpt-5-codex',
    failed: false,
    latency_ms: 900,
    api_group_key: 'fp-ci',
    api_group_label: 'api_key',
    api_key_mask: 'sk-…ci01',
    user_agent: 'codex_cli_rs/0.47.0',
    auth_index: 'auth-codex-02',
    auth_type: 'apikey',
    provider_key_mask: 'sk-…c002',
    request_id: `req-${id}`,
    tokens: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    ...fields,
  };
}

/**
 * A routing endpoint that honours `after` and gains a request each time the probe
 * calls `arrive()`. `advance()` moves the server's clock forward, which is how
 * the probe lets a minute pass without waiting one.
 */
export function routingFixtures() {
  let reads = 0;
  let skew = 0;
  let nextId = 10;
  let records;
  // Seeded on the first read rather than when the scenario list is built, which
  // can be minutes before this scenario runs: the minute is the browser's.
  const seed = () => {
    if (records) return records;
    const start = Date.now();
    records = [
      record(1, start - 35_000, { user_agent: 'claude-cli/2.0.14', provider: 'claude', auth_index: 'auth-claude-01', provider_key_mask: 'sk-…cl01', model: 'claude-sonnet-5-5' }),
      record(2, start - 30_000),
      record(3, start - 27_000, { request_id: 'req-reroute', failed: true, fail_status_code: 429, auth_index: 'auth-codex-01', provider_key_mask: 'sk-…c001' }),
      record(4, start - 25_000, { request_id: 'req-reroute' }),
    ];
    return records;
  };
  const respond = (url) => {
    seed();
    reads += 1;
    const after = Number(url.searchParams.get('after') || 0);
    const now = Date.now() + skew;
    return {
      as_of_ms: now,
      window_ms: 60_000,
      records: records.filter((entry) => entry.id > after && entry.timestamp_ms + entry.latency_ms >= now - 60_000).sort((left, right) => right.id - left.id),
      has_more: false,
      cooldowns: [{ auth_index: 'auth-codex-01', provider: 'codex', status_code: 429, quota_exceeded: false, until_at_ms: now + 45_000 }],
    };
  };
  return {
    reads: () => reads,
    /**
     * A request for `model`, refused by one credential and answered by the next, finished `ageMs`
     * ago - a request that ran while the page was away is older than the read that brings it.
     */
    arrive(model, { ageMs = 0 } = {}) {
      const now = Date.now() + skew - ageMs;
      const requestId = `req-live-${nextId}`;
      seed().push(
        record(nextId++, now - 600, { model, request_id: requestId, failed: true, fail_status_code: 429, auth_index: 'auth-codex-01', provider_key_mask: 'sk-…c001', latency_ms: 300 }),
        record(nextId++, now, { model, request_id: requestId }),
      );
    },
    advance(ms) {
      skew += ms;
    },
    routes: [
      [(url) => url.pathname.endsWith('/usage/routing'), respond],
      [(url) => url.pathname.endsWith('/usage/live'), () => ({ contentType: 'text/event-stream', body: 'retry: 1000\nevent: ready\ndata: {}\n\n' })],
      [(url) => url.pathname.endsWith('/management/config'), () => ({ scalars: { routing_strategy: 'round-robin' } })],
    ],
  };
}

export async function routingMap({ base, page, check, fixtures }) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  const panel = page.locator('[data-testid="dashboard-routing"]');
  const map = panel.locator('[data-testid="routing-map"]');
  const packets = map.locator('[data-testid="routing-packets"] > span');
  const modelRow = (name) => map.locator('[data-testid="routing-model"]', { hasText: name });
  await map.waitFor({ timeout: 20_000 });
  await until(async () => (await map.locator('[data-testid="routing-model"]').count()) === 2, { label: 'the models of the minute' });

  const text = await panel.innerText();
  check('the left column names the models called', text.includes('claude-sonnet-5-5') && text.includes('gpt-5-codex'), text);
  check('the left column carries no caller or client', !/codex_cli_rs|claude-cli|Claude Code/.test(text), text);
  check('the gateway names the routing strategy CPA is configured with', /轮询|Round Robin/i.test(await panel.locator('[data-testid="routing-gateway"]').innerText()));
  check('a credential CPA reported resting says when it is back', /back in \d+ s|\d+ 秒后恢复/.test(text), text);
  check('the panel offers no window of its own: it is live only', (await panel.locator('.ant-segmented').count()) === 0);

  // Two models into the gateway, and one lane out of it to each of the three credentials.
  await until(async () => (await map.locator('[data-testid="routing-lane"]').count()) === 5, { label: 'one lane per model and per credential' });
  const landsOnRows = await page.evaluate(() => {
    const mapNode = document.querySelector('[data-testid="routing-map"]');
    const box = mapNode.getBoundingClientRect();
    const ends = [...mapNode.querySelectorAll('[data-testid="routing-lane"] > path:first-child')]
      .map((path) => path.getPointAtLength(path.getTotalLength()));
    const rows = [...mapNode.querySelectorAll('[data-route-target], [data-testid="routing-gateway"]')].map((row) => row.getBoundingClientRect());
    return ends.length === 5 && ends.every((end) => rows.some((rect) => Math.abs(rect.left - box.left - end.x) <= 1 && end.y >= rect.top - box.top && end.y <= rect.bottom - box.top));
  });
  check('every lane ends on the row it joins', landsOnRows);

  // Several live re-reads run with nothing new: none of them replays history.
  const before = fixtures.reads();
  await until(() => fixtures.reads() >= before + 2, { label: 'two live re-reads' });
  check('re-reading the same minute replays nothing', (await packets.count()) === 0);

  // A request for a model not yet on the panel is stored: its row enters and the request travels.
  fixtures.arrive('glm-5-air');
  await until(async () => (await modelRow('glm-5-air').count()) === 1, { label: 'the new model entering' });
  const isTravelling = await until(async () => (await packets.count()) > 0, { label: 'a request packet', timeoutMs: 5_000 })
    .then(() => true, () => false);
  check('a request stored while the dashboard is open travels the map', isTravelling);
  const isFlowing = await until(
    () => map.locator('[data-testid="routing-lane"] > path:nth-child(2)')
      .evaluateAll((flows) => flows.some((flow) => getComputedStyle(flow).animationName !== 'none' && Number(getComputedStyle(flow).opacity) > 0)),
    { label: 'a lane flowing under the request', timeoutMs: 3_000 },
  ).then(() => true, () => false);
  check('the lane a request travels flows while it is on it', isFlowing);
  const isAnswered = await until(
    () => packets.evaluateAll((holders) => holders.some((holder) => holder.firstElementChild?.style.getPropertyValue('--packet-color').includes('--success'))),
    { label: 'the response travelling back', timeoutMs: 8_000 },
  ).then(() => true, () => false);
  check('the answering credential sends a response back to the model', isAnswered);
  await until(async () => (await packets.count()) === 0, { label: 'the packets to finish', timeoutMs: 8_000 });
  check('the gateway counts the arrival\'s two attempts', /\b6 attempts\b/.test(await panel.locator('[data-testid="routing-gateway"]').innerText()));

  // Away from the page. A hidden page runs no animation frames, so a trip left running there would
  // finish every hop it missed in a frame each on return; and a request stored while nobody looked
  // is not "now". The visibility is emulated - a headless page is never really hidden - which is
  // exactly the signal the panel and the player act on.
  const setVisibility = (state) => page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  fixtures.arrive('deepseek-v4');
  await until(async () => (await packets.count()) > 0, { label: 'a request travelling before the page hides', timeoutMs: 5_000 });
  await setVisibility('hidden');
  check('hiding the page ends every trip on the map', (await packets.count()) === 0);
  // The live stream closes while the page is hidden, so the request stored meanwhile arrives with
  // the read the reopened stream asks for on return - a read that starts after the reader is back.
  fixtures.arrive('qwen-4-max', { ageMs: 5_000 });
  await setVisibility('visible');
  await until(async () => (await modelRow('qwen-4-max').count()) === 1, { label: 'the request stored while away' });
  const readsAfterReturn = fixtures.reads();
  await until(() => fixtures.reads() >= readsAfterReturn + 2, { label: 'two re-reads after the return' });
  check('a request stored while the page was hidden is counted but not replayed on return', (await packets.count()) === 0);

  // The minute passes for the opening requests but not for the new one: their rows leave.
  // The exit lasts one presence beat, so the page records it rather than the probe polling for it.
  await page.evaluate(() => {
    const mapNode = document.querySelector('[data-testid="routing-map"]');
    window.__routingExits = [];
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const row = mutation.target;
        if (row.dataset?.phase === 'exiting') window.__routingExits.push(row.textContent);
      }
    }).observe(mapNode, { subtree: true, attributes: true, attributeFilter: ['data-phase'] });
  });
  fixtures.advance(40_000);
  await until(async () => (await modelRow('claude-sonnet-5-5').count()) === 0, { label: 'the expired model removed' });
  const exits = await page.evaluate(() => window.__routingExits);
  check('a model whose last request turned a minute old animates out before it goes', exits.some((text) => text.includes('claude-sonnet-5-5')), JSON.stringify(exits));
  check('the model that is still inside the minute stays', (await modelRow('glm-5-air').count()) === 1);

  // Under reduced motion a new request updates the readings and draws no packet.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  fixtures.arrive('kimi-k3');
  await until(async () => (await modelRow('kimi-k3').count()) === 1, { label: 'the next read' });
  check('reduced motion draws no packet', (await packets.count()) === 0);
}

export async function routingNarrow({ base, page, check }) {
  // A phone mounts no panel, so it must open neither the routing read nor the live stream:
  // hiding a mounted panel would still hold a connection the reader never sees.
  const reads = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/usage/routing') || pathname.endsWith('/usage/live')) reads.push(pathname);
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  // The model panels render in the same pass as the routing panel's place, so once they are
  // on the page the routing panel would be too.
  await page.locator('.model-trend-card').waitFor({ timeout: 20_000 });
  check('a phone dashboard shows no routing panel', (await page.locator('[data-testid="dashboard-routing"]').count()) === 0);
  check('a phone dashboard opens neither the routing read nor its live stream', reads.length === 0, JSON.stringify(reads));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('the dashboard fits the phone without sideways scroll', overflow <= 0, String(overflow));
}
