import { until } from '../harness.mjs';

/**
 * The dashboard arrangement: the operator orders, sizes and hides the dashboard's widgets, and the
 * board keeps what they chose.
 *
 * The rules about a stored arrangement are pinned by the logic suite (`test-dashboard-layout.ts`).
 * What needs a browser is that the pieces agree: the board draws the stored order and widths, the
 * editor's drag, step, width and hide controls change the board on the frame they are used, nothing
 * is written until Done, Cancel throws a draft away, a reload keeps the stored arrangement, and
 * Restore default puts the catalog back.
 *
 * The drag is a real HTML5 drag through Playwright's mouse rather than a synthetic event, so the
 * handle's arming of its cell - the only way a cell becomes draggable - is part of the claim.
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
    await page.getByTestId('dashboard-layout-done').click();
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
  await page.locator('[data-widget-restore="model_usage"]').click();
  await until(async () => (await trendToggles()) === 0, { label: 'the grouping toggle back on the usage card' });

  const quarter = await widthOf('tpm');
  await cell('rpm').locator('.ant-segmented-item', { hasText: '1/2' }).click();
  await until(async () => (await cell('rpm').getAttribute('data-span')) === '2', { label: 'the RPM tile to widen' });
  const half = await widthOf('rpm');
  check('a width choice resizes the widget on the board', half > quarter * 1.8, `rpm=${half} tpm=${quarter}`);

  await cell('requests').getByRole('button', { name: /^Move later/ }).click();
  await until(async () => (await order())[0] === 'tokens', { label: 'the requests tile to step later' });
  check('a step moves a widget one place in the reading order', (await order()).slice(0, 2).join(',') === 'tokens,requests');

  // Both cells are on the first row, so the drag never has to scroll the page under the pointer.
  await cell('tpm').locator('[data-drag-handle]').dragTo(cell('tokens'), { targetPosition: { x: 8, y: 40 } });
  await until(async () => (await order())[0] === 'tpm', { label: 'the TPM tile to be dragged first' });
  check('a drag places the widget where it is dropped', (await order()).slice(0, 2).join(',') === 'tpm,tokens', (await order()).join(','));
  check('nothing is stored while the operator is still arranging', layoutWrites().length === 0);

  await done();
  await until(() => layoutWrites().length === 1, { label: 'the arrangement write' });
  const stored = JSON.parse(layoutWrites()[0].body);
  const storedItem = (id) => stored.find((entry) => entry.id === id);
  check('Done stores the arrangement as one ordered document',
    stored[0].id === 'tpm' && storedItem('cost').hidden === true && storedItem('rpm').span === 2,
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
}
