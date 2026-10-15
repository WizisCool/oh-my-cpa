import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { settleLayout, until } from '../harness.mjs';

/**
 * The typeface roles on the OMC settings page and the font library dialog behind them
 * (`web/src/components/settings/FontSettings.tsx`).
 *
 * The logic suite resolves references to `font-family` values; only a browser shows the claims
 * an operator relies on: a choice repaints the console - the stylesheet and Ant Design's
 * components alike - on the frame it is made, a library family is drawn from this origin's face
 * endpoint and from nowhere else, the next visit paints the chosen face before the preference
 * is read, and deleting a family in use puts its role back on the bundled typeface.
 *
 * A face is served as the bundled typeface's core shard, so the browser loads a real font.
 */
const FONT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FACE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GOOGLE_ID = 'cccccccccccccccccccccccccccccccc';
const SHARD = fileURLToPath(new URL('../../../web/src/assets/fonts/sarasa/sarasa-mono-sc-400-000.woff2', import.meta.url));

const uploaded = {
  id: FONT_ID, family: 'Probe Mono', source: 'upload', created_at_ms: 1, byte_size: 40_960,
  faces: [{ id: FACE_ID, weight_min: 400, weight_max: 400, style: 'normal', format: 'woff2' }],
};
const installed = {
  id: GOOGLE_ID, family: 'Inter', source: 'google', created_at_ms: 2, byte_size: 120_000,
  faces: [{ id: FACE_ID.replace(/b/g, 'd'), weight_min: 400, weight_max: 700, style: 'normal', unicode_range: 'U+0-FF', format: 'woff2' }],
};

export async function fontLibrary({ base, page, check }) {
  const shard = await readFile(SHARD);
  const preferences = {};
  const writes = [];
  let library = [];
  const googleRequests = [];
  const foreignRequests = [];
  const origin = new URL(base).origin;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && !url.protocol.startsWith('data')) foreignRequests.push(request.url());
  });

  let holdPreferences;
  await page.route('**/omc/api/**/preferences', async (route) => {
    if (holdPreferences) await holdPreferences;
    return route.fulfill({ json: { preferences, time_zone: { server_timezone: 'UTC' } } });
  });
  await page.route('**/omc/api/**/preferences/*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    const value = JSON.parse(route.request().postData());
    writes.push({ key, value });
    preferences[key] = value;
    return route.fulfill({ json: { key, value } });
  });
  await page.route('**/omc/api/v1/fonts', (route) => route.fulfill({ json: { fonts: library } }));
  await page.route('**/omc/api/v1/fonts/upload', (route) => {
    library = [uploaded, ...library];
    return route.fulfill({ status: 201, json: uploaded });
  });
  await page.route('**/omc/api/v1/fonts/google', (route) => {
    googleRequests.push(route.request().postDataJSON());
    library = [installed, ...library];
    return route.fulfill({ status: 201, json: installed });
  });
  await page.route(/\/omc\/api\/v1\/fonts\/[0-9a-f]{32}$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    library = library.filter((font) => font.id !== id);
    for (const [role, ref] of Object.entries(preferences.omc_fonts ?? {})) {
      if (ref === `font:${id}`) delete preferences.omc_fonts[role];
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/omc/api/v1/fonts/*/faces/*', (route) => route.fulfill({ status: 200, contentType: 'font/woff2', body: shard }));

  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  const rootFont = (property) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), property);

  // ── a built-in choice repaints the console, Ant Design included ───────────
  const uiPicker = page.getByRole('combobox', { name: 'Interface font', exact: true });
  await until(() => uiPicker.isEnabled(), { label: 'the interface font picker after the preference read' });
  check('the interface font defaults to the bundled typeface', (await rootFont('--font-ui')).startsWith('"Sarasa Mono SC"'));
  await uiPicker.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'System sans-serif' }).click();
  await until(() => preferences.omc_fonts?.ui === 'builtin:system-sans', { label: 'the interface font write' });
  check('the role is stored without the default it leaves alone', JSON.stringify(writes.at(-1)?.value) === '{"ui":"builtin:system-sans"}');
  // The fixture receiving the write does not mean React has committed the font effect yet.
  await until(async () => (await rootFont('--font-ui')).startsWith('system-ui'), { label: 'the interface font to repaint' });
  const painted = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    button: getComputedStyle(document.querySelector('.ant-btn')).fontFamily,
    mono: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
  }));
  check('the page and Ant Design components follow the interface font', painted.body.startsWith('system-ui') && painted.button.startsWith('system-ui'), JSON.stringify(painted));
  check('the monospace role is untouched by the interface choice', painted.mono.startsWith('"Sarasa Mono SC"'));

  // ── the library is a dialog, and its list is framed in both palettes ──────
  await page.getByRole('button', { name: 'Manage library', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Font library' });
  await dialog.waitFor();
  check('an empty library says so', (await dialog.innerText()).includes('No fonts installed yet'));

  // ── an uploaded family is drawn from this origin ──────────────────────────
  const faceRequest = page.waitForRequest((request) => request.url().includes(`/fonts/${FONT_ID}/faces/${FACE_ID}`));
  await page.locator('input[type="file"][accept*=".woff2"]').setInputFiles({ name: 'ProbeMono-Regular.woff2', mimeType: 'font/woff2', buffer: shard });
  const row = dialog.locator('li').filter({ hasText: 'Probe Mono' });
  await row.waitFor();
  // The probe context paints the light palette, where the soft divider is nearly the page colour.
  const frame = await dialog.locator('ul').evaluate((list) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--border)';
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(list).borderTopColor, token, width: getComputedStyle(list).borderTopWidth };
  });
  check('the library list is framed with the border token, not the near-invisible soft divider',
    frame.width === '1px' && frame.border === frame.token, JSON.stringify(frame));
  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'detached' });
  const face = await faceRequest;
  check('the library row previews the family from this origin\'s face endpoint', new URL(face.url()).origin === origin);
  const monoPicker = page.getByRole('combobox', { name: 'Monospace font', exact: true });
  await monoPicker.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Probe Mono' }).click();
  await until(() => preferences.omc_fonts?.mono === `font:${FONT_ID}`, { label: 'the monospace font write' });
  await until(async () => (await rootFont('--font-mono')).startsWith(`"omc-font-${FONT_ID}"`), { label: 'the monospace role to repaint' });
  check('a library family is declared under its id and loads', await page.evaluate((family) => document.fonts.check(`16px "${family}"`, 'A'), `omc-font-${FONT_ID}`));
  await page.getByRole('button', { name: 'Manage library', exact: true }).click();
  await dialog.waitFor();
  check('the in-use family says which role uses it', (await row.innerText()).includes('Used for Monospace font'));
  check('the settings row counts the installed families', (await page.locator('.settings-toggle-row').filter({ hasText: 'Font library' }).innerText()).includes('1 installed'));
  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'detached' });

  // ── the next visit paints the choice before the preference is read ────────
  let releasePreferences;
  holdPreferences = new Promise((resolve) => { releasePreferences = resolve; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#root > *').first().waitFor();
  const firstFrame = { ui: await rootFont('--font-ui'), mono: await rootFont('--font-mono') };
  releasePreferences();
  holdPreferences = undefined;
  check('the first frame is painted in the stored choice while the preference is still in flight',
    firstFrame.ui.startsWith('system-ui') && firstFrame.mono.startsWith(`"omc-font-${FONT_ID}"`), JSON.stringify(firstFrame));
  await page.locator('.omc-settings-page').waitFor();

  // ── Google Fonts: the server installs, the browser never contacts Google ──
  await page.getByRole('button', { name: 'Manage library', exact: true }).click();
  await dialog.waitFor();
  await dialog.getByRole('combobox', { name: 'Family name' }).fill('Inter');
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await dialog.locator('li').filter({ hasText: 'Inter' }).waitFor();
  check('installing from Google Fonts opens no second dialog', await page.getByRole('dialog').count() === 1);
  check('the install asks the server for the family by name', googleRequests.length === 1 && googleRequests[0].family === 'Inter');
  check('the browser loaded nothing from another origin', foreignRequests.length === 0, foreignRequests.join(' '));

  // ── the library fits a phone ──────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await settleLayout(page);
  const overflowing = await dialog.evaluate((node) => [...node.querySelectorAll('li, form')].filter((item) => item.scrollWidth > item.clientWidth + 1).length);
  check('the library dialog fits a phone without horizontal overflow', overflowing === 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settleLayout(page);

  // ── deleting a family in use returns its role to the bundled typeface ─────
  check('the settings page itself stays one row per setting', await page.locator('.omc-settings-page li').count() === 0);
  await row.getByRole('button', { name: 'Delete Probe Mono' }).click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: 'Delete', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  await until(async () => !(await rootFont('--font-mono')).includes(FONT_ID), { label: 'the monospace role after the delete' });
  check('deleting a family in use repaints its role in the bundled typeface', (await rootFont('--font-mono')).startsWith('"Sarasa Mono SC"'));
  check('the role is cleared in the stored preference too', preferences.omc_fonts?.mono === undefined);
  check('the stored first-frame choice no longer names the deleted family',
    await page.evaluate((id) => !(localStorage.getItem('omc-fonts') ?? '').includes(id), FONT_ID));
}
