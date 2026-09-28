import { until } from '../harness.mjs';

/**
 * The price book and the in-place price editor.
 *
 * The claims under test are the ones the feature exists for: a model with no price can be priced
 * from its row in one click, from the editor in any of its three modes, and from the request
 * list without leaving it; a channel multiplier saves from its row. Each write is asserted on the
 * payload the console sent, since the mock answers whatever it is given.
 */

const upstream = (id, prompt, completion, extra = {}) => ({
  id,
  canonical_slug: id,
  name: id,
  author: id.replace(/^~/, '').split('/')[0],
  context_length: 400_000,
  prompt_price_per_1m: prompt,
  completion_price_per_1m: completion,
  cache_read_price_per_1m: prompt / 10,
  cache_write_price_per_1m: prompt * 1.25,
  tiers: [],
  ...extra,
});

const SOL = upstream('openai/gpt-6-sol', 2, 10, {
  tiers: [{ min_prompt_tokens: 272_000, prompt_price_per_1m: 4, completion_price_per_1m: 15 }],
});
const MINI = upstream('openai/gpt-5.4-mini', 0.75, 4.5);
const OPUS = upstream('anthropic/claude-opus-5.5', 4, 20);

const usage = (requests, cost) => ({ requests, priced_requests: cost == null ? 0 : requests, cost_usd: cost });

function book() {
  const now = Date.now();
  return {
    source: 'openrouter',
    providers: [
      { id: 'openai-compat-0', family: 'openai-compatibility', name: 'Team Relay', channel: 'openai-compatible-relay', priority: 20, is_oauth: false, icon_id: 'DeepSeek', models: ['gpt-6-sol', 'claude-sonnet-4-5-20250929'] },
      { id: 'oauth:codex', family: 'codex', name: 'Codex Team', channel: 'codex', priority: 5, is_oauth: true, icon_id: 'Codex', models: ['gpt-5.4-mini-high', ...Array.from({ length: 45 }, (_, index) => `unpriced-model-${String(index).padStart(2, '0')}`)] },
    ],
    models: [
      {
        model: 'gpt-6-sol', prompt_price_per_1m: 2, completion_price_per_1m: 10, cache_read_price_per_1m: 0.2, cache_write_price_per_1m: 2.5,
        price_multiplier: 1, tiers: SOL.tiers, source: 'openrouter', upstream_id: SOL.id, match_kind: 'exact', mode: 'auto',
        synced_at_ms: now - 3_600_000, updated_at_ms: now - 3_600_000, usage_30d: usage(120, 14.2),
      },
      {
        model: 'claude-sonnet-4-5-20250929', prompt_price_per_1m: 3, completion_price_per_1m: 15, cache_read_price_per_1m: 0.3, cache_write_price_per_1m: 3.75,
        price_multiplier: 1.2, tiers: [], source: 'manual', upstream_id: '', match_kind: '', mode: 'custom',
        synced_at_ms: 0, updated_at_ms: now - 7_200_000, usage_30d: usage(40, 3.1),
      },
    ],
    unpriced: [{ model: 'gpt-5.4-mini-high', usage_30d: usage(12, null), suggestions: [MINI] },
      ...Array.from({ length: 45 }, (_, index) => ({ model: `unpriced-model-${String(index).padStart(2, '0')}`, usage_30d: usage(0, null), suggestions: [] })),
    ],
    channels: [
      { channel: 'codex', multiplier: 1, note: '', updated_at_ms: 0, is_configured: false, usage_30d: usage(120, 14.2) },
      { channel: 'openai-compatible-relay', multiplier: 0.5, note: 'half price', updated_at_ms: now - 60_000, is_configured: true, usage_30d: usage(40, 3.1) },
    ],
    upstream_count: 3,
    sync: {
      known: true,
      running: false,
      state: {
        source: 'openrouter', last_error: '', last_matched: 2, last_unmatched: 1,
        last_success_at_ms: now - 3_600_000, updated_at_ms: now - 3_600_000, auto_sync_interval_hours: 24, next_sync_at_ms: now + 82_800_000,
      },
    },
  };
}

function modelDetail(model) {
  const current = book().models.find((row) => row.model === model) ?? null;
  return {
    model,
    price: current,
    automatic: model === 'gpt-6-sol' ? { model: SOL, match_kind: 'exact' } : null,
    suggestions: model === 'gpt-5.4-mini-high' ? [MINI] : [],
    versions: current ? [{ id: 1, available: true, effective_from_ms: current.updated_at_ms, price: current }] : [],
    profile: { samples: 30, input: 18_000, output: 2_000, cache_read: 9_000, cache_write: 1_000, max_input: 300_000 },
  };
}

/** The pricing routes, recording every write the console sends. */
export function pricingFixtures(writes) {
  const body = (request) => JSON.parse(request.postData() ?? '{}');
  return [
    [(url) => url.pathname.endsWith('/pricing/attention'), () => ({ unpriced: ['gpt-5.4-mini-high'] })],
    [(url) => url.pathname.endsWith('/pricing/catalog'), () => ({ models: [SOL, MINI, OPUS, ...Array.from({ length: 65 }, (_, index) => upstream(`test/catalog-model-${String(index).padStart(2, '0')}`, 1, 2))] })],
    [(url) => /\/pricing\/models\/[^/]+$/.test(url.pathname), (url, method, request) => {
      const model = decodeURIComponent(url.pathname.split('/').at(-1));
      if (method === 'PUT') {
        writes.push({ kind: 'model', model, body: body(request) });
        return { price: { ...modelDetail(model).price, model } };
      }
      if (method === 'DELETE') {
        writes.push({ kind: 'model-delete', model });
        return { deleted: true };
      }
      return modelDetail(model);
    }],
    [(url) => /\/pricing\/channels\/[^/]+$/.test(url.pathname), (url, method, request) => {
      const channel = decodeURIComponent(url.pathname.split('/').at(-1));
      writes.push({ kind: method === 'DELETE' ? 'channel-delete' : 'channel', channel, body: method === 'DELETE' ? null : body(request) });
      return method === 'DELETE' ? { deleted: true } : { channel: { channel, ...body(request) } };
    }],
    [(url) => url.pathname.endsWith('/pricing'), () => book()],
  ];
}

async function isTrue(probe, label) {
  return until(probe, { label }).then(() => true).catch(() => false);
}

export async function pricingBook({ base, page, check, writes }) {
  await page.goto(`${base}/pricing`, { waitUntil: 'domcontentloaded' });
  const list = page.locator('[data-testid="pricing-model-list"]');
  const editRows = list.locator('[data-testid="pricing-row-edit"]');
  check('large books render at most twenty rows', await isTrue(async () => (await editRows.count()) === 20, 'bounded rows'));
  check('provider priority leads the book', (await list.locator('[data-testid="pricing-provider-group"]').first().getAttribute('aria-label')) === 'Team Relay');
  check('model names sort naturally within providers', (await editRows.first().getAttribute('aria-label')).includes('claude-sonnet'));
  check('provider aliases and OAuth identity render', (await list.getByRole('heading', { name: 'Codex Team' }).count()) === 1);
  check('the price book is directly below the header', await list.evaluate((element) => element.getBoundingClientRect().top < 300));
  check('navigation has no inventory marker', (await page.locator('.app-menu-pip').count()) === 0);
  check('model rows do not load brand images', (await list.locator('.ant-table-body img, .ant-table-tbody img').count()) === 0);
  const pagination = list.locator('[data-testid="pricing-pagination"]');
  check('one integrated footer owns pagination', (await pagination.count()) === 1 && (await list.locator('.ant-pagination').count()) === 1);
  // Each provider's table sits in a sideways scroller. It must not catch the wheel: a stack of
  // them used to trap it one pixel deep, and the page would not scroll under the pointer.
  const firstTable = list.locator('[data-testid="pricing-provider-group"] .ant-table-tbody').first();
  const tableBox = await firstTable.boundingBox();
  const scrollBefore = await page.evaluate(() => document.querySelector('.app-content')?.scrollTop ?? 0);
  await page.mouse.move(tableBox.x + tableBox.width / 2, tableBox.y + 8);
  await page.mouse.wheel(0, 300);
  check('the wheel over a provider table scrolls the page', await isTrue(async () => (await page.evaluate(() => document.querySelector('.app-content')?.scrollTop ?? 0)) > scrollBefore, 'the page scroll'));
  await page.evaluate(() => document.querySelector('.app-content')?.scrollTo({ top: 0 }));
  check('pagination states the visible entry range', (await pagination.innerText()).includes('1–20 of 48'));
  check('pagination remains inside the desktop viewport', await pagination.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  }));
  const search = list.locator('[data-testid="pricing-search"]');
  await list.locator('.ant-pagination-item-2').first().click();
  check('page two changes the rows', await isTrue(async () => !(await editRows.first().getAttribute('aria-label')).includes('claude-sonnet'), 'page two'));
  check('page two updates its range', (await pagination.innerText()).includes('21–40 of 48'));
  await search.fill('gpt 6 sol');
  check('search resets desktop pagination and tolerates separators', await isTrue(async () => (await editRows.count()) === 1 && (await editRows.first().getAttribute('aria-label')).includes('gpt-6-sol'), 'search reset'));
  await search.fill('');
  await isTrue(async () => (await editRows.count()) === 20, 'reset book');
  await list.locator('.ant-segmented-item').filter({ hasText: /Unpriced/ }).click();
  check('unpriced models share the paginated book', await isTrue(async () => (await editRows.count()) === 20 && (await editRows.first().getAttribute('aria-label')).includes('gpt-5.4-mini-high'), 'unpriced filter'));
  check('suggestions stay beside the model', (await list.getByText(/openai\/gpt-5.4-mini/).count()) >= 1);
  await list.locator('[data-testid="pricing-row-adopt"]').click();
  const adopted = await isTrue(async () => writes.some((write) => write.kind === 'model' && write.model === 'gpt-5.4-mini-high'), 'the adopt write');
  const adoptWrite = writes.find((write) => write.kind === 'model' && write.model === 'gpt-5.4-mini-high');
  check('adopting a suggestion links the model to it', adopted && adoptWrite?.body.mode === 'linked' && adoptWrite?.body.upstream_id === 'openai/gpt-5.4-mini', JSON.stringify(adoptWrite));

  // ── the editor: auto shows its match, custom starts from the reference rates ──
  const edit = page.locator('[data-testid="pricing-row-edit"]');
  await isTrue(async () => (await edit.count()) >= 2, 'the price rows');
  await list.locator('.ant-segmented-item').filter({ hasText: /^All/ }).click();
  await list.locator('[data-testid="pricing-row-edit"][aria-label$=": gpt-6-sol"]').click();
  const editor = page.locator('[data-testid="pricing-editor"]');
  check('the editor opens in place', await isTrue(async () => editor.isVisible(), 'the editor'));
  check('auto mode shows the OpenRouter model it follows', await isTrue(async () => (await editor.locator('[data-testid="pricing-upstream-summary"]').getByText('openai/gpt-6-sol').count()) >= 1, 'the automatic match'));
  check('the preview prices a typical recent request', await isTrue(async () => /\$\d/.test(await editor.locator('[data-testid="pricing-preview"]').innerText()), 'the preview'));
  await editor.locator('[data-testid="pricing-mode-custom"]').click();
  // antd forwards a test id to the input element itself, so the selector takes either shape.
  const promptInput = editor.locator('input[data-testid="pricing-rate-prompt"], [data-testid="pricing-rate-prompt"] input').first();
  check('custom rates start from the OpenRouter reference', await isTrue(async () => (await promptInput.inputValue()) === '2', 'the prefilled rate'), await promptInput.inputValue());
  await promptInput.fill('1.5');
  await editor.locator('[data-testid="pricing-editor-save"]').click();
  const customSaved = await isTrue(async () => writes.some((write) => write.kind === 'model' && write.model === 'gpt-6-sol'), 'the custom write');
  const customWrite = writes.find((write) => write.kind === 'model' && write.model === 'gpt-6-sol');
  check(
    'saving custom rates sends the edited rate and the reference tier',
    customSaved && customWrite.body.mode === 'custom' && customWrite.body.prompt_price_per_1m === 1.5 && customWrite.body.tiers?.[0]?.min_prompt_tokens === 272_000,
    JSON.stringify(customWrite),
  );
  check('the editor closes after saving', await isTrue(async () => !(await editor.isVisible()), 'the editor closing'));

  await list.locator('[data-testid="pricing-row-edit"][aria-label$=": gpt-6-sol"]').click();
  await editor.locator('[data-testid="pricing-mode-linked"]').click();
  const picker = editor.getByRole('listbox');
  check('upstream choices have bounded pages', await isTrue(async () => (await picker.getByRole('option').count()) === 12, 'picker page'));
  const pickerSearch = editor.locator('input[placeholder]').first();
  await pickerSearch.fill('catalog model 60');
  check('search reaches catalog entries beyond the first fifty', await isTrue(async () => (await picker.getByRole('option').count()) === 1 && (await picker.innerText()).includes('test/catalog-model-60'), 'catalog search'));
  check('upstream choices are text-only', (await editor.locator('img').count()) === 0);
  await editor.locator('.ant-drawer-close').click();

  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  check('phone books keep the same page size', await isTrue(async () => (await list.locator('[data-testid="phone-row"]').count()) === 20, 'phone rows'));
  check('phone pagination uses a read-only page indicator', (await pagination.locator('input').count()) === 0 && (await pagination.locator('.ant-pagination-simple-pager').count()) === 1);
  check('phone pagination has reachable touch controls', await isTrue(async () => pagination.locator('.ant-pagination-next').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.width >= 40 && bounds.height >= 40 && bounds.bottom <= innerHeight;
  }), 'phone pagination geometry'), JSON.stringify(await pagination.locator('.ant-pagination-next').boundingBox()));
  await list.locator('.ant-pagination-next').first().click();
  await search.fill('gpt 6 sol');
  check('phone search returns to the first page', await isTrue(async () => (await editRows.count()) === 1 && (await editRows.first().getAttribute('aria-label')).includes('gpt-6-sol'), 'phone search'));
  check('phone book fits the viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('single-page results keep their range without navigation', (await pagination.innerText()).includes('1–1 of 1') && (await pagination.locator('.ant-pagination').count()) === 0);
  await search.fill('');
  await page.setViewportSize({ width: 320, height: 740 });
  check('pagination fits narrow phones', await isTrue(async () => pagination.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth;
  }), 'narrow pagination'));
  await page.setViewportSize(originalViewport);

  // ── a channel multiplier saves from its row ───────────────────────────────────
  await page.goto(`${base}/pricing?tab=channels`, { waitUntil: 'domcontentloaded' });
  const channels = page.locator('[data-testid="pricing-channels"]');
  check('the channel tab lists traffic channels beside configured ones', await isTrue(async () => (await channels.locator('[data-testid="pricing-channel-multiplier"]').count()) === 2, 'the channel rows'));
  const codexMultiplier = channels.locator('input[data-testid="pricing-channel-multiplier"], [data-testid="pricing-channel-multiplier"] input').first();
  await codexMultiplier.fill('0.3');
  await codexMultiplier.blur();
  await channels.locator('[data-testid="pricing-channel-save"]').first().click();
  const channelSaved = await isTrue(async () => writes.some((write) => write.kind === 'channel' && write.channel === 'codex'), 'the channel write');
  check('a channel multiplier saves', channelSaved && writes.find((write) => write.kind === 'channel')?.body.multiplier === 0.3, JSON.stringify(writes.filter((write) => write.kind === 'channel')));
}

/** An unpriced request prices its model from the list without opening the record. */
export async function pricingFromRequestList({ base, page, check, writes }) {
  await page.goto(`${base}/usage/events`, { waitUntil: 'domcontentloaded' });
  const setPrice = page.locator('[data-testid="request-set-price"]').first();
  check('an unpriced request offers to price its model', await isTrue(async () => (await setPrice.count()) >= 1, 'the set-price control'));
  await setPrice.click();
  const editor = page.locator('[data-testid="pricing-editor"]');
  check('the price editor opens over the request list', await isTrue(async () => editor.isVisible(), 'the editor'));
  check('the request record did not open underneath', (await page.locator('.request-detail .ant-drawer-body:visible').count()) === 0);
  void writes;
}
