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
