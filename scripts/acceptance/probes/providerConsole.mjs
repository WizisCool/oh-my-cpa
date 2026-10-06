import { until } from '../harness.mjs';

/**
 * Probes for the provider console: the icon picker's stacking against the open
 * drawer, and the mark a provider row draws once one is picked. Stacking and
 * hit-testing are engine facts, so neither claim can leave the browser.
 */

export const pickerProvider = {
  id: 'openai-compat-0',
  family: 'openai-compatibility',
  name: 'CommandCode GOAT',
  protocol: 'OpenAI Compatible Chat Completions',
  base_url: 'https://api.example.test/v1',
  disabled: false,
  key_configured: true,
  models: ['deepseek-v4.1-flash'],
};

/**
 * Portals are antd's, so only the engine can say which one is on top. A computed
 * `z-index` cannot prove it either: an ancestor stacking context can trap a high
 * value, which is why the assertion asks `elementFromPoint` what is really there.
 *
 * The first open also has to *render* the catalog. antd mounts the dialog panel
 * asynchronously, so the effect that attaches the lazy-loading observer runs once
 * against a panel node that does not exist yet and never re-runs. Nothing is then
 * observed, every tile paints as an empty box, and the second open looks correct
 * because the panel is already mounted by then. That makes the first open the only
 * one that can catch it, and the assertion below has to run before the reopen loop.
 */

export async function iconPickerStacking({ base, page, check }) {
  const requestedIconAssets = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/lobe-icons/')) requestedIconAssets.add(url.pathname);
  });

  await page.goto(`${base}/ai-providers`, { waitUntil: 'domcontentloaded' });
  await page.locator('.providers-page').waitFor({ timeout: 20_000 });

  await page.locator('.providers-page').getByRole('button', { name: /Edit|编辑/i }).first().click({ timeout: 10_000 });
  await page.locator('.ant-drawer-open').waitFor({ state: 'visible', timeout: 10_000 });

  const pickerTrigger = page.locator('.ant-drawer-open').getByRole('button', { name: /Change Icon|更改图标/i }).first();
  if (await pickerTrigger.isVisible().catch(() => false)) {
    await pickerTrigger.click();
  } else {
    // The inline icon tile opens the same picker.
    await page.locator('.ant-drawer-open').locator('div[title]').first().click();
  }
  const picker = page.locator('.ant-modal').filter({ hasText: /Select AI Provider Icon|选择 AI 提供商图标/i });
  await picker.waitFor({ state: 'visible', timeout: 10_000 });

  /**
   * Counts tiles that rendered an icon node rather than only their label: either an
   * `<img>` the tile requested, or a masked `<span>`. A tile that shows its label
   * with no icon node is exactly the reported failure, so reading the label back
   * would not distinguish the two states.
   */
  const renderedIconCount = () =>
    page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.ant-modal [data-icon-id]')];
      return tiles.filter((tile) => {
        if (tile.querySelector('img[src*="/lobe-icons/"]')) return true;
        return [...tile.querySelectorAll('span')].some((node) => {
          const style = getComputedStyle(node);
          return (style.maskImage && style.maskImage !== 'none')
            || (style.webkitMaskImage && style.webkitMaskImage !== 'none');
        });
      }).length;
    });

  // A zero rather than a thrown error, so the check reports the count it observed
  // instead of the timeout that revealed it.
  const firstOpenIcons = await until(renderedIconCount, { label: 'the first open to render icons' })
    .catch(() => 0);
  check(
    'the first open renders the icon grid',
    firstOpenIcons > 0,
    `rendered=${firstOpenIcons}`,
  );

  /** 120 is the whole catalog; anything at or above it means the lazy boundary is gone. */
  check(
    'the icon picker loads only nearby assets',
    requestedIconAssets.size > 0 && requestedIconAssets.size < 120,
    `loaded=${requestedIconAssets.size}`,
  );

  const readZ = (selector) =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      return Number.parseInt(window.getComputedStyle(node).zIndex, 10) || 0;
    }, selector);

  const drawerZ = await readZ('.ant-drawer-open');
  const pickerZ = await readZ('.ant-modal-wrap');
  check('the picker is layered above the drawer', pickerZ > drawerZ, `drawer=${drawerZ} picker=${pickerZ}`);

  const hit = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal');
    if (!modal) return { ok: false, reason: 'no modal' };
    const box = modal.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    if (!target) return { ok: false, reason: 'nothing hit' };
    const insidePicker = Boolean(target.closest('.ant-modal'));
    const insideDrawer = Boolean(target.closest('.ant-drawer'));
    return { ok: insidePicker && !insideDrawer, insidePicker, insideDrawer, tag: target.className };
  });
  check('the picker wins hit-testing against the drawer', hit.ok, `picker=${hit.insidePicker} drawer=${hit.insideDrawer}`);

  // Reopening must not flip the order: this is the reported "sometimes" case.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden', timeout: 10_000 });
    if (await pickerTrigger.isVisible().catch(() => false)) {
      await pickerTrigger.click();
    } else {
      await page.locator('.ant-drawer-open').locator('div[title]').first().click();
    }
    await picker.waitFor({ state: 'visible', timeout: 10_000 });
    const repeatedHit = await page.evaluate(() => {
      const modal = document.querySelector('.ant-modal');
      if (!modal) return false;
      const box = modal.getBoundingClientRect();
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
      return Boolean(target && target.closest('.ant-modal') && !target.closest('.ant-drawer'));
    });
    check(`reopen ${attempt + 2} keeps the picker on top`, repeatedHit);
  }
}

// ---------------------------------------------------------------------------
// Provider icon assignment
// ---------------------------------------------------------------------------

/**
 * The mark a row or a picker tile is currently drawing, as a string that names the
 * asset behind it.
 *
 * A catalog entry with a colour variant renders an `<img>`; one without renders a
 * masked `<span>`. Reading both is what keeps the assertion about the mark rather
 * than about which of the two renderers the entry happens to use.
 */

const renderedMark = (node) => {
  const image = node.querySelector('img[src*="/lobe-icons/"]');
  if (image) return image.getAttribute('src') ?? '';
  for (const span of node.querySelectorAll('span')) {
    const style = getComputedStyle(span);
    const mask = style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage;
    if (mask && mask !== 'none') return mask;
  }
  return '';
};

/**
 * Picking an icon in the picker must leave the row wearing it.
 *
 * The claim is the operator's own: the mark the picker sets is the mark the
 * provider list draws, and the picker reopens on that mark rather than on the
 * provider's default. Both halves have been wrong - an override stored under a name
 * the row did not resolve, and an id key that survived the row it described - and
 * neither is visible in a unit test of the keying rule, because what fails is the
 * wiring between the click, the preference cache and the re-render.
 */

export async function providerIconPick({ base, page, check }) {
  await page.goto(`${base}/ai-providers`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('.providers-page tbody tr[data-row-key="openai-compat-0"]');
  await row.waitFor({ state: 'visible', timeout: 20_000 });

  const rowMark = () => row.evaluate(renderedMark);
  const before = await rowMark();
  check('the provider row starts on its own default mark', before.length > 0, `mark=${before || 'none'}`);

  // The inline mark on the row opens the picker for that row, which is the path
  // that writes an override straight from the table.
  await row.locator('div[title]').first().click({ timeout: 10_000 });
  const picker = page.locator('.ant-modal').filter({ hasText: /Select AI Provider Icon|选择 AI 提供商图标/i });
  await picker.waitFor({ state: 'visible', timeout: 10_000 });

  const tile = picker.locator('[data-icon-id="DeepSeek"]');
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
  await tile.click({ timeout: 10_000 });
  await picker.waitFor({ state: 'hidden', timeout: 10_000 });

  await until(async () => /deepseek/i.test(await rowMark()), { label: 'the row to adopt the picked mark' }).catch(() => {});
  const picked = await rowMark();
  check(
    'the icon picked for a provider is the mark its row draws',
    /deepseek/i.test(picked),
    `before=${before} after=${picked || 'none'}`,
  );

  // The picker must reopen on the stored override: a picker that showed the default
  // while the row showed the pick would invite the operator to "fix" a mark that
  // was already right.
  await row.locator('div[title]').first().click({ timeout: 10_000 });
  await picker.waitFor({ state: 'visible', timeout: 10_000 });
  const selectedWidth = await picker.locator('[data-icon-id="DeepSeek"]').evaluate((node) => getComputedStyle(node).borderTopWidth);
  const otherWidth = await picker
    .locator('[data-icon-id="Qwen"]')
    .evaluate((node) => getComputedStyle(node).borderTopWidth);
  check(
    'the picker reopens on the stored mark rather than on the provider default',
    selectedWidth !== otherWidth,
    `deepseek=${selectedWidth} qwen=${otherWidth}`,
  );
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'hidden', timeout: 10_000 });

  // And it is stored, not only rendered: the same row wears the mark after a reload,
  // which is what makes it a provider override rather than component state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await until(async () => /deepseek/i.test(await rowMark()), { label: 'the mark to survive a reload' }).catch(() => {});
  const reloaded = await rowMark();
  check(
    'the picked mark is stored and survives a reload',
    /deepseek/i.test(reloaded),
    `mark=${reloaded || 'none'}`,
  );
}

// ---------------------------------------------------------------------------
// Provider editor: batch model pick and the key field
// ---------------------------------------------------------------------------

export const pickerCatalog = ['deepseek-v4.1-flash', 'gpt-5.4', 'gpt-5.4-mini', 'o3'];

/**
 * A fetch opens the batch picker, and what it adds is exactly the new names.
 *
 * The picker is a modal over the drawer, so whether a pick reaches the drawer's
 * rows is the wiring between two portals and the form state - nothing a logic test
 * of `modelsToAdd` can see. The same drawer is also where the key field must not
 * be a password field: the browser's own autofill and save prompts key on the
 * element's type, so the assertion reads the rendered DOM.
 */
export async function providerModelPicker({ base, page, check }) {
  await page.goto(`${base}/ai-providers`, { waitUntil: 'domcontentloaded' });
  await page.locator('.providers-page').waitFor({ timeout: 20_000 });
  await page.locator('.providers-page').getByRole('button', { name: /Edit|编辑/i }).first().click({ timeout: 10_000 });
  const drawer = page.locator('.ant-drawer-open');
  await drawer.waitFor({ state: 'visible', timeout: 10_000 });

  const keyFields = await drawer.evaluate((node) => {
    const inputs = [...node.querySelectorAll('input')];
    return {
      passwords: inputs.filter((input) => input.type === 'password').length,
      masked: inputs.filter((input) => getComputedStyle(input).webkitTextSecurity === 'disc').length,
    };
  });
  check(
    'the provider key is a masked text field, not a password field',
    keyFields.passwords === 0 && keyFields.masked > 0,
    `password=${keyFields.passwords} masked=${keyFields.masked}`,
  );

  await drawer.locator('button[aria-expanded]').filter({ hasText: /Custom Models|自定义模型/ }).click({ timeout: 10_000 });
  await drawer.getByRole('button', { name: /Fetch Model List|获取模型列表/i }).click({ timeout: 10_000 });
  const picker = page.locator('.ant-modal').filter({ hasText: /Choose models|选择模型/i });
  await picker.waitFor({ state: 'visible', timeout: 10_000 });
  check('a fetch opens the model picker', true);

  const configuredOption = picker.locator('.ant-checkbox-wrapper').filter({ hasText: 'deepseek-v4.1-flash' });
  check(
    'a configured model is listed ticked and fixed',
    (await configuredOption.locator('input').isChecked()) && (await configuredOption.locator('input').isDisabled()),
  );

  await picker.getByRole('textbox').fill('gpt');
  await picker.getByText(/^(Select all|全选)$/).click();
  await picker.getByRole('button', { name: /Apply \(2\)|应用 \(2\)/i }).click({ timeout: 10_000 });
  await picker.waitFor({ state: 'hidden', timeout: 10_000 });

  const readRows = () => drawer.evaluate((node) =>
    [...node.querySelectorAll('[id^="model-card-"] input')]
      .filter((input) => /Request Model|请求模型/.test(input.getAttribute('placeholder') ?? ''))
      .map((input) => input.value));
  await until(async () => (await readRows()).length === 3, { label: 'the picked models to become rows' }).catch(() => {});
  const rows = await readRows();
  check(
    'the pick adds the searched models once, after the configured one',
    JSON.stringify(rows) === JSON.stringify(['deepseek-v4.1-flash', 'gpt-5.4', 'gpt-5.4-mini']),
    `rows=${JSON.stringify(rows)}`,
  );

  const existingModel = drawer.locator('[id^="model-card-"]').first();
  await existingModel.locator('button[aria-expanded]').click();
  await existingModel.locator('[class*="item-body"]').waitFor({ state: 'visible' });
  await drawer.getByRole('button', { name: /^(Add Model|添加模型)$/i }).click();
  const newModel = drawer.locator('[id^="model-card-"]').last();
  await until(async () => await drawer.locator('[id^="model-card-"]').count() === 4,
    { label: 'the custom model row to be added' });
  const expansion = newModel.locator('button[aria-expanded]');
  check('a new custom model starts collapsed without collapsing existing expanded models',
    await expansion.getAttribute('aria-expanded') === 'false'
      && await newModel.locator('[class*="item-body"]').count() === 0
      && await existingModel.locator('button[aria-expanded]').getAttribute('aria-expanded') === 'true');
  const requestModel = newModel.getByPlaceholder(/Request Model|请求模型/);
  await requestModel.fill('fixture-custom-model');
  check('the collapsed custom model still allows editing its upstream name',
    await requestModel.inputValue() === 'fixture-custom-model');
  await expansion.click();
  await newModel.locator('[class*="item-body"]').waitFor({ state: 'visible' });
  check('the new model advanced settings can still be explicitly expanded',
    await expansion.getAttribute('aria-expanded') === 'true');
  await expansion.click();
  await newModel.locator('[class*="item-body"]').waitFor({ state: 'detached' });
  check('the new model advanced settings can be collapsed again',
    await expansion.getAttribute('aria-expanded') === 'false');
}

export function customIconProbeRoutes() {
  const icons = new Map();
  let storedIcons = {};
  const iconID = '0123456789abcdef0123456789abcdef';
  let shouldFailAssignment = false;
  let shouldFailArtworkUpdate = true;
  let shouldFailDeletion = true;
  return [
    [(url, method) => url.pathname.endsWith('/custom-icons/preview') && method === 'POST', (_url, _method, request) => {
      const { data } = JSON.parse(request.postData());
      let decoded = Buffer.from(data.includes(',') ? data.split(',')[1] : data, 'base64').toString();
      if (!decoded.includes('<svg')) return { status: 400, json: { error: 'custom_icon_invalid_image', code: 'custom_icon_invalid_image' } };
      if (!decoded.includes('xmlns=')) decoded = decoded.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      return { data_url: `data:image/svg+xml;base64,${Buffer.from(decoded).toString('base64')}`, mime_type: 'image/svg+xml' };
    }],
    [(url) => url.pathname.includes('/custom-icons') && !url.pathname.endsWith('/content'), (url, method, request) => {
      if (method === 'GET') return { icons: [...icons.values()] };
      const id = method === 'POST' ? iconID : url.pathname.split('/').at(-1);
      const input = method === 'DELETE' ? {} : JSON.parse(request.postData());
      if (method === 'DELETE') {
        if (shouldFailDeletion) { shouldFailDeletion = false; return { status: 500, json: { code: 'internal_error' } }; }
        icons.delete(id);
        storedIcons = Object.fromEntries(Object.entries(storedIcons).filter(([, reference]) => reference !== `custom:${id}`));
        return { status: 204, json: null };
      }
      if (method === 'PATCH' && shouldFailArtworkUpdate) { shouldFailArtworkUpdate = false; return { status: 500, json: { code: 'internal_error' } }; }
      const previous = icons.get(id);
      const icon = { id, name: input.name ?? previous.name, mime_type: 'image/svg+xml', revision: (previous?.revision ?? 0) + 1, reference_count: previous?.reference_count ?? 0, created_at_ms: 1000, updated_at_ms: 1000 };
      icons.set(id, icon);
      return icon;
    }],
    [(url, method) => url.pathname.endsWith('/preferences/provider_icons') && method === 'PUT', (_url, _method, request) => {
      const value = JSON.parse(request.postData());
      if (Object.values(value).includes(`custom:${iconID}`)) {
        if (!shouldFailAssignment) { shouldFailAssignment = true; return { status: 500, json: { error: 'custom_icon_not_found', code: 'custom_icon_not_found' } }; }
        if (icons.has(iconID)) icons.get(iconID).reference_count = 1;
      } else if (icons.has(iconID)) icons.get(iconID).reference_count = 0;
      // The shared preference mock owns durable state; this route updates it by its GET projection below.
      storedIcons = value;
      return { key: 'provider_icons', value };
    }],
    [(url, method) => url.pathname.endsWith('/preferences') && method === 'GET', () => ({ preferences: { provider_icons: storedIcons }, time_zone: { effective_timezone: 'UTC', server_timezone: 'UTC' } })],
    [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [pickerProvider], total: 1 })],
  ];
}

export async function customIconLibrary({ base, page, check }) {
  await page.route('**/omc/api/v1/custom-icons/*/content*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="10" cx="12" cy="12"/></svg>' }));
  await page.goto(`${base}/ai-providers`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('.providers-page tbody tr[data-row-key="openai-compat-0"]');
  const picker = page.locator('.ant-modal').filter({ hasText: /Select AI Provider Icon|选择 AI 提供商图标/i });
  const openPicker = async () => { await row.waitFor({ state: 'visible' }); await row.locator('div[title]').first().click(); await picker.waitFor({ state: 'visible' }); };
  await openPicker();
  await picker.getByText('Custom', { exact: true }).click();
  await picker.getByRole('button', { name: 'Add icon' }).click();
  await picker.getByLabel('Icon name', { exact: true }).fill('Team Upload');
  await picker.locator('input[type="file"]').setInputFiles({ name: 'team.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24"/></svg>') });
  await picker.locator('img[alt="Validate and preview"]').waitFor({ state: 'visible' });
  await until(async () => await picker.locator('img[alt="Validate and preview"]').evaluate((image) => image.complete && image.naturalWidth > 0), { label: 'validated preview artwork to paint' });
  await picker.getByRole('button', { name: 'Save icon', exact: true }).click();
  const tile = picker.locator('[data-custom-icon-id]');
  await tile.waitFor({ state: 'visible' });
  check('a file upload creates a reusable icon without selecting it', await tile.getByText('Team Upload', { exact: true }).isVisible() && !await tile.locator('button[data-icon-id]').getAttribute('aria-pressed').then((value) => value === 'true'));
  await picker.getByRole('textbox', { name: 'Search icons by name' }).fill('no-such-icon');
  await picker.getByText('No matching icons', { exact: true }).waitFor({ state: 'visible' });
  check('name search has a dedicated full-width empty result', await picker.getByTestId('custom-icons-empty').evaluate((element) => element.getBoundingClientRect().width > 500));
  await picker.getByRole('button', { name: 'Clear search', exact: true }).click();
  await tile.waitFor({ state: 'visible' });
  await tile.locator('button[data-icon-id]').click();
  await picker.getByRole('button', { name: 'Add icon' }).waitFor({ state: 'visible' });
  check('a failed assignment keeps the picker open', await picker.isVisible());
  await tile.locator('button[data-icon-id]').click();
  await picker.waitFor({ state: 'hidden' });
  await until(async () => (await row.locator('img').getAttribute('src') ?? '').includes('/custom-icons/'), { label: 'custom provider mark' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openPicker();
  await tile.waitFor({ state: 'visible' });
  check('custom selection survives reload and allows referenced deletion', await tile.getByRole('button', { name: 'Delete', exact: true }).isEnabled());
  const previousURL = await row.locator('img').getAttribute('src');
  await tile.getByRole('button', { name: 'Edit', exact: true }).click();
  await picker.getByLabel('Icon name', { exact: true }).fill('Team Replaced');
  await picker.locator('input[type="file"]').setInputFiles({ name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('not an image') });
  await picker.getByText('Choose a valid static image.', { exact: false }).waitFor({ state: 'visible' });
  check('an invalid replacement cannot be saved as a rename', await picker.getByRole('button', { name: 'Save icon', exact: true }).isDisabled());
  await picker.getByRole('button', { name: 'Keep current artwork', exact: true }).click();
  await picker.getByText('Paste Base64', { exact: true }).click();
  await picker.locator('textarea').fill(Buffer.from('<svg><circle r="5"/></svg>').toString('base64'));
  await picker.getByRole('button', { name: 'Validate and preview', exact: true }).click();
  await picker.locator('img[alt="Validate and preview"]').waitFor({ state: 'visible' });
  await until(async () => await picker.locator('img[alt="Validate and preview"]').evaluate((image) => image.complete && image.naturalWidth > 0), { label: 'validated preview artwork to paint' });
  await picker.getByRole('button', { name: 'Save icon', exact: true }).click();
  await picker.getByText('The icon operation failed. Try again.', { exact: true }).waitFor({ state: 'visible' });
  check('failed saves preserve name and validated artwork for retry', await picker.getByLabel('Icon name', { exact: true }).inputValue() === 'Team Replaced' && await picker.locator('img[alt="Validate and preview"]').isVisible());
  await picker.getByRole('button', { name: 'Save icon', exact: true }).click();
  await tile.getByText('Team Replaced', { exact: true }).waitFor({ state: 'visible' });
  await until(async () => await row.locator('img').getAttribute('src') !== previousURL, { label: 'replacement to repaint the live provider row' });
  check('Base64 replacement updates a live reference without reselecting it', await row.locator('img').getAttribute('src') !== previousURL);
  await tile.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmation = picker.getByTestId('custom-icon-deletion');
  await confirmation.waitFor({ state: 'visible' });
  check('deletion explains reference resets and initially focuses Cancel', await confirmation.getByText(/This icon has 1 references/).isVisible() && await confirmation.getByRole('button', { name: 'Cancel', exact: true }).evaluate((element) => element === document.activeElement));
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tile.waitFor({ state: 'visible' });
  check('cancelling deletion preserves the asset and assignments', (await row.locator('img').getAttribute('src')).includes('/custom-icons/'));
  await tile.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmation.getByRole('button', { name: /^Delete/ }).click();
  await confirmation.getByText('The icon operation failed. Try again.', { exact: true }).waitFor({ state: 'visible' });
  check('failed deletion retains confirmation and the provider artwork', await confirmation.isVisible() && (await row.locator('img').getAttribute('src')).includes('/custom-icons/'));
  await confirmation.getByRole('button', { name: /^Delete/ }).click();
  await tile.waitFor({ state: 'hidden' });
  await until(async () => !(await row.locator('img').getAttribute('src') ?? '').includes('/custom-icons/'), { label: 'deleted reference to restore the provider default' });
  check('referenced deletion restores the live provider default', await tile.count() === 0);
  const empty = picker.getByTestId('custom-icons-empty');
  await empty.waitFor({ state: 'visible' });
  check('the empty state spans the library, rather than one tile', await empty.evaluate((element) => element.getBoundingClientRect().width > 500));
  await until(async () => await picker.getByRole('button', { name: 'Add icon' }).evaluate((element) => element === document.activeElement), { label: 'focus restoration after deletion' });
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'hidden' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await row.waitFor({ state: 'visible' });
  check('reference resets persist after reload', !(await row.locator('img').getAttribute('src') ?? '').includes('/custom-icons/'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Add Provider' }).click();
  const drawer = page.locator('.ant-drawer-open');
  await drawer.waitFor({ state: 'visible' });
  await drawer.locator('[title="Change Icon"]').click();
  await picker.waitFor({ state: 'visible' });
  await picker.getByText('Custom', { exact: true }).click();
  const geometry = await picker.evaluate((element) => ({ width: element.getBoundingClientRect().width, viewport: innerWidth }));
  check('the custom library fits a phone above the provider drawer', geometry.width <= geometry.viewport);
  await picker.getByRole('button', { name: 'Add icon', exact: true }).click();
  await picker.getByLabel('Icon name', { exact: true }).waitFor({ state: 'visible' });
  await picker.getByRole('button', { name: 'Save icon', exact: true }).scrollIntoViewIfNeeded();
  check('the narrow editor has no horizontal overflow and keeps Save reachable', await picker.evaluate((element) => element.scrollWidth <= element.clientWidth) && await picker.getByRole('button', { name: 'Save icon', exact: true }).isVisible());
  await picker.getByRole('button', { name: 'Back to icons', exact: true }).click();
  await until(async () => await picker.getByRole('button', { name: 'Add icon', exact: true }).evaluate((element) => element === document.activeElement), { label: 'focus restoration from the narrow editor' });
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'hidden' });
  check('dismissal leaves the underlying provider drawer open', await drawer.isVisible());
  await drawer.getByRole('button', { name: 'Change Icon', exact: true }).click();
  await picker.getByText('Custom', { exact: true }).click();
  await picker.getByRole('button', { name: 'Add icon', exact: true }).click();
  await picker.getByLabel('Icon name', { exact: true }).fill('Draft Icon');
  await picker.locator('input[type="file"]').setInputFiles({ name: 'draft.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="8" cx="10" cy="10"/></svg>') });
  await until(async () => await picker.locator('img[alt="Validate and preview"]').evaluate((image) => image.complete && image.naturalWidth > 0), { label: 'draft artwork preview' });
  await picker.getByRole('button', { name: 'Save icon', exact: true }).click();
  await tile.locator('button[data-icon-id]').click();
  await picker.waitFor({ state: 'hidden' });
  const draftArtwork = drawer.locator('[title="Change Icon"]');
  await until(async () => (await draftArtwork.locator('img').getAttribute('src') ?? '').includes('/custom-icons/'), { label: 'custom artwork in the provider draft' });
  await drawer.getByRole('button', { name: 'Change Icon', exact: true }).click();
  await tile.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmation.waitFor({ state: 'visible' });
  check('narrow deletion explains the unused draft without overflowing', await confirmation.getByText('This icon is not in use.', { exact: false }).isVisible() && await picker.evaluate((element) => element.scrollWidth <= element.clientWidth));
  await confirmation.getByRole('button', { name: /^Delete/ }).click();
  await picker.getByTestId('custom-icons-empty').waitFor({ state: 'visible' });
  await until(async () => await draftArtwork.locator('img[src*="/custom-icons/"]').count() === 0, { label: 'deleted draft artwork to reset' });
  check("deletion also clears a provider drawer's unsaved icon selection", await draftArtwork.locator('img[src*="/custom-icons/"]').count() === 0);
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'hidden' });
}
