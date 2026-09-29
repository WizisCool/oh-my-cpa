import { until } from '../harness.mjs';

/**
 * The YAML source editor's widgets, and the icon font they are drawn with.
 *
 * The editor is a hand-assembled slim Monaco build: each feature is imported by
 * name so the bundle stays inside its budget, and the imports it does not make are
 * as load-bearing as the ones it does. The icon font is one of those. Every widget
 * glyph in the editor - find, folding, the suggest list - is a codicon, and the
 * slim build registers no font of its own, so an editor without it paints empty
 * boxes where the controls should be. Nothing below a real engine can tell an empty
 * box from a glyph: the DOM is identical, the classes are identical, and only the
 * loaded font decides what is drawn.
 *
 * So this scenario opens the source view, opens the find box the way an operator
 * does, and asks the document what it will paint that box's buttons with.
 */

const CONFIG_YAML = [
  '# gateway',
  'server:',
  '    port: 8317',
  'observability:',
  '    logs:',
  '        debug: false',
  '',
].join('\n');

const REVISION = 'rev-probe-config-source';

export function configSourceFixtures() {
  return [
    [
      (url, method) => url.pathname.endsWith('/management/config') && method === 'GET',
      () => ({
        scalars: { port: 8317, debug: false },
        supported_keys: ['server.port', 'observability.logs.debug'],
        revision: REVISION,
        safe_yaml: CONFIG_YAML,
      }),
    ],
    [
      (url) => url.pathname.endsWith('/management/config/source'),
      () => ({ yaml: CONFIG_YAML, size_bytes: CONFIG_YAML.length, revision: REVISION }),
    ],
    [(url) => url.pathname.endsWith('/management/config/backups'), () => ({ backups: [] })],
  ];
}

/**
 * What the browser will use to paint the find box's buttons.
 *
 * The three facts are separate on purpose. `declared` says the editor registered an
 * icon font at all - it is zero without the codicon import, whatever the rest says.
 * `status` says the face was actually fetched rather than left unloaded. And
 * `check` is the browser's own answer for the element's font stack, which is what
 * decides whether a glyph or a box is painted.
 */
async function iconFontState(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const face = [...document.fonts].find((entry) => entry.family.replace(/^["']|["']$/g, '') === 'codicon');
    const button = document.querySelector('.monaco-editor .find-widget .codicon-widget-close');
    return {
      declared: [...document.fonts].filter((entry) => entry.family.replace(/^["']|["']$/g, '') === 'codicon').length,
      status: face?.status ?? 'missing',
      available: document.fonts.check('16px codicon'),
      buttonFamily: button ? getComputedStyle(button).fontFamily : '',
    };
  });
}

export async function configSourceEditor({ base, page, check }) {
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.locator('.config-page').first().waitFor({ state: 'visible', timeout: 15000 });
  check('the configuration page opens', true);

  // The four-mode image-generation picker is the one select the settings list renders, and it has to
  // fill the fixed-width control column its row gives it: Ant Design sizes a `Select` to its content
  // by default, so the longest option's own text measured wider than the column that owns the fill
  // and spilled out of the row. Measured before switching views, because the source view replaces
  // the list.
  await page.locator('.config-nav-btn').filter({ hasText: /网络|Network/ }).first().click();
  // Ant Design puts a `Select`'s `id` on its inner search input, so the measured element is that
  // input's `ant-select` root - the box that owns the width.
  const picker = page.locator('.settings-toggle-control.is-select .ant-select').first();
  await until(async () => picker.isVisible(), { label: 'the image-generation picker' });
  const pickerBox = await picker.evaluate((node) => {
    const control = node.closest('.settings-toggle-control');
    if (!control) return null;
    return {
      select: Math.round(node.getBoundingClientRect().width),
      control: Math.round(control.getBoundingClientRect().width),
      inRow: node.getBoundingClientRect().right <= control.getBoundingClientRect().right + 1,
    };
  });
  check(
    'the image-generation picker fills its control column exactly',
    pickerBox !== null
      && pickerBox.select === pickerBox.control
      && pickerBox.inRow
      && pickerBox.select > 200,
    JSON.stringify(pickerBox),
  );

  // The visual/source switch reads the raw file on the way in, so the editor is
  // mounted with the server's own document rather than a cached one.
  await page.locator('.ant-segmented-item').filter({ hasText: /源码|Source/ }).first().click();
  await page.locator('.config-source-toolbar').waitFor({ state: 'visible', timeout: 15000 });
  await until(
    async () => (await page.locator('.monaco-editor .view-lines').count()) > 0,
    { label: 'the source editor to mount' },
  );
  check('the source view mounts the editor', true);

  // The editor takes focus on a click in its text, exactly as a reader does before
  // reaching for the keyboard.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+f');
  await until(
    async () => (await page.locator('.monaco-editor .find-widget.visible').count()) > 0,
    { label: 'the find box to open' },
  );
  check(
    'Ctrl+F opens the editor find box',
    (await page.locator('.monaco-editor .find-widget.visible .codicon-widget-close').count()) > 0,
  );

  const font = await iconFontState(page);
  check('the editor registers an icon font for its widgets', font.declared >= 1, JSON.stringify(font));
  check(
    'the find box buttons are painted with the loaded icon font',
    font.status === 'loaded'
      && font.available === true
      && font.buttonFamily.split(',')[0].replace(/^["']|["']$/g, '').trim() === 'codicon',
    JSON.stringify(font),
  );
}
