import fs from 'node:fs';
import path from 'node:path';
import { until, settleLayout } from '../harness.mjs';
import { probeRoot } from '../probe.mjs';

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
  'plugins:',
  '    store:',
  '        sources:',
  '            - match: https://raw.githubusercontent.com/example/long-plugin-repository-with-a-deep-path/refs/heads/main/plugin/metadata/registry.yaml',
  'server:',
  '    port: 8317',
  '    trusted-proxies:',
  '        - 127.0.0.1',
  '        - 10.0.0.0/8',
  '        - 172.16.0.0/12',
  '        - 192.168.0.0/16',
  '        - 2001:db8::/32',
  '        - 203.0.113.7',
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
        supported_keys: ['server.port', 'server.trusted-proxies', 'observability.logs.debug'],
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

  // A list field is a free-form tag editor, and the frame that sizes the panel's pickers does not
  // fit it: bounded to that frame, the box measured 280px inside a 415px column and its 40px height
  // held tags that wrap onto a second line, so the addresses painted outside the box they belong
  // to. It takes the column's width and grows with its tags instead. Read while the default
  // section is up, because the navigation below replaces it.
  const tagsBox = await page.locator('.settings-field-control.is-string_list .ant-select').first().evaluate((node) => {
    const control = node.closest('.settings-field-control');
    const box = node.getBoundingClientRect();
    const tags = [...node.querySelectorAll('.ant-select-selection-item')].map((tag) => tag.getBoundingClientRect());
    return {
      select: Math.round(box.width),
      control: Math.round(control.getBoundingClientRect().width),
      height: Math.round(box.height),
      tags: tags.length,
      tagsBottom: Math.round(Math.max(...tags.map((tag) => tag.bottom))),
      boxBottom: Math.round(box.bottom),
      arrows: node.querySelectorAll('.ant-select-suffix').length,
    };
  });
  check(
    'the trusted-proxies list field fills its column, keeps its tags inside, and draws no picker arrow',
    tagsBox.select === tagsBox.control
      && tagsBox.tags > 1
      && tagsBox.tagsBottom <= tagsBox.boxBottom + 1
      && tagsBox.height > 40
      && tagsBox.arrows === 0,
    JSON.stringify(tagsBox),
  );

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
  await configSourceMobile({ base, page, check });
}

async function configSourceMobile({ base, page, check }) {
  await page.locator('.monaco-editor .find-widget.visible .codicon-widget-close').click();
  await page.locator('.monaco-editor .find-widget.visible').waitFor({ state: 'hidden' });
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await until(async () => await page.locator('.config-source-actions button').filter({ hasText: /^Wrap$/ }).getAttribute('aria-pressed') === 'true', { label: 'phone default wrap' });
    // Monaco resizes in two steps: its layout pass sizes the editor and its overflow guard at
    // once, and a later render pass sizes the layers inside them. Between the two the editor
    // already measures phone-wide while the closed find box still sits at its desktop offset and
    // widens the page, so the layer that only the render pass writes is the one to wait for.
    await until(async () => page.locator('.monaco-editor').evaluate((editor) => {
      const shell = editor.closest('.config-monaco-shell');
      const renderedLayer = editor.querySelector('.overflow-guard > .overlayWidgets');
      return shell.clientWidth > 0 && shell.clientWidth <= window.innerWidth
        && Math.abs(editor.clientWidth - shell.clientWidth) <= 1
        && renderedLayer !== null && Math.abs(renderedLayer.clientWidth - editor.clientWidth) <= 1;
    }), { label: `the YAML editor rendered the ${width}px phone layout` });
    await settleLayout(page);
    const geometry = await page.evaluate(() => ({
      overflow: document.querySelector('.app-content').scrollWidth - document.querySelector('.app-content').clientWidth,
      gutter: document.querySelector('.monaco-editor .margin').getBoundingClientRect().width,
      fontSize: getComputedStyle(document.querySelector('.monaco-editor .view-lines')).fontSize,
    }));
    check(`source reading uses a compact gutter and 16px text at ${width}px`, geometry.overflow <= 1 && geometry.gutter < 48 && geometry.fontSize === '16px', JSON.stringify(geometry));
    // Monaco corrects its pixel width only when its resize observer runs, so on a busy machine
    // the shell is briefly narrower than the editor inside it. The stale state is produced here
    // on purpose instead of being raced: the page must not widen whenever that happens.
    const staleEditorOverflow = await page.evaluate(() => {
      const editor = document.querySelector('.monaco-editor');
      const content = document.querySelector('.app-content');
      const width = editor.style.width;
      editor.style.width = '2000px';
      const overflow = content.scrollWidth - content.clientWidth;
      editor.style.width = width;
      return overflow;
    });
    check(`an editor still at a wider layout cannot widen the page at ${width}px`, staleEditorOverflow <= 1, `overflow=${staleEditorOverflow}`);
    check('desktop shortcut guidance is not shown on phones', !await page.locator('.config-source-hint').isVisible());
    check('a clean phone document has no duplicate save surface', await page.locator('.config-dirty-bar').count() === 0 && await page.locator('.config-toolbar').getByRole('button', { name: /Save/ }).count() === 0);
  }

  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const find = page.locator('.monaco-editor .find-widget.visible');
  await find.waitFor({ state: 'visible' });
  check('phone find is reachable without a keyboard shortcut', await find.locator('.codicon-widget-close').isVisible());
  await find.locator('.codicon-widget-close').click();
  await find.waitFor({ state: 'hidden' });
  const wrap = page.getByRole('button', { name: 'Wrap', exact: true });
  await wrap.click();
  check('wrap can be disabled without widening the page', await wrap.getAttribute('aria-pressed') === 'false' && await page.locator('.app-content').evaluate((pane) => pane.scrollWidth <= pane.clientWidth + 1));
  await until(async () => await page.locator('.monaco-editor .view-lines').evaluate((lines) => lines.getBoundingClientRect().width > lines.closest('.monaco-editor').getBoundingClientRect().width), { label: 'unwrapped URL scrolls inside the editor' });
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('# mobile-draft ');
  await page.locator('.config-dirty-bar').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.editorBeforeFocus = document.querySelector('.monaco-editor'); });
  await page.getByRole('button', { name: 'Focus editor', exact: true }).click();
  const focusRegion = page.locator('.config-source-container.is-focused');
  await focusRegion.waitFor({ state: 'visible' });
  check('focus editing preserves the editor and the draft', await page.evaluate(() => window.editorBeforeFocus === document.querySelector('.monaco-editor')) && (await page.locator('.view-lines').innerText()).includes('mobile-draft'));
  check('focus editing isolates background controls', await page.locator('.app-header').evaluate((header) => Boolean(header.closest('[inert]'))));
  check('manual wrapping survives focus editing', await wrap.getAttribute('aria-pressed') === 'false');

  // An injected visual viewport represents keyboard resize and caret pan, not a time delay.
  await page.evaluate(() => {
    const visible = window.visualViewport;
    window.originalViewportDescriptors = {
      height: Object.getOwnPropertyDescriptor(visible, 'height'),
      offsetTop: Object.getOwnPropertyDescriptor(visible, 'offsetTop'),
    };
    Object.defineProperties(visible, { height: { configurable: true, value: 420 }, offsetTop: { configurable: true, value: 30 } });
    visible.dispatchEvent(new Event('resize'));
  });
  await until(async () => await focusRegion.evaluate((region) => Math.round(region.getBoundingClientRect().height) === 420), { label: 'focused workspace fits keyboard viewport' });
  const keyboardGeometry = await focusRegion.evaluate((region) => {
    const box = region.getBoundingClientRect();
    const bar = region.querySelector('.config-dirty-bar').getBoundingClientRect();
    const editor = region.querySelector('.config-editor-wrap').getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, barBottom: bar.bottom, editorBottom: editor.bottom, barTop: bar.top };
  });
  check('the keyboard viewport bounds editor and dirty actions', keyboardGeometry.top === 30 && keyboardGeometry.bottom === 450 && keyboardGeometry.barBottom <= 450 && keyboardGeometry.editorBottom <= keyboardGeometry.barTop, JSON.stringify(keyboardGeometry));
  await page.evaluate(() => {
    const visible = window.visualViewport;
    for (const key of ['height', 'offsetTop']) {
      if (window.originalViewportDescriptors[key]) Object.defineProperty(visible, key, window.originalViewportDescriptors[key]);
      else delete visible[key];
    }
    visible.dispatchEvent(new Event('resize'));
  });

  let responseMode = 'conflict';
  const writes = [];
  await page.route('**/management/config/source', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON();
    writes.push(body);
    const status = responseMode === 'conflict' ? 409 : responseMode === 'failure' ? 503 : 200;
    const response = responseMode === 'conflict' ? { code: 'config_conflict', current_revision: 'newer-revision' }
      : responseMode === 'failure' ? { code: 'config_backup_failed', error: 'Fixture backup unavailable' }
      : { yaml: body.yaml, revision: 'saved-mobile-revision' };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
  });
  const save = page.locator('.config-dirty-btn-save');
  const confirmSave = async () => {
    await save.click();
    await page.locator('.ant-popconfirm:visible').getByRole('button', { name: 'Confirm', exact: true }).click();
  };
  await confirmSave();
  await page.locator('.ant-modal:visible').waitFor({ state: 'visible' });
  check('revision conflict opens above focus editing and preserves its draft', writes.length === 1 && (await page.locator('.view-lines').innerText()).includes('mobile-draft'));
  await page.goBack();
  await page.locator('.ant-modal:visible').waitFor({ state: 'hidden' });
  check('Back closes the conflict before the focused workspace', await focusRegion.isVisible());

  responseMode = 'failure';
  await confirmSave();
  await until(async () => writes.length === 2 && await save.isEnabled(), { label: 'failed save settles' });
  check('a failed save keeps the draft and its single action surface', (await page.locator('.view-lines').innerText()).includes('mobile-draft') && await page.locator('.config-dirty-bar').count() === 1);

  await page.goBack();
  await focusRegion.waitFor({ state: 'hidden' });
  check('Back exits focus editing without leaving source or losing its draft', page.url().endsWith('/config') && (await page.locator('.view-lines').innerText()).includes('mobile-draft'));
  check('focus returns to the focused-edit trigger', await page.getByRole('button', { name: 'Focus editor', exact: true }).evaluate((button) => button === document.activeElement));
  await page.locator('.monaco-editor .view-lines').click();
  const draftBeforeUndo = await page.locator('.view-lines').innerText();
  await page.keyboard.press('Control+z');
  await until(async () => (await page.locator('.view-lines').innerText()) !== draftBeforeUndo, { label: 'undo across focused editing' });
  check('the undo stack survives both focus transitions', await page.locator('.config-dirty-bar').count() === 1);
  await page.keyboard.press('Control+Shift+z');
  await until(async () => (await page.locator('.view-lines').innerText()) === draftBeforeUndo, { label: 'redo across focused editing' });
  check('redo recovers the same pre-focus edit', true);
  await page.locator('.config-dirty-btn-discard').click();
  await page.locator('.config-dirty-bar').waitFor({ state: 'hidden' });
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('invalid: [');
  await save.waitFor({ state: 'visible' });
  await save.click();
  check('invalid YAML never writes or asks for a save confirmation', writes.length === 2 && await page.locator('.ant-popconfirm:visible').count() === 0);
  await page.locator('.config-dirty-btn-discard').click();
  await page.locator('.config-dirty-bar').waitFor({ state: 'hidden' });
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('# successful-mobile-save ');
  await save.waitFor({ state: 'visible' });
  responseMode = 'success';
  await confirmSave();
  await page.locator('.config-dirty-bar').waitFor({ state: 'hidden' });
  check('one confirmed phone save writes the draft and adopts its baseline', writes.length === 3 && writes[2].yaml.includes('successful-mobile-save') && await page.locator('.ant-modal:visible').count() === 0);
  // Flow delimiter spacing distinguishes the worker's provider from the serializer fallback.
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('native-format-proof: [1,2,3]\n');
  await page.getByRole('button', { name: 'Source tools', exact: true }).click();
  await page.locator('.action-menu-content:visible').getByRole('button', { name: 'Format', exact: true }).click();
  await until(async () => (await page.locator('.view-lines').innerText()).replaceAll('\u00a0', ' ').includes('native-format-proof: [1, 2, 3]'), { label: 'native YAML worker formatting, not serializer fallback' });
  check('phone formatting requires the native YAML worker result', true);
  check('format remains reachable from phone tools', await page.locator('.monaco-editor').count() === 1);
  await page.locator('.config-dirty-btn-discard').click();
  await page.locator('.config-dirty-bar').waitFor({ state: 'hidden' });
  await page.locator('.action-menu-content:visible').waitFor({ state: 'hidden' });
  await until(async () => await page.locator('.omc-toast:visible').count() === 0, { label: 'source feedback settles before capture' });
  const screenshotPath = path.join(probeRoot, 'tmp', 'mobile-config-source.png');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });
  await page.setViewportSize({ width: 844, height: 390 });
  check('manual wrap survives a landscape rotation', await wrap.getAttribute('aria-pressed') === 'false');
}
