import { mkdir } from 'node:fs/promises';
import { until, settleLayout } from '../harness.mjs';

const LONG_CALL_POINT = 'team/custom-with-a-very-long-unbroken-routing-label-for-mobile-layout';
const ROUTES = [
  { provider_id: 'openai-compat-0', upstream_model: 'gpt-5', call_point: 'team/fast' },
  { provider_id: 'openai-compat-0', upstream_model: 'claude-sonnet-4.5', call_point: 'team/fast' },
  { provider_id: 'oauth:codex', upstream_model: 'gpt-5', call_point: 'gpt-5' },
  { provider_id: 'openai-compat-0', upstream_model: 'deepseek-r1', call_point: 'reasoner' },
  { provider_id: 'openai-compat-0', upstream_model: 'experimental-model-with-a-very-long-unbroken-identity-for-mobile-layout', call_point: LONG_CALL_POINT },
  { provider_id: '', upstream_model: '', call_point: 'runtime-only' },
  // One name served by two connections.
  { provider_id: 'oauth:codex', upstream_model: 'gpt-5-pro', call_point: 'gpt-5-pro' },
  ...['claude-opus-4.5', 'gemini-3-pro', 'gpt-5-mini', 'gpt-5-pro', 'gpt-5-codex'].map(model => ({ provider_id: 'openai-compat-0', upstream_model: model, call_point: model })),
];
const DIRECTORY = {
  models: [...new Set(ROUTES.map(route => route.call_point))].map(id => ({ id, call_point: id, vision: 'unknown' })),
  metadata_updated_at: '2026-10-05',
  model_info: {
    'gpt-5': { id: 'openai/gpt-5', name: 'GPT-5', open_weights: false, reasoning: true, tool_call: true, limit: { context: 400_000, output: 128_000 }, modalities: { input: ['text', 'image'], output: ['text'] } },
    'claude-sonnet-4.5': { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', open_weights: false, limit: { context: 200_000, output: 64_000 }, modalities: { input: ['text', 'image', 'pdf'], output: ['text'] } },
    'deepseek-r1': { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', open_weights: true, license: 'MIT', limit: { context: 128_000, output: 32_768 }, modalities: { input: ['text'], output: ['text'] }, weights: [{ label: 'Hugging Face', url: 'https://huggingface.co/deepseek-ai/DeepSeek-R1' }] },
  },
  providers: [
    { id: 'openai-compat-0', family: 'openai-compatibility', name: 'Team Relay', is_oauth: false, icon_id: 'DeepSeek' },
    { id: 'oauth:codex', family: 'codex', name: 'Codex OAuth', is_oauth: true },
  ], routes: ROUTES, partial: [],
};
const usage = (requests, cost) => ({ requests, priced_requests: cost == null ? 0 : requests, cost_usd: cost });
const priced = (model, prompt, completion, usage30d) => ({
  model, prompt_price_per_1m: prompt, completion_price_per_1m: completion, cache_read_price_per_1m: prompt / 10, cache_write_price_per_1m: prompt * 1.25,
  price_multiplier: 1, tiers: [], source: 'manual', upstream_id: '', match_kind: '', mode: 'custom', synced_at_ms: 0, updated_at_ms: 0, usage_30d: usage30d,
});
// Two names are priced; every other advertised name is unpriced, whether the book lists it or not.
const PRICE_BOOK = {
  source: 'openrouter', providers: [], channels: [], upstream_count: 0, sync: { known: false, running: false, state: null },
  models: [priced('gpt-5', 1.25, 10, usage(120, 14.2)), priced('reasoner', 0.55, 2.19, usage(8, 0.4))],
  unpriced: [{ model: 'team/fast', usage_30d: usage(12, null), suggestions: [] }],
};
const RECENT_REQUESTS = {
  window: { from: 0, to: 0, bucket_ms: 0 },
  facets: {
    models: [], providers: [], api_group_keys: [], auth_indexes: [], sources: [], executors: [], auth_types: [], reasoning_efforts: [], service_tiers: [],
    model_aliases: [{ value: 'gpt-5', requests: 1234 }, { value: 'team/fast', requests: 12 }],
  },
};

/** The directory alone, for scenarios that bring their own price book and request records. */
export function modelSquareFixtures() {
  return [
    [(url) => url.pathname.endsWith('/management/model-square'), () => DIRECTORY],
  ];
}

/** The two neighbours the directory joins by call name, and the editor a row opens. */
export function modelSquareLedgerFixtures() {
  return [
    [(url) => url.pathname.endsWith('/pricing'), () => PRICE_BOOK],
    [(url) => url.pathname.endsWith('/pricing/catalog'), () => ({ models: [] })],
    [(url) => /\/pricing\/models\/[^/]+$/.test(url.pathname), (url) => {
      const model = decodeURIComponent(url.pathname.split('/').at(-1));
      return { model, price: PRICE_BOOK.models.find(row => row.model === model) ?? null, automatic: null, suggestions: [], candidate: null, versions: [], profile: null };
    }],
    [(url) => url.pathname.endsWith('/usage/facets'), () => RECENT_REQUESTS],
    [(url) => url.pathname.includes('/usage/events'), () => ({ items: [], has_more: false, limit: 100 })],
  ];
}

export async function modelSquare({ base, page, context, check }) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${base}/model-square`, { waitUntil: 'domcontentloaded' });
  const entries = page.locator('.model-square-page [data-model-identity]');
  const rowOf = identity => page.locator('.model-square-page li', { has: page.locator(`[data-model-identity="${identity}"]`) }).last();
  await until(async () => await entries.count() === DIRECTORY.models.length, { label: 'advertised model labels' });
  await settleLayout(page);
  const sections = page.locator('.model-square-page [data-model-group]');
  const geometry = await sections.evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
  }));
  check('maker sections form one full-width vertical sequence', geometry.length >= 4 && geometry.every((bounds, index) => index === 0 || bounds.top >= geometry[index - 1].bottom && Math.abs(bounds.left - geometry[0].left) < 1 && Math.abs(bounds.right - geometry[0].right) < 1), JSON.stringify(geometry));
  check('maker headings are distinct from connection branding', await page.locator('.model-square-page h2').allTextContents().then(names => ['OpenAI', 'Anthropic', 'Google', 'DeepSeek', 'Multiple makers', 'Unidentified maker'].every(name => names.includes(name))));
  check('named makers precede the multiple and unidentified groups', await page.locator('.model-square-page h2').allTextContents().then(names => names.slice(-2).join('|') === 'Multiple makers|Unidentified maker' && names.slice(0, -2).join('|') === [...names.slice(0, -2)].sort((left, right) => left.localeCompare(right)).join('|')));
  const gptRow = rowOf('gpt-5');
  await until(async () => (await gptRow.innerText()).includes('$1.25'), { label: 'price book joined' });
  check('a row states its price and the connection serving it, and no usage figure', await gptRow.innerText().then(text => text.includes('$1.25 / $10.00') && text.includes('Codex OAuth') && !text.includes('1,234')), await gptRow.innerText());
  check('a row carries no reference specification', await gptRow.innerText().then(text => !/400K|128K|Reasoning|Tool calling/.test(text)));
  check('a name the price book does not list asks for a price', await rowOf('gpt-5-mini').getByRole('button', { name: 'Set price' }).count() === 1);
  check('the directory raises no price-book banner of its own', !(await page.locator('.model-square-page').innerText()).includes('left out of costs'));
  const cardColumns = () => page.locator('[data-model-group="openai"] [data-model-identity]').evaluateAll(buttons => new Set(buttons.map(button => Math.round(button.closest('li').getBoundingClientRect().left))).size);
  check('a maker section lays its models out in several columns on a wide page', await cardColumns() >= 2, `columns=${await cardColumns()}`);
  check('a model served by several connections states their count instead of wrapping their names', await rowOf('gpt-5-pro').innerText().then(text => text.includes('2 connections') && !text.includes('Team Relay')) && await rowOf('gpt-5-pro').locator('img').count() === 2, await rowOf('gpt-5-pro').innerText());
  check('live IDs with unresolved provenance remain visible', await page.locator('[data-model-identity="runtime-only"]').count() === 1);
  const labelsContained = await sections.evaluateAll(elements => elements.every(section => [...section.querySelectorAll('[data-model-identity]')].every(label => {
    const outer = section.getBoundingClientRect(), inner = label.getBoundingClientRect();
    return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
  })));
  check('compact model labels remain within their maker section', labelsContained);
  const localArtwork = await page.locator('.model-square-page').evaluate(element => [...element.querySelectorAll('img')].every(image => image.src.startsWith(location.origin) || image.src.startsWith('data:')));
  check('model and manufacturer marks use local artwork', localArtwork);
  await mkdir('tmp/model-square-preview', { recursive: true });
  await page.screenshot({ path: 'tmp/model-square-preview/desktop.png', fullPage: true });

  const drawer = page.locator('.ant-drawer:visible');
  await page.locator('[data-copy-model="team/fast"]').click();
  await until(async () => await page.evaluate(() => navigator.clipboard.readText()) === 'team/fast', { label: 'call name on the clipboard' });
  check('clicking a name copies the call name clients send, without opening details', await drawer.count() === 0 && await page.locator('[data-copy-model="team/fast"]').getAttribute('aria-label') === 'Copied');
  await rowOf('gpt-5-mini').getByRole('button', { name: 'Set price' }).click();
  await until(async () => (await drawer.locator('.ant-drawer-title').allInnerTexts()).some(title => title.includes('gpt-5-mini')), { label: 'price editor' });
  check('Set price opens the shared price editor for that call name alone', await drawer.count() === 1 && !(await drawer.innerText()).includes('Served by'));
  await page.goBack();
  await drawer.waitFor({ state: 'hidden' });

  const status = page.locator('.model-square-page [role="status"]');
  check('an unfiltered directory states no result count', (await status.innerText()) === '' && new URL(page.url()).search === '');
  await page.locator('[data-maker="openai"]').click();
  await until(async () => await entries.count() === 4, { label: 'maker filter' });
  check('a maker filter shows that maker alone, and says how many', await sections.count() === 1 && await page.locator('[data-maker="openai"]').getAttribute('aria-pressed') === 'true' && (await status.innerText()) === `Showing 4 of ${DIRECTORY.models.length}`);
  // Anywhere on the row that is not one of its own controls opens the details: here, its served-by cell.
  const servedBy = await gptRow.getByText('Codex OAuth').boundingBox();
  await page.mouse.click(servedBy.x + servedBy.width / 2, servedBy.y + servedBy.height / 2);
  const stepping = drawer;
  await stepping.waitFor({ state: 'visible' });
  check('details name the connection serving the model', (await stepping.innerText()).includes('Served by') && (await stepping.innerText()).includes('Codex OAuth'));
  const cost = stepping.getByTestId('model-cost');
  check('details state the price and the 24-hour request count, and no other window', await cost.innerText().then(text => ['$1.25', '$10.00', '1,234'].every(figure => text.includes(figure)) && !text.includes('30d')), await cost.innerText());
  check('details hand off to the price editor and to this model’s requests', await cost.getByRole('button', { name: 'Edit price' }).count() === 1 && await cost.getByRole('link', { name: 'View requests' }).getAttribute('href').then(href => href.endsWith('/usage/events?preset=24h&model_alias=gpt-5')));
  check('reference limits live in the details', (await stepping.innerText()).includes('400,000') && (await stepping.innerText()).includes('128,000') && (await stepping.innerText()).includes('Closed-source model'));
  check('the first model has no previous neighbour', await stepping.getByRole('button', { name: 'Previous' }).isDisabled() && (await stepping.innerText()).includes('1 / 4'));
  await stepping.getByRole('button', { name: 'Next' }).click();
  await until(async () => (await stepping.locator('.ant-drawer-title').innerText()) === 'gpt-5-codex', { label: 'next model' });
  check('Next steps through the filtered list without leaving the details', (await stepping.innerText()).includes('2 / 4'));
  check('an unpriced model’s details lead with setting its price', await cost.getByRole('button', { name: 'Set price' }).count() === 1 && (await cost.innerText()).includes('No price yet'));
  await page.goBack();
  await stepping.waitFor({ state: 'hidden' });
  check('one Back dismisses details after stepping and keeps the maker filter', new URL(page.url()).searchParams.get('maker') === 'openai' && await entries.count() === 4);
  await page.locator('[data-maker="openai"]').click();
  await until(async () => await entries.count() === DIRECTORY.models.length, { label: 'maker filter released' });

  const search = page.getByRole('textbox', { name: 'Search models or makers' });
  await search.fill('team/fast');
  await until(async () => await entries.count() === 1, { label: 'search result' });
  await page.getByRole('button', { name: 'View information for team/fast', exact: true }).click();
  await drawer.waitFor({ state: 'visible' });
  check('shared call point exposes the distinct source-backed model profiles', (await drawer.innerText()).includes('GPT-5') && (await drawer.innerText()).includes('Claude Sonnet 4.5') && (await drawer.innerText()).includes('400,000') && (await drawer.innerText()).includes('200,000'));
  const externalLinks = drawer.locator('a[target="_blank"]');
  check('reference navigation uses new-tab links without opener access', await externalLinks.evaluateAll(links => links.length === 6 && links.every(link => link.rel.includes('noopener') && link.rel.includes('noreferrer'))));
  check('pi search uses the canonical model name', await drawer.locator('a[href="https://pi.dev/models?name=gpt-5"]').count() === 1);
  await page.goBack();
  await drawer.waitFor({ state: 'hidden' });
  check('native Back dismisses details and preserves search', page.url().includes('/model-square') && new URL(page.url()).searchParams.get('q') === 'team/fast');
  await search.fill('');
  await until(async () => await entries.count() === DIRECTORY.models.length, { label: 'full model directory' });
  await page.getByRole('button', { name: 'View information for reasoner', exact: true }).click();
  await drawer.waitFor({ state: 'visible' });
  check('a model with downloadable weights under an open-source license is named an open-source model', (await drawer.innerText()).includes('Open-source model') && (await drawer.innerText()).includes('MIT') && await drawer.locator('a[href="https://huggingface.co/deepseek-ai/DeepSeek-R1"]').count() === 1);
  await page.goBack();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'View information for runtime-only', exact: true }).click();
  await drawer.waitFor({ state: 'visible' });
  check('unmatched model keeps explicit unknown data and usable search links', (await drawer.innerText()).includes('No exact metadata match') && await drawer.locator('a[href="https://pi.dev/models?name=runtime-only"]').count() === 1);
  await page.goBack();
  await drawer.waitFor({ state: 'hidden' });

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await settleLayout(page);
    const overflow = await page.locator('.app-content').evaluate(element => element.scrollWidth - element.clientWidth);
    check(`maker sections fit ${width}px`, overflow <= 1, `overflow=${overflow}`);
    const target = page.getByRole('button', { name: 'View information for gpt-5', exact: true });
    await target.scrollIntoViewIfNeeded();
    const bounds = await target.boundingBox();
    check(`model touch targets remain reachable at ${width}px`, bounds.width >= 44 && bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds));
    const copyBounds = await page.locator('[data-copy-model="gpt-5"]').boundingBox();
    check(`the copyable name is a full touch target at ${width}px`, copyBounds.height >= 44 && copyBounds.x >= 0 && copyBounds.x + copyBounds.width <= bounds.x + 1, JSON.stringify(copyBounds));
    check(`models form a single column at ${width}px`, await cardColumns() === 1, `columns=${await cardColumns()}`);
    check(`a card keeps its price and connection at ${width}px`, await gptRow.innerText().then(text => text.includes('$1.25 / $10.00') && text.includes('Codex OAuth')));
    const longLabel = page.locator(`[data-copy-model="${LONG_CALL_POINT}"]`);
    const labelBounds = await longLabel.boundingBox();
    check(`long model names wrap within ${width}px`, labelBounds.height >= 44 && labelBounds.x >= 0 && labelBounds.x + labelBounds.width <= width + 1, JSON.stringify(labelBounds));
    if (width === 320) await page.screenshot({ path: 'tmp/model-square-preview/phone.png', fullPage: true });
    await target.click();
    await drawer.waitFor({ state: 'visible' });
    await settleLayout(page);
    await drawer.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    });
    const drawerGeometry = await drawer.locator('.ant-drawer-body').evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, right: element.getBoundingClientRect().right }));
    check(`model specifications fit the ${width}px drawer`, drawerGeometry.overflow <= 1 && drawerGeometry.right <= width + 1, JSON.stringify(drawerGeometry));
    if (width === 320) await page.screenshot({ path: 'tmp/model-square-preview/details-phone.png', fullPage: true });
    await page.goBack();
    await drawer.waitFor({ state: 'hidden' });
  }
}
