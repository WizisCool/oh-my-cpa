import { pastDeadline, until } from '../harness.mjs';

/**
 * The dashboard arrangement: the operator orders, sizes and hides the dashboard's widgets, and the
 * board keeps what they chose.
 *
 * The rules about a stored arrangement are pinned by the logic suite (`test-dashboard-layout.ts`).
 * What needs a browser is that the pieces agree: the board draws the stored order and sizes, the
 * editor's drag, step, resize and hide controls change the board on the frame they are used, nothing
 * is written until Done, Cancel throws a draft away, a reload keeps the stored arrangement, and
 * Restore default puts the catalog back.
 *
 * The drag and the resize are real pointer gestures through Playwright's mouse rather than synthetic
 * events, so the handle being the only way to pick a widget up, the travel a drag needs before it
 * starts, and the grid the resize snaps to are all part of the claim.
 */
export async function dashboardLayout({ base, page, check }) {
  const preferences = {};
  const writes = [];
  const layoutWrites = () => writes.filter((write) => write.key === 'omc_dashboard_layout');
  await page.route('**/omc/api/**/preferences', (route) => route.fulfill({
    json: { preferences, time_zone: { server_timezone: 'UTC' } },
  }));
  await page.route('**/omc/api/**/preferences/*', async (route) => {
    if (route.request().method() === 'PUT') {
      const key = new URL(route.request().url()).pathname.split('/').pop();
      writes.push({ key, body: route.request().postData() });
      preferences[key] = JSON.parse(route.request().postData());
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fallback();
  });

  const cells = () => page.locator('[data-testid="dashboard-board"] > .dashboard-cell');
  const order = () => cells().evaluateAll((nodes) => nodes.map((node) => node.dataset.widget));
  const cell = (id) => page.locator(`[data-testid="dashboard-board"] > [data-widget="${id}"]`);
  const widthOf = async (id) => (await cell(id).boundingBox())?.width ?? 0;
  const arrange = async () => {
    await page.getByTestId('dashboard-layout-arrange').click();
    await page.getByTestId('dashboard-layout-tray').waitFor();
  };
  const done = async () => {
    const button = page.getByTestId('dashboard-layout-done');
    // The reordered DOM can settle before the drag's click guard releases. Observe delivery at
    // the button without invoking Save, then exercise the action with one real pointer click.
    await until(() => button.evaluate((node) => {
      let hasReceivedClick = false;
      const receive = (event) => {
        hasReceivedClick = true;
        event.stopImmediatePropagation();
      };
      node.addEventListener('click', receive, { capture: true });
      try {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return hasReceivedClick;
      } finally {
        node.removeEventListener('click', receive, { capture: true });
      }
    }), { label: 'Done to receive clicks after the drag' });
    await button.click();
    await page.getByTestId('dashboard-layout-tray').waitFor({ state: 'detached' });
  };
  const open = async () => {
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await cell('requests').waitFor({ timeout: 20_000 });
  };

  await open();
  const initial = await order();
  check('a console with no arrangement draws the catalog order',
    initial[0] === 'requests' && initial[1] === 'tokens' && initial.includes('cost') && initial.at(-1) === 'providers',
    initial.join(','));

  // Arranging is a mode: until it is entered there is no handle on the page.
  check('the board carries no editing chrome while it is read', await page.getByTestId('dashboard-layout-tray').count() === 0);

  // A selection is card state the arrangement must not disturb: the card holding it can leave the
  // board, and the card beside it keeps naming the same model.
  const usageSelection = page.locator('.model-usage-name-button').first();
  await usageSelection.waitFor();
  const selectedModel = await usageSelection.locator('.model-series-text').textContent();
  await usageSelection.click();
  await until(async () => await usageSelection.getAttribute('aria-pressed') === 'true', { label: 'a model selected on the usage card' });
  const trendSelection = () => cell('model_trend').locator('[data-testid="model-trend-legend"] button[aria-pressed="true"] .model-series-text');
  const restoredSelection = () => page.locator('.model-usage-name-button[aria-pressed="true"] .model-series-text');

  await arrange();
  const inertState = await cell('requests').evaluate((node) => ({
    inert: node.querySelectorAll('[inert]').length,
    html: node.outerHTML.slice(0, 400),
  }));
  check('the widgets under the editing chrome take no input', inertState.inert === 1, JSON.stringify(inertState));

  // Hide, resize, step and drag, each answered on the board before anything is stored.
  await page.locator('[data-widget-hide="cost"]').click();
  await until(async () => (await cell('cost').count()) === 0, { label: 'the cost tile to leave the board' });
  check('a hidden widget leaves the board and waits in the tray',
    await page.locator('[data-widget-restore="cost"]').count() === 1);

  // The usage card carries the model grouping toggle; hiding it moves the toggle to the trend card,
  // so the trend's grouping stays reachable.
  const trendToggles = () => cell('model_trend').locator('.model-view-toggle').count();
  const togglesWithUsage = await trendToggles();
  await page.locator('[data-widget-hide="model_usage"]').click();
  await until(async () => (await cell('model_usage').count()) === 0, { label: 'the usage card to leave the board' });
  await until(async () => (await trendToggles()) === 1, { label: 'the grouping toggle on the trend card' });
  check('the trend card takes the grouping toggle only while the usage card is hidden', togglesWithUsage === 0);
  await until(async () => (await trendSelection().count()) === 1, { label: 'the trend card to keep the shared selection' });
  check('hiding the usage card leaves its selected model selected on the trend card',
    await trendSelection().textContent() === selectedModel);
  await page.locator('[data-widget-restore="model_usage"]').click();
  await until(async () => (await trendToggles()) === 0, { label: 'the grouping toggle back on the usage card' });
  await until(async () => (await restoredSelection().count()) === 1, { label: 'the usage card to show the shared selection again' });
  check('restoring the usage card returns the shared selection', await restoredSelection().textContent() === selectedModel);

  const quarter = await widthOf('tpm');
  // The corner grip sizes on the board's grid: dragged one column right and down, the widget snaps
  // to the next width and to whole rows, and the board reflows as it goes.
  const rowsBefore = Number(await cell('rpm').getAttribute('data-rows'));
  const heightBefore = (await cell('rpm').boundingBox()).height;
  await cell('rpm').hover();
  const corner = await cell('rpm').locator('[data-resize="xy"]').boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + quarter * 0.9, corner.y + corner.height / 2 + 125, { steps: 12 });
  await until(async () => (await cell('rpm').getAttribute('data-span')) === '2', { label: 'the RPM tile to widen' });
  check('a resize reads out the size it has reached', /^1\/2 · \d+ rows$/.test((await page.locator('[class*="size-badge"]').textContent()) ?? ''));
  await page.mouse.up();
  const half = await widthOf('rpm');
  const rowsAfter = Number(await cell('rpm').getAttribute('data-rows'));
  check('the corner grip widens the widget a column', half > quarter * 1.8, `rpm=${half} tpm=${quarter}`);
  check('the corner grip makes the widget taller by whole rows',
    rowsAfter === rowsBefore + 3 && (await cell('rpm').boundingBox()).height > heightBefore + 100, `${rowsBefore} -> ${rowsAfter}`);
  // The corner grip also takes the arrow keys, and a screen reader hears the size each one reaches,
  // a limit included: the region is cleared and written again, so even unchanged text is re-read.
  const announcement = page.getByTestId('dashboard-size-announcement');
  const grip = cell('rpm').locator('[data-resize="xy"]');
  await grip.focus();
  await page.keyboard.press('ArrowDown');
  await until(async () => (await announcement.textContent()) === `RPM: 1/2 · ${rowsAfter + 1} rows`, { label: 'the keyboard resize announcement' });
  await page.keyboard.press('ArrowUp');
  await until(async () => (await announcement.textContent()) === `RPM: 1/2 · ${rowsAfter} rows`, { label: 'the size back where it was' });
  await announcement.evaluate((node) => {
    window.__announcements = [];
    new MutationObserver(() => window.__announcements.push(node.textContent)).observe(node, { childList: true, characterData: true, subtree: true });
  });
  // Narrowed to the board's narrowest span and pressed past it, the text stays the same, so only
  // the clear makes the second press heard.
  const narrowest = /^RPM: 1\/4 · \d+ rows$/;
  const narrowestCount = async () => (await page.evaluate(() => window.__announcements)).filter((text) => narrowest.test(text)).length;
  await page.keyboard.press('ArrowLeft');
  await until(async () => (await narrowestCount()) === 1, { label: 'the narrowest span announced' });
  await page.keyboard.press('ArrowLeft');
  await until(async () => (await narrowestCount()) === 2, { label: 'the narrowest span announced again at the limit' });
  const sequence = await page.evaluate(() => window.__announcements);
  check('a keyboard resize is announced in a region that stays mounted, again at a limit',
    sequence.filter((text) => narrowest.test(text)).length >= 2 && sequence.filter((text) => text === '').length >= 2,
    JSON.stringify(sequence));
  await page.keyboard.press('ArrowRight');
  await until(async () => (await cell('rpm').getAttribute('data-span')) === '2', { label: 'the RPM tile back at half width' });
  // Dragged far above its content, the bottom edge stops where the content still fits.
  const bottom = await cell('rpm').locator('[data-resize="y"]').boundingBox();
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y - 600, { steps: 10 });
  await page.mouse.up();
  const shrunk = Number(await cell('rpm').getAttribute('data-rows'));
  const fit = await cell('rpm').evaluate((node) => {
    const box = node.getBoundingClientRect().height;
    node.style.alignSelf = 'start';
    const content = node.getBoundingClientRect().height;
    node.style.alignSelf = '';
    return { box, content };
  });
  check('a widget is never made shorter than its content',
    shrunk < rowsAfter && fit.content <= fit.box + 0.5 && fit.box - fit.content < 40, JSON.stringify({ shrunk, ...fit }));
  // A widget fitted to its content is taller than its rows, so a nudge must count from the rows it
  // has: reading the box instead took a few pixels' drag upward for a whole row more. The tile's
  // content is held 34px past its rows - just under a step - so the box reads as most of a row more.
  await cell('rpm').evaluate((node, rows) => { node.style.minHeight = `${rows * 40 - 16 + 34}px`; }, shrunk);
  const nudge = await cell('rpm').locator('[data-resize="y"]').boundingBox();
  await page.mouse.move(nudge.x + nudge.width / 2, nudge.y + nudge.height / 2);
  await page.mouse.down();
  await page.mouse.move(nudge.x + nudge.width / 2, nudge.y + nudge.height / 2 - 6, { steps: 3 });
  await page.mouse.up();
  check('a small drag on a fitted widget keeps its rows', Number(await cell('rpm').getAttribute('data-rows')) === shrunk,
    `${shrunk} -> ${await cell('rpm').getAttribute('data-rows')}`);
  await cell('rpm').evaluate((node) => { node.style.minHeight = ''; });

  await cell('requests').getByRole('button', { name: /^Move later/ }).click();
  await until(async () => (await order())[0] === 'tokens', { label: 'the requests tile to step later' });
  check('a step moves a widget one place in the reading order', (await order()).slice(0, 2).join(',') === 'tokens,requests');
  check('reordering the board keeps the shared model selection',
    await trendSelection().count() === 1 && await restoredSelection().count() === 1
      && await trendSelection().textContent() === selectedModel
      && await restoredSelection().textContent() === selectedModel);

  // Both cells are on the first row, so the drag never has to scroll the page under the pointer.
  await cell('tpm').locator('[data-drag-handle]').dragTo(cell('tokens'), { targetPosition: { x: 8, y: 40 }, steps: 12 });
  await until(async () => (await order())[0] === 'tpm', { label: 'the TPM tile to be dragged first' });
  check('a drag places the widget where it is dropped', (await order()).slice(0, 2).join(',') === 'tpm,tokens', (await order()).join(','));
  check('nothing is stored while the operator is still arranging', layoutWrites().length === 0);

  await done();
  await until(() => layoutWrites().length === 1, { label: 'the arrangement write' });
  const stored = JSON.parse(layoutWrites()[0].body);
  const storedItem = (id) => stored.find((entry) => entry.id === id);
  check('Done stores the arrangement as one ordered document',
    stored[0].id === 'tpm' && storedItem('cost').hidden === true && storedItem('rpm').span === 2 && storedItem('rpm').rows === shrunk,
    layoutWrites()[0].body);

  await open();
  const reloaded = await order();
  check('a reloaded dashboard keeps the order, widths and hidden widgets',
    reloaded[0] === 'tpm' && !reloaded.includes('cost') && (await cell('rpm').getAttribute('data-span')) === '2',
    reloaded.join(','));

  // Cancel is just dropping the draft.
  await arrange();
  await page.locator('[data-widget-hide="tokens"]').click();
  await until(async () => (await cell('tokens').count()) === 0, { label: 'the tokens tile to leave the draft' });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('dashboard-layout-tray').waitFor({ state: 'detached' });
  check('Cancel discards the draft without writing', (await cell('tokens').count()) === 1 && layoutWrites().length === 1);

  // Restore default puts the catalog back, hidden widgets included.
  await arrange();
  await page.getByTestId('dashboard-layout-reset').click();
  await done();
  await until(() => layoutWrites().length === 2, { label: 'the restored arrangement write' });
  const restored = await order();
  check('Restore default puts back the catalog order and every widget',
    restored.join(',') === initial.join(','), restored.join(','));

  // With motion on, the widgets a change moved glide to their new places at their own size, and a
  // hidden widget fades where it stood while it is already off the board.
  // Turned on the way an operator does, with the console's own setting, which outranks the system's.
  preferences.omc_reduced_motion = 'off';
  await open();
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'false');
  await arrange();
  const [first, second] = restored;
  const stepping = sampleBoard(page, [first, second]);
  await cell(first).getByRole('button', { name: /^Move later/ }).click();
  const stepped = await stepping;
  const xs = (id) => stepped.map((frame) => frame.cells[id]?.x).filter((x) => x !== undefined);
  const widths = (id) => stepped.map((frame) => frame.cells[id]?.width).filter((width) => width !== undefined);
  check('a widget a step moves glides to its new place', glides(xs(first)), JSON.stringify(xs(first).map(Math.round)));
  check('the widget it passes glides the other way', glides(xs(second)), JSON.stringify(xs(second).map(Math.round)));
  check('a gliding widget keeps its size', [first, second].every((id) => Math.max(...widths(id)) - Math.min(...widths(id)) < 1),
    JSON.stringify([first, second].map((id) => [Math.min(...widths(id)), Math.max(...widths(id))].map(Math.round))));

  const hiding = sampleBoard(page, [first, second]);
  await page.locator(`[data-widget-hide="${second}"]`).click();
  const hid = await hiding;
  const fades = hid.map((frame) => frame.leavingOpacity).filter((opacity) => opacity !== null);
  check('a hidden widget fades where it stood', fades.some((opacity) => opacity > 0.05 && opacity < 0.95), JSON.stringify(fades.map((opacity) => opacity.toFixed(2))));
  const afterHide = hid.filter((frame) => frame.restorable.includes(second));
  check('a fading widget is already off the board', afterHide.length > 0 && afterHide.every((frame) => !frame.ids.includes(second)));
  check('the widget beside it glides into the space', glides(hid.map((frame) => frame.cells[first]?.x).filter((x) => x !== undefined)));

  // A drag still draws its own glides with motion on, and the drop lands where the hand let go.
  const [lead, , third] = (await order()).filter(Boolean);
  await cell(third).locator('[data-drag-handle]').dragTo(cell(lead), { targetPosition: { x: 8, y: 40 }, steps: 12 });
  await until(async () => (await order())[0] === third, { label: 'the dragged widget to lead the board' });
  const landed = await cell(third).boundingBox();
  await pastDeadline(300);
  const rested = await cell(third).boundingBox();
  check('with motion on, a dropped widget stays where it landed',
    Math.abs(landed.x - rested.x) < 1 && Math.abs(landed.y - rested.y) < 1, JSON.stringify({ landed, rested }));
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('dashboard-layout-tray').waitFor({ state: 'detached' });
  delete preferences.omc_reduced_motion;
}

/**
 * The board on every animation frame for half a second, from now: the box of each named widget,
 * the widgets on the board in reading order, the opacity of a widget fading away, and which of the
 * named widgets the tray offers to restore.
 */
function sampleBoard(page, ids) {
  return page.evaluate((names) => new Promise((resolve) => {
    const samples = [];
    const start = performance.now();
    let changedAt = null;
    const tick = () => {
      const board = document.querySelector('[data-testid="dashboard-board"]');
      const cells = {};
      for (const name of names) {
        const box = board?.querySelector(`:scope > [data-widget="${name}"]`)?.getBoundingClientRect();
        if (box) cells[name] = { x: box.x, width: box.width };
      }
      const leaving = board?.querySelector(':scope > .dashboard-cell[aria-hidden="true"]');
      samples.push({
        cells,
        ids: [...(board?.querySelectorAll(':scope > [data-widget]') ?? [])].map((node) => node.dataset.widget),
        leavingOpacity: leaving ? Number(getComputedStyle(leaving).opacity) : null,
        restorable: names.filter((name) => document.querySelector(`[data-widget-restore="${name}"]`)),
      });
      // The window opens on the first frame the board changes, not when sampling starts: on a busy
      // machine the click can land late enough to cut the motion short.
      const sample = samples.at(-1);
      const first = samples[0];
      if (changedAt === null && (sample.ids.join() !== first.ids.join() || sample.leavingOpacity !== null
        || names.some((name) => Math.abs((sample.cells[name]?.x ?? 0) - (first.cells[name]?.x ?? 0)) > 0.5))) {
        changedAt = performance.now();
      }
      const now = performance.now();
      if ((changedAt === null || now - changedAt < 500) && now - start < 3000) requestAnimationFrame(tick);
      else resolve(samples);
    };
    tick();
  }), ids);
}

/** Moved, and through at least three places between where it started and where it settled. */
function glides(positions) {
  if (positions.length < 4) return false;
  const [from, to] = [positions[0], positions.at(-1)];
  if (Math.abs(to - from) < 8) return false;
  const low = Math.min(from, to) + 1;
  const high = Math.max(from, to) - 1;
  return positions.filter((x) => x > low && x < high).length >= 3;
}
