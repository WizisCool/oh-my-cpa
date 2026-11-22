/**
 * The request list over the seeded database: the rows render, the server owns the window
 * end even when the browser's clock is behind, and a provider key appears only as its
 * mask, on the row it answered and nowhere else.
 */
import { maskKeyText } from '../../web/src/utils/maskKey.ts';
import { FAKE_PROVIDER_SECRET } from '../fake-cpa.mjs';

export async function runRequestListAcceptance({ appURL, page, check }) {
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15_000 });

  // The list is virtualized, so only the visible window of rows is in the DOM;
  // the footer reports the real page size.
  const visibleRows = await page.locator('.request-row').count();
  const footerText = await page.locator('.request-pagination span').first().innerText();
  check('request list renders seeded records', visibleRows >= 2, `visibleRows=${visibleRows}`);
  check('the whole seeded page is loaded', /50/.test(footerText), `footer="${footerText}"`);

  // Column visibility is a saved presentation preference, not responsive folding.
  // Hide Model at a wide viewport, reload the compiled app, and restore it.
  const viewportBeforeColumns = page.viewportSize();
  await page.setViewportSize({ width: 1750, height: 900 });
  try {
    const chooser = page.locator('.req-manage-columns-btn');
    check('column chooser trigger carries the outlined columns icon',
      (await chooser.locator('svg').count()) === 1);
    await chooser.click();
    const menu = page.locator('.req-column-menu');
    check('column chooser reuses the project floating-panel transition',
      await menu.evaluate((element) =>
        element.classList.contains('omc-float-surface') &&
        getComputedStyle(element).transitionProperty.includes('clip-path')));
    check('column chooser presents its minimum-selection note alongside the heading',
      await menu.locator('.req-column-heading').evaluate((element) =>
        element.children.length === 2 &&
        element.lastElementChild?.classList.contains('req-column-hint') &&
        element.firstElementChild?.textContent?.trim().length > 0 &&
        !/automatically|自动保存|自動儲存/i.test(element.textContent ?? '')));
    check('column options use one vertical scrollable list',
      await menu.locator('.req-column-choices').evaluate((element) =>
        getComputedStyle(element).flexDirection === 'column' &&
        getComputedStyle(element).overflowY === 'auto') &&
      (await menu.locator('.req-column-choice-row').count()) === 12);
    await menu.locator('.req-column-choice-row [data-reorder-handle]').first().waitFor({ state: 'visible', timeout: 5_000 });
    check('every column has a distinct draggable handle',
      (await menu.locator('.req-column-choice-row [data-reorder-handle]').count()) === 12);
    check('column animation keeps the request table continuously visible',
      await page.locator('.request-table-scroll-area').evaluate((element) =>
        getComputedStyle(element).opacity === '1' &&
        getComputedStyle(element).viewTransitionName === 'none'));

    // Observe the actual Web Animations API calls, not only the final positions:
    // the leaving column fades, persistent cells glide, newly shown cells fade in.
    await page.evaluate(() => {
      const original = Element.prototype.animate;
      const evidence = { enter: 0, exit: 0, glide: 0, movingHeader: 0, movingRows: 0, duration: [] };
      window.__columnMotionEvidence = evidence;
      Element.prototype.animate = function (frames, options) {
        if (Array.isArray(frames) &&
            (this.classList.contains('req-th') || this.classList.contains('req-col'))) {
          if (frames[0]?.opacity === 1 && frames[1]?.opacity === 0) evidence.exit++;
          if (frames[0]?.opacity === 0 && frames[1]?.opacity === 1) evidence.enter++;
          if (typeof frames[0]?.transform === 'string' && frames[0].transform.startsWith('translateX(')) {
            evidence.glide++;
            if (this.classList.contains('req-th')) evidence.movingHeader++;
            if (this.classList.contains('req-col')) evidence.movingRows++;
            evidence.duration.push(options?.duration);
          }
        }
        return original.call(this, frames, options);
      };
    });
    const buttons = await page.locator('.request-actions .req-toolbar-action').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          height: box.height,
          width: box.width,
          radius: getComputedStyle(element).borderRadius,
          iconOnly: element.hasAttribute('data-icon-only'),
        };
      }));
    check('column chooser and three tool icons share equal heights and corner radii',
      buttons.length === 4 &&
      buttons.every((button) => Math.abs(button.height - 32) < 0.6 &&
        button.radius === buttons[0].radius) &&
      buttons.slice(1).every((button) => button.iconOnly &&
        Math.abs(button.width - 32) < 0.6) &&
      buttons[0].width > 32);
    const isChooserOnTop = async () => menu.evaluate((element) => {
      const checkbox = element.querySelectorAll('[data-slot="checkbox"]')[3];
      if (!checkbox) return false;
      const box = checkbox.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit instanceof Element && element.contains(hit);
    });
    const columnChecks = page.locator('.req-column-choice [data-slot="checkbox"]');
    check('column chooser uses 12 accessible project checkboxes',
      (await columnChecks.count()) === 12 &&
      (await columnChecks.nth(3).getAttribute('role')) === 'checkbox');
    const modelToggle = columnChecks.nth(3);
    check('the model column is visible by default',
      (await modelToggle.getAttribute('aria-checked')) === 'true');
    check('column checkmarks use opacity-only motion',
      await modelToggle.locator('.omc-mark-pop').evaluate((element) => {
        const style = getComputedStyle(element);
        return style.transitionProperty === 'opacity' && style.transform === 'none';
      }));
    const saveHidden = page.waitForResponse((response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/api/v1/preferences/usage_events_hidden_columns') &&
      response.ok(),
    );
    await modelToggle.click();
    await saveHidden;
    check('model checkbox responds immediately to an uncheck',
      (await modelToggle.getAttribute('aria-checked')) === 'false');
    check('column chooser remains on top while the table updates',
      await isChooserOnTop());
    await page.waitForFunction(() =>
      window.__columnMotionEvidence?.glide > 0 &&
      document.querySelector('.request-stream')?.getAttribute('data-folded-columns')?.split(' ').includes('model'));
    check('the departing column fades and the existing columns glide into position',
      await page.evaluate(() => {
        const evidence = window.__columnMotionEvidence;
        return evidence.exit > 0 && evidence.glide > 0 &&
          evidence.movingHeader > 0 && evidence.movingRows > 0 &&
          evidence.duration.every((duration) => duration === 320);
      }));
    check('table remains fully opaque while columns glide',
      await page.locator('.request-table-scroll-area').evaluate((element) =>
        getComputedStyle(element).opacity === '1'));
    check('column chooser stays interactive after layout settles',
      await isChooserOnTop());
    // Reversing the gesture before a transition finishes must preserve state.
    const savedAgain = page.waitForResponse((response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/api/v1/preferences/usage_events_hidden_columns') &&
      response.ok(),
    );
    await modelToggle.click();
    await savedAgain;
    check('rapid re-toggle restores checked state',
      (await modelToggle.getAttribute('aria-checked')) === 'true');
    await page.waitForFunction(() => window.__columnMotionEvidence?.enter > 0);
    check('returning column fades in while neighbors make room',
      await page.evaluate(() =>
        window.__columnMotionEvidence.enter > 0 &&
        window.__columnMotionEvidence.glide > 0));
    const savedHiddenAgain = page.waitForResponse((response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/api/v1/preferences/usage_events_hidden_columns') &&
      response.ok(),
    );
    await modelToggle.click();
    await savedHiddenAgain;
    check('second rapid toggle hides the column again',
      (await modelToggle.getAttribute('aria-checked')) === 'false');
    check('column chooser retains the top interaction layer after repeated toggles',
      await isChooserOnTop());
    await page.waitForFunction(() =>
      document.querySelector('.request-stream')?.getAttribute('data-folded-columns')?.split(' ').includes('model'));
    check('hiding Model removes its header and row cell from the desktop grid',
      await page.locator('.req-th-model').isHidden() &&
      await page.locator('.request-row .req-col-model').first().isHidden());

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.req-manage-columns-btn').click();
    check('column visibility survives page reload',
      (await page.locator('.req-column-choice [data-slot="checkbox"]').nth(3).getAttribute('aria-checked')) === 'false');
    const saveRestored = page.waitForResponse((response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/api/v1/preferences/usage_events_hidden_columns') &&
      response.ok(),
    );
    await page.getByRole('button', { name: /Show all columns|显示全部列|顯示全部欄位|Tunjukkan semua lajur/ }).click();
    await saveRestored;
    await page.locator('.req-th-model').waitFor({ state: 'visible', timeout: 5_000 });
    check('restoring visible columns returns the Model header',
      await page.locator('.req-th-model').isVisible());
    // Reorder from the menu, verify table header and row DOM placement and the
    // persisted preference, then check keyboard steps and reload restoration.
    const beforeOrder = await menu.locator('.req-column-choice-row').evaluateAll((rows) =>
      rows.map((element) => element.getAttribute('data-reorder-key')));
    check('column picker initially follows the catalog order',
      beforeOrder[0] === 'time' && beforeOrder[3] === 'model');
    const saveOrder = page.waitForResponse((response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/api/v1/preferences/usage_events_column_order') &&
      response.ok(),
    );
    await menu.locator('[data-reorder-key="model"] [data-reorder-handle]').dragTo(
      menu.locator('[data-reorder-key="time"]'),
    );
    const orderResponse = await saveOrder;
    const storedOrder = await orderResponse.json();
    check('dragging persists the full column order',
      storedOrder?.value?.columns?.[0] === 'model' &&
      storedOrder?.value?.columns?.length === 12);
    await page.waitForFunction(() =>
      document.querySelector('.req-column-choice-row')?.getAttribute('data-reorder-key') === 'model');
    check('menu order and table DOM order agree after dragging',
      await page.evaluate(() =>
        document.querySelector('.req-column-choice-row')?.getAttribute('data-reorder-key') === 'model' &&
        document.querySelector('.request-table-header .req-th:not(.req-th-select)')?.classList.contains('req-th-model') &&
        document.querySelector('.request-row .req-col')?.classList.contains('req-col-model')));
    check('reordered columns are placed left-to-right in the desktop grid',
      await page.evaluate(() => {
        const model = document.querySelector('.req-th-model')?.getBoundingClientRect();
        const time = document.querySelector('.req-th-time')?.getBoundingClientRect();
        return model && time && model.left < time.left;
      }));
    const saveKeyboardOrder = page.waitForResponse((response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/api/v1/preferences/usage_events_column_order') &&
      response.ok(),
    );
    await menu.locator('[data-reorder-key="model"] [data-reorder-handle]').focus();
    await page.keyboard.press('ArrowDown');
    await saveKeyboardOrder;
    await page.waitForFunction(() =>
      document.querySelectorAll('.req-column-choice-row')[1]?.getAttribute('data-reorder-key') === 'model');
    check('keyboard down arrow reorders one item and table tracks together',
      await page.locator('.request-table-header').evaluate((header) =>
        header.children[1]?.classList.contains('req-th-time') &&
        header.children[2]?.classList.contains('req-th-model')));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.req-manage-columns-btn').click();
    await page.waitForFunction(() =>
      document.querySelectorAll('.req-column-choice-row')[1]?.getAttribute('data-reorder-key') === 'model');
    check('custom order survives reload in both picker and request rows',
      await page.evaluate(() =>
        document.querySelectorAll('.req-column-choice-row')[1]?.getAttribute('data-reorder-key') === 'model' &&
        document.querySelectorAll('.request-row .req-col')[1]?.classList.contains('req-col-model')));
    // Leave shared browser fixtures in the default layout for later checks.
    for (let step = 0; step < 2; step++) {
      const restoreOrder = page.waitForResponse((response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.endsWith('/api/v1/preferences/usage_events_column_order') &&
        response.ok(),
      );
      await page.locator('[data-reorder-key="model"] [data-reorder-handle]').focus();
      await page.keyboard.press('ArrowDown');
      await restoreOrder;
    }
    check('keyboard moves restore the default layout',
      await page.locator('.req-column-choice-row').evaluateAll((rows) =>
        rows[0]?.getAttribute('data-reorder-key') === 'time' &&
        rows[1]?.getAttribute('data-reorder-key') === 'result' &&
        rows[2]?.getAttribute('data-reorder-key') === 'provider' &&
        rows[3]?.getAttribute('data-reorder-key') === 'model'));

  } finally {
    if (viewportBeforeColumns) await page.setViewportSize(viewportBeforeColumns);
  }

  // A browser whose clock runs behind the server's must still see the newest
  // records. The list used to resolve its window's end on the browser's clock, so
  // every record newer than that clock was filtered out and stayed out through any
  // number of refreshes. The seeder stamps records on the server's clock, the
  // newest a few minutes ago, so a half-hour lag hid most of them.
  const skewMs = 30 * 60_000;
  const skewedPage = await page.context().newPage();
  try {
    await skewedPage.addInitScript((offset) => {
      const readClock = Date.now.bind(Date);
      Date.now = () => readClock() - offset;
    }, skewMs);
    const listRead = skewedPage.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/api/v1/usage/events') && response.ok(),
      { timeout: 15_000 },
    );
    await skewedPage.goto(`${appURL}/usage/events?preset=1h`, { waitUntil: 'domcontentloaded' });
    const response = await listRead;
    const sent = new URL(response.url()).searchParams;
    check(
      'a preset read leaves the window end to the server',
      sent.get('preset') === '1h' && !sent.has('from') && !sent.has('to'),
      `query=${sent.toString()}`,
    );
    const body = await response.json();
    const newestMs = Math.max(0, ...(body.items ?? []).map((item) => item.timestamp_ms));
    check(
      'a browser clock running behind the server still lists the newest records',
      newestMs > Date.now() - skewMs,
      `newest=${new Date(newestMs).toISOString()} items=${body.items?.length ?? 0}`,
    );
  } finally {
    await skewedPage.close();
  }

  // Returning through SPA navigation reuses the catalog while a fresh real server
  // read is held. Request identities must remain resolved throughout that read.
  await page.waitForFunction(() => document.querySelectorAll('.request-row .req-badge-unresolved').length === 0);
  await page.locator('[data-route-path="/logs"]').first().click();
  await page.locator('.logs-page .logs-toolbar').waitFor({ state: 'visible', timeout: 15_000 });
  let releaseCatalog;
  const catalogGate = new Promise((resolve) => { releaseCatalog = resolve; });
  const catalogRead = page.waitForRequest('**/api/v1/management/identity-directory', { timeout: 15_000 });
  const holdCatalog = async (route) => {
    await catalogGate;
    await route.fallback();
  };
  await page.route('**/api/v1/management/identity-directory', holdCatalog);
  try {
    await page.locator('[data-route-path="/usage/events"]').first().click();
    await catalogRead;
    await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15_000 });
    const unresolvedCount = await page.locator('.request-row .req-badge-unresolved').count();
    check('returning to request records keeps cached provider identities during a catalog refresh', unresolvedCount === 0, `unconfirmed rows=${unresolvedCount}`);
  } finally {
    releaseCatalog();
    await page.unroute('**/api/v1/management/identity-directory', holdCatalog);
  }

  // ---- which of the provider's keys answered ----
  // The fixture carries one record answered by a credential the fake CPA
  // configures, and one whose auth index nothing claims. The first must print the
  // mask of that credential's key, the second must print no key line at all: a
  // request the console cannot attribute must stay silent rather than guess.
  const keyRow = page.locator('.request-row').filter({ hasText: 'fixture-provider-key' }).first();
  await keyRow.waitFor({ state: 'visible', timeout: 15_000 });
  const providerKeyText = await keyRow.locator('.req-provider-key').innerText();
  const expectedMask = maskKeyText(FAKE_PROVIDER_SECRET);
  check(
    "a request row names the provider key that answered it",
    providerKeyText === expectedMask,
    `provider key cell="${providerKeyText}" expected="${expectedMask}"`,
  );
  check(
    'the provider key cell carries the mask and nothing else',
    !providerKeyText.includes(FAKE_PROVIDER_SECRET),
    `provider key cell="${providerKeyText}"`,
  );
  const attributedRowText = await keyRow.innerText();
  check(
    'the attributed row itself carries no provider key',
    !attributedRowText.includes(FAKE_PROVIDER_SECRET),
    `row text="${attributedRowText.slice(0, 200)}"`,
  );
  const unattributedRow = page.locator('.request-row').filter({ hasText: 'fixture-provider-key-absent' }).first();
  await unattributedRow.waitFor({ state: 'visible', timeout: 15_000 });
  check(
    'an unattributable request prints no provider key',
    (await unattributedRow.locator('.req-provider-key').count()) === 0,
    `key cells on that row=${await unattributedRow.locator('.req-provider-key').count()}`,
  );
  // An OAuth record has no provider key: its credential is the account the row
  // already names, so the key line must not appear on it either.
  const oauthRow = page.locator('.request-row').filter({ hasText: 'fixture-plugin-provider' }).first();
  check(
    'an OAuth request prints no provider key',
    (await oauthRow.locator('.req-provider-key').count()) === 0,
    `key cells on that row=${await oauthRow.locator('.req-provider-key').count()}`,
  );
}
