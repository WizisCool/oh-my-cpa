import { until, settleLayout } from '../harness.mjs';
import { sleep } from '../probe.mjs';

/**
 * The OMC settings page: the console's own preferences, and the promise that changing one
 * actually governs the console.
 *
 * The probe context is English (`omc-lang = 'en'`), which is the reading this page has to be
 * correct in: the token unit style offers a Chinese scale, and offering it to an English console
 * would print 亿 beside English copy. Three claims follow from that and none is reachable from a
 * per-component test: the Chinese option is present but disabled, a stored Chinese choice cannot
 * leak into an English reading, and the choice governs the dashboard rather than only the control.
 */
export async function omcSettings({ base, page, check, context }) {
  const writes = [];
  await page.route('**/omc/api/**/preferences/*', async (route) => {
    if (route.request().method() === 'PUT') {
      writes.push({ key: new URL(route.request().url()).pathname.split('/').pop(), body: route.request().postData() });
    }
    return route.fallback();
  });

  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });

  // ── every header action names itself on hover ─────────────────────────────
  // Sign out is an icon button, because its label is the one string in this cluster whose
  // length changes with the language. That makes its tooltip the control's name rather than
  // decoration, and hovering the two menu triggers proves they did not lose the hover to the
  // dropdown wrapped inside them.
  //
  // The mode control's name is matched as "Theme: <mode>" rather than as the bare word: it cycles three
  // states whose only other signal is an icon, and a screen reader cannot see an icon - so the name states
  // the mode, and this pins that it does.
  const headerActions = [
    { name: 'Refresh all', matcher: /^Refresh all$/ },
    { name: 'Theme', matcher: /^Theme: (Light|Dark|Follow system)$/ },
    { name: 'Language', matcher: /^Language$/ },
    { name: 'Sign out', matcher: /^Sign out$/ },
  ];
  const unnamedActions = [];
  for (const { name, matcher } of headerActions) {
    const action = page.locator('.app-header-actions').getByRole('button', { name: matcher });
    if ((await action.count()) !== 1) {
      unnamedActions.push(`${name} (${await action.count()} matches)`);
      continue;
    }
    await action.hover();
    const shown = await until(async () => {
      const text = await page.locator('.ant-tooltip:visible').first().innerText().catch(() => '');
      return text.includes(name) ? text : false;
    }, { label: `the ${name} tooltip`, timeoutMs: 5000 }).catch(() => false);
    if (!shown) unnamedActions.push(`${name} (no tooltip)`);
    // Leave the control, so the next hover cannot be read from the previous tooltip.
    await page.mouse.move(2, 2);
  }
  check('every header action names itself on hover', unnamedActions.length === 0, unnamedActions.join(' | '));

  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });

  // ── the page states itself once, without decorative copy ──────────────────
  // docs/design.md §3: one page title, and a subtitle only when it carries live data. The titles
  // and descriptions this page shipped with were static explanation, so their absence is the claim.
  check('the settings page carries exactly one page title', (await page.locator('.omc-settings-page .terminal-title').count()) === 1);
  check(
    'the settings page carries no static subtitle',
    (await page.locator('.omc-settings-page .terminal-subtitle').count()) === 0
      && (await page.locator('.omc-settings-page .settings-group-desc').count()) === 0,
    `subtitle=${await page.locator('.omc-settings-page .terminal-subtitle').count()} groupDesc=${await page.locator('.omc-settings-page .settings-group-desc').count()}`,
  );

  // Every console setting this page owns, once. A duplicated row would be two controls for one
  // setting - the operator changes one and the other silently disagrees.
  //
  // Five rows, because the theme is now a mode and the palette each of the two modes uses: the mode
  // is the setting an operator changes often, and the two palettes are the considered choices behind
  // it. A single "theme" row could only be one of those.
  const labels = await page.locator('.omc-settings-page .settings-toggle-title').allInnerTexts();
  check(
    'the settings page lists each console setting once',
    labels.length === 5
      && new Set(labels).size === labels.length
      && labels.some((label) => /Token unit style|Token 计量单位/.test(label))
      && labels.some((label) => /Theme mode|主题模式/.test(label))
      && labels.some((label) => /Light-mode palette|浅色模式配色/.test(label))
      && labels.some((label) => /Dark-mode palette|暗色模式配色/.test(label))
      && labels.some((label) => /Language|界面语言/.test(label)),
    `labels=${labels.join(' | ')}`,
  );
  // The chart grouping belongs to the panels that plot it, not here: a second control on a settings
  // page is a second place to look for one decision.
  check(
    'the chart grouping is not duplicated onto the settings page',
    !labels.some((label) => /grouping|口径/.test(label)),
    `labels=${labels.join(' | ')}`,
  );

  // ── each control fits the column it is given ──────────────────────────────
  // The settings-list row hands its control a fixed-width column, and a segmented
  // picker is often wider than the text inputs that column was sized for. An
  // overflowing control paints its own fill past the row's edge and up against the
  // label beside it, which reads as a layout collision even though the two boxes
  // are adjacent rather than overlapping - so the observable is measured overflow,
  // not how close the boxes look.
  const controlOverflow = await page.evaluate(() =>
    [...document.querySelectorAll('.omc-settings-page .settings-toggle-row')].map((row) => {
      // The picker itself, not the box it is handed. A control wider than its column
      // overflows a container whose own `scrollWidth` does not report it - the box stays
      // its assigned size and the child simply paints past it - so the measurement has to
      // be taken on the child against the row's own edge.
      const picker = row.querySelector('.ant-segmented, .theme-preset-grid') ?? row.querySelector('.settings-toggle-control');
      const box = row.querySelector('.settings-toggle-control');
      const boxRect = box.getBoundingClientRect();
      const pickerRect = picker.getBoundingClientRect();
      return {
        label: row.querySelector('.settings-toggle-title')?.textContent,
        // Both edges. The control column is right-aligned in its grid cell, so a picker wider
        // than the column spills to the *left* - towards the description beside it - which is
        // the direction that reads as a collision, and the one a right-edge check alone misses.
        pastBoxEdge: Math.max(
          Math.round(pickerRect.right - boxRect.right),
          Math.round(boxRect.left - pickerRect.left),
        ),
      };
    }));
  check(
    'every settings control fits the column it is given',
    controlOverflow.every((entry) => entry.pastBoxEdge <= 1),
    JSON.stringify(controlOverflow),
  );

  // ── the control still fits, and is still legible, on a phone ──────────────
  //
  // Both of this page's layout defects were phone-only, and the desktop pass above cannot see
  // either. The picker's track is the sum of its labels, and on a narrow card that sum exceeded the
  // card: the third option was painted past its edge. Making the picker a vertical list is the fix,
  // and it is asserted by geometry on every option rather than by the presence of the library's
  // `block` class - the class was applied while the items were still clipped, because the root kept
  // its content width until the stylesheet widened it.
  const narrowOverflow = async () => page.evaluate(() => {
    const card = document.querySelector('.omc-settings-page .settings-group').getBoundingClientRect();
    return [...document.querySelectorAll('.omc-settings-page .ant-segmented-item')].map((item) => {
      const rect = item.getBoundingClientRect();
      const label = item.querySelector('.ant-segmented-item-label') ?? item;
      return {
        text: item.textContent,
        pastCardEdge: Math.round(rect.right - card.right),
        // Clipping is the other half of "it does not fit", and the half a narrow card reaches first:
        // the row shrank its options until they fitted, which squeezed each label's box below the
        // width its own text needs. The option then reads as an ellipsis rather than as a choice, so
        // fitting is asserted as "inside the card *and* showing its whole label".
        clippedBy: Math.max(0, Math.round(label.scrollWidth - label.getBoundingClientRect().width)),
      };
    });
  });
  /**
   * Waits until the unit-style picker has taken the shape the current viewport implies.
   *
   * That control changes shape in *React*, not in CSS: `vertical={isNarrow} block={isNarrow}` follows
   * a `matchMedia` change listener, so after `setViewportSize` there is a window in which the new
   * width is already in force while the old layout is still painted. Waiting for an option to be
   * *visible* does not close that window - the options are visible in both shapes - which is exactly
   * how this check flaked: it measured the horizontal row and read every option painted past the
   * card (a rising ladder such as 85, 184, 283) while asserting the vertical list. The geometry *is*
   * the assertion, so the wait has to be on the geometry: stacked, the options share one left edge;
   * in a row, each has its own.
   *
   * Scoped to the picker under assertion by its own label rather than to every segmented control on
   * the page. The claim is about this picker's shape, and the page carries a second segmented control
   * whose shape it does not state: a page-wide "all options share an edge" condition would be
   * asserting the language row's layout from the unit-style check, and would wait for a state the
   * page never reaches wherever the two disagree - a hang rather than a fix. The label is the same
   * registered language pair this scenario's row locator uses, so a console in any reading language resolves
   * it.
   *
   * Bounded by Playwright's own polling rather than a fixed sleep, because how long the listener
   * takes to fire and React to re-render is exactly what differs between an idle workstation and a
   * loaded CI runner.
   */
  const waitForPickerShape = async (expectVertical) => {
    await page.waitForFunction((wantVertical) => {
      const picker = [...document.querySelectorAll('.omc-settings-page .ant-segmented')]
        .find((candidate) => /^(Token unit style|Token \u8ba1\u91cf\u5355\u4f4d)$/.test(candidate.getAttribute('aria-label') ?? ''));
      const items = [...(picker?.querySelectorAll('.ant-segmented-item') ?? [])];
      if (items.length === 0) return false;
      // One shared left edge means a stacked list; one left edge each means a single row. Exact
      // equality is right here because the two shapes differ by tens of pixels, far above the
      // sub-pixel rounding the `Math.round` absorbs.
      const allShareAnEdge = new Set(items.map((item) => Math.round(item.getBoundingClientRect().left))).size === 1;
      return wantVertical ? allShareAnEdge : !allShareAnEdge;
    }, expectVertical, { timeout: 10_000 });
  };

  const selectionLegibility = async () => page.evaluate(() => {
    const selected = document.querySelector('.omc-settings-page .ant-segmented-item-selected');
    const track = selected?.closest('.ant-segmented');
    const card = document.querySelector('.omc-settings-page .settings-group');
    const toRGB = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const distance = (left, right) => Math.max(...left.map((channel, index) => Math.abs(channel - right[index])));
    const selectedFill = toRGB(getComputedStyle(selected).backgroundColor);
    return {
      vsTrack: distance(selectedFill, toRGB(getComputedStyle(track).backgroundColor)),
      vsCard: distance(selectedFill, toRGB(getComputedStyle(card).backgroundColor)),
    };
  });

  // 320px, not 390: this is the narrowest console the page is expected to serve, and it is where the
  // picker's content width most exceeds the card. A wider phone hid the defect - the horizontal row
  // fitted at 390px once the labels were shortened, so that width could not tell the two layouts
  // apart, and the check passed against the broken one.
  await page.setViewportSize({ width: 320, height: 900 });
  await waitForPickerShape(true);
  const phoneOverflow = await narrowOverflow();
  check(
    'every settings option fits the card on a phone and shows its whole label',
    phoneOverflow.every((entry) => entry.pastCardEdge <= 1 && entry.clippedBy <= 1),
    JSON.stringify(phoneOverflow),
  );
  // Fitting the card is not the same as fitting the picker. A row whose options are wider than its
  // own track stays inside the card and keeps every label whole - so the assertions above pass - while
  // the selected chip is painted past the edge the track draws, because the cell stretched the track
  // below the width its options need. That is how a flagged language row looked at 320px before this
  // page stacked it, and it is measured here per picker rather than per card edge.
  const trackFits = await page.evaluate(() =>
    [...document.querySelectorAll('.omc-settings-page .ant-segmented')].map((track) => {
      const items = [...track.querySelectorAll('.ant-segmented-item')];
      const boxes = items.map((item) => item.getBoundingClientRect());
      // One shared left edge means a stack, where only the widest option has to fit; one left edge
      // each means a row, where the track has to hold all of them.
      const isStacked = new Set(boxes.map((box) => Math.round(box.left))).size === 1;
      const needed = isStacked
        ? Math.max(...boxes.map((box) => box.width))
        : boxes.reduce((sum, box) => sum + box.width, 0);
      return {
        label: track.getAttribute('aria-label'),
        track: Math.round(track.getBoundingClientRect().width),
        needed: Math.round(needed),
      };
    }),
  );
  check(
    'no picker track is narrower than the options it holds',
    trackFits.length > 0 && trackFits.every((entry) => entry.track >= entry.needed - 1),
    JSON.stringify(trackFits),
  );
  // The selected option has to be distinguishable from *both* surfaces it touches: the track it
  // slides in, and the card behind that track. The light palette rendered it as the same white as
  // both, so the control showed no selection at all there while the dark theme looked fine - which
  // is why this is asserted as a contrast between fills rather than as a specific colour.
  const legibility = await selectionLegibility();
  check(
    'the selected option is distinguishable from its track and its card',
    legibility.vsTrack >= 8 && legibility.vsCard >= 8,
    JSON.stringify(legibility),
  );
  // Back to the probe's default width: the checks that follow read the desktop console, and their
  // geometry is what the assertions below compare against. The shape is awaited for the same reason
  // it is at 320px - a stale vertical list would leave the picker laid out as the phone's, and the
  // desktop pass that follows reads this control's own geometry.
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForPickerShape(false);

  // ── the Chinese scale is offered to Chinese consoles only ─────────────────
  const tokenRow = page.locator('.omc-settings-page .settings-toggle-row').filter({ hasText: /Token unit style|Token 计量单位/ });
  const chineseOption = tokenRow.locator('.ant-segmented-item').filter({ hasText: /万\/亿/ });
  const chineseScaleOption = () => page.locator('.omc-settings-page .ant-segmented-item').filter({ hasText: /万\/亿|萬\/億/ });
  check(
    'the Chinese unit style is shown but disabled on an English console',
    (await chineseOption.count()) === 1 && (await chineseOption.locator('input').isDisabled()),
    `count=${await chineseOption.count()} disabled=${await chineseOption.locator('input').isDisabled().catch(() => 'n/a')}`,
  );

  // ── the language-neutral style governs the dashboard ──────────────────────
  // The claim the setting makes is about every token readout, and the dashboard tiles are the
  // loudest one: a full-digit tile has separators and no unit suffix at all.
  const fullOption = tokenRow.locator('.ant-segmented-item').filter({ hasText: /Full digits|完整数字/ });
  await fullOption.click();
  let persistedStyle = null;
  await until(async () => {
    persistedStyle = writes.find((entry) => entry.key === 'omc_token_style');
    return Boolean(persistedStyle);
  }, { label: 'the unit style to be persisted' }).catch(() => {});
  check(
    'choosing a unit style persists it under its own preference key',
    persistedStyle?.body === '"full"',
    `writes=${JSON.stringify(writes)}`,
  );

  /**
   * The dashboard's Token tile value.
   *
   * Selected by its own label rather than by position: the first tile in the grid is the request
   * count, which is a different number with a different format, so an index-based locator would
   * assert the wrong readout and pass. Waited for through the condition primitive because the page
   * paints skeletons first.
   */
  const tokenTileValue = () => page
    .locator('.dashboard-tile')
    .filter({ has: page.locator('.tile-label', { hasText: /^(Tokens|Token \u603b\u6570)$/ }) })
    .first()
    .locator('.tile-value');

  /**
   * One tile's reading, as the accessibility tree spells it.
   *
   * A rolling readout is a custom element whose digits live in its own shadow root, so
   * the value is not the tile's `innerText` - the digits are separate nodes and the
   * snapshot separates them with a space. Reading the accessible text back is also the
   * stronger claim: it is what the number announces as, not merely what it paints.
   */
  const tileReading = async (tile) => {
    const snapshot = await tile.locator('number-flow-react').ariaSnapshot();
    return snapshot.replace(/^-\s*\w+:\s*/, '').replace(/\s+/g, '');
  };

  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  const tokenTile = await until(async () => {
    const tile = tokenTileValue();
    return (await tile.count()) > 0 ? tile : false;
  }, { label: 'the dashboard token tile to render' }).catch(() => null);
  const tileText = tokenTile ? await tileReading(tokenTile) : '';
  check(
    'the dashboard token tile renders in the chosen full-digit style',
    /^\d{1,3}(,\d{3})+$/.test(tileText),
    `tile=${JSON.stringify(tileText)}`,
  );
  // The tile's accessible name is the same exact value, which is the guarantee the row's
  // description states - and the reason an abbreviation is safe to show at all.
  check(
    'the abbreviated tile keeps its exact count in the accessible name',
    (await tokenTile.getAttribute('title')) === tileText,
    `title=${JSON.stringify(await tokenTile.getAttribute('title'))} text=${JSON.stringify(tileText)}`,
  );

  // ── a stored Chinese choice cannot leak into an English reading ───────────
  // This is the defect the guard exists for, so it is asserted through the *stored* value rather
  // than through the control: a console that remembers `zh` must still read its numbers in a form
  // its copy can sit beside.
  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  await page.evaluate(async () => {
    await fetch('/omc/api/v1/preferences/omc_token_style', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('zh'),
    });
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  const storedChineseTile = await until(async () => {
    const tile = tokenTileValue();
    return (await tile.count()) > 0 ? tile : false;
  }, { label: 'the dashboard token tile to render with a stored Chinese style' }).catch(() => null);
  const storedChineseText = storedChineseTile ? await tileReading(storedChineseTile) : '';
  // Asserted as a *positive* format rather than as the absence of Chinese units: the console
  // rendered `full` moments ago, so "no 万/亿" would also be satisfied by a `zh` write that never
  // took effect, and the check would pass while proving nothing. The fixture's window is large
  // enough that compact carries a suffix, which is what distinguishes the fallback from the
  // style that was in force before it.
  check(
    'a stored Chinese unit style falls back to compact on an English console',
    /^[\d.]+[KMBT]$/.test(storedChineseText),
    `tile=${JSON.stringify(storedChineseText)}`,
  );

  // ── the appearance section is one mode and two palettes ───────────────────
  //
  // The registry no longer decides what is on screen; it offers choices *within* a mode. So this
  // section is driven from a written preference rather than from whatever the previous check left
  // behind: the mode and both palette selections go in as one document, which is the shape the
  // console itself writes.
  const themeDocument = { mode: 'light', palettes: { dark: 'omc-dark', light: 'omc-light' }, custom: {} };
  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  await page.evaluate((document) => localStorage.setItem('omc-theme', JSON.stringify(document)), themeDocument);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });

  const paletteGroups = page.locator('.omc-settings-page .theme-preset-grid');
  check('every mode is offered its own palette group', (await paletteGroups.count()) === 2, `groups=${await paletteGroups.count()}`);
  const lightGroup = paletteGroups.nth(0);
  const darkGroup = paletteGroups.nth(1);
  check(
    "each mode offers three registered palettes plus the operator's own",
    (await lightGroup.locator('.theme-preset-card').count()) === 4 && (await darkGroup.locator('.theme-preset-card').count()) === 4,
    `light=${await lightGroup.locator('.theme-preset-card').count()} dark=${await darkGroup.locator('.theme-preset-card').count()}`,
  );
  // A palette belongs to a mode - its text ladder points one way - so a group holding another mode's
  // palette would offer a dark palette to a light console.
  check(
    'a mode groups only its own palettes',
    (await lightGroup.getByText(/Porcelain|Sandstone/).count()) === 2
      && (await lightGroup.getByText(/Midnight|Forest/).count()) === 0
      && (await darkGroup.getByText(/Midnight|Forest/).count()) === 2
      && (await darkGroup.getByText(/Porcelain|Sandstone/).count()) === 0,
    `light-only=${await lightGroup.getByText(/Midnight|Forest/).count()} dark-only=${await darkGroup.getByText(/Porcelain|Sandstone/).count()}`,
  );
  check(
    'every palette group marks exactly one active choice',
    (await lightGroup.locator('.theme-preset-card.is-active').count()) === 1
      && (await darkGroup.locator('.theme-preset-card.is-active').count()) === 1,
  );

  // ── choosing a palette for the mode that is not in force ─────────────────
  // A click says "dark mode uses Midnight", not "show me Midnight". The mode control is the row
  // above; a click that changed both would be a click whose second effect was not asked for.
  await darkGroup.locator('.theme-preset-card').filter({ hasText: /Midnight/ }).click();
  await until(
    async () => JSON.parse(await page.evaluate(() => localStorage.getItem('omc-theme'))).palettes.dark === 'midnight',
    { label: 'the dark mode to record Midnight' },
  );
  check(
    'choosing a palette for the other mode does not move the console',
    (await page.locator('html').getAttribute('data-theme-mode')) === 'light'
      && (await page.locator('html').getAttribute('data-theme')) === 'omc-light',
    `mode=${await page.locator('html').getAttribute('data-theme-mode')} theme=${await page.locator('html').getAttribute('data-theme')}`,
  );

  const modeRow = page.locator('.omc-settings-page .settings-toggle-row').filter({ hasText: /Theme mode|主题模式/ });
  await modeRow.locator('.ant-segmented-item').filter({ hasText: /Dark|暗色/ }).click();
  await until(async () => (await page.locator('html').getAttribute('data-theme')) === 'midnight', {
    label: 'the recorded dark palette to apply when dark mode arrives',
  });
  const midnightBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  check('the recorded palette paints the console when its mode arrives', midnightBg === '#0d1117', `--bg=${midnightBg}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  check(
    'both the mode and the palette it recorded survive a reload',
    (await page.locator('html').getAttribute('data-theme')) === 'midnight'
      && (await page.locator('html').getAttribute('data-theme-mode')) === 'dark',
  );

  // ── the header's single control cycles three modes ──────────────────────
  // It used to be a menu over six registered palettes. Now the palettes belong to the modes and are
  // chosen where they can be previewed, so the header answers the one question asked repeatedly. What
  // says which of the three states is in force is the icon - and the cluster-wide "every header action
  // names itself on hover" check above still holds, because the control's tooltip is its own name.
  const themeButton = page.locator('.app-header').getByRole('button', { name: /Theme|界面主题/ });
  const themePreference = () => page.locator('html').getAttribute('data-theme-preference');
  check('the header control reports the stored preference, not the resolved mode', (await themePreference()) === 'dark');
  await themeButton.click();
  await until(async () => (await themePreference()) === 'system', { label: 'the header control to reach follow-the-system' });
  await themeButton.click();
  await until(async () => (await themePreference()) === 'light', { label: 'the cycle to close back onto light' });

  // ── following the system repaints when the system does ──────────────────
  await themeButton.click(); // light → dark
  await until(async () => (await themePreference()) === 'dark', { label: 'the cycle to reach dark' });
  await themeButton.click(); // dark → system
  await until(async () => (await themePreference()) === 'system', { label: 'the cycle to reach follow-the-system' });
  await page.emulateMedia({ colorScheme: 'light' });
  await until(async () => (await page.locator('html').getAttribute('data-theme-mode')) === 'light', {
    label: 'the console to follow the system into light',
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await until(async () => (await page.locator('html').getAttribute('data-theme-mode')) === 'dark', {
    label: 'the console to follow the system back into dark',
  });
  check(
    'following the system follows it in both directions',
    (await page.locator('html').getAttribute('data-theme-preference')) === 'system',
  );
  await page.emulateMedia({ colorScheme: null });

  // ── the custom palette editor ───────────────────────────────────────────
  await modeRow.locator('.ant-segmented-item').filter({ hasText: /Dark|暗色/ }).click();
  await until(async () => (await page.locator('html').getAttribute('data-theme-mode')) === 'dark', {
    label: 'dark mode to be in force before the editor is opened',
  });
  await lightGroup.locator('.theme-preset-card.is-custom').click();
  await page.locator('.palette-editor').waitFor({ timeout: 10_000 });
  // Editing the mode the console is not in previews that mode, and says so: nine swatches judged
  // against the wrong page would be judged against nothing.
  check(
    'editing the other mode previews it and announces the preview',
    (await page.locator('html').getAttribute('data-theme-preview')) === 'light'
      && (await page.locator('html').getAttribute('data-theme-mode')) === 'light'
      && (await page.locator('.palette-preview-note').count()) === 1,
    `preview=${await page.locator('html').getAttribute('data-theme-preview')} note=${await page.locator('.palette-preview-note').count()}`,
  );
  check('the editor exposes the nine authored tokens', (await page.locator('.palette-token-row').count()) === 9, `rows=${await page.locator('.palette-token-row').count()}`);
  check(
    'every token row reports what the colour measures against the page',
    (await page.locator('.palette-token-row .palette-token-ratio').allInnerTexts()).every((text) => /[✓⚠·]\s[\d.]+:1/.test(text)),
    JSON.stringify(await page.locator('.palette-token-row .palette-token-ratio').allInnerTexts()),
  );
  check(
    'a seeded custom palette starts from the palette it was opened on',
    (await page.locator('.palette-token-row').first().innerText()).includes('#ffffff'),
    JSON.stringify(await page.locator('.palette-token-row').first().innerText()),
  );

  // The custom palette has no name of its own: it is labelled by the dictionary, so its card reads in
  // whichever language the console is set to, exactly like the palette names beside it. A name the
  // operator typed would be the one label in the console that could not be translated.
  const customCard = lightGroup.locator('.theme-preset-card.is-custom');
  check(
    "the custom palette's label follows the reading language",
    (await customCard.innerText()).includes('Custom'),
    JSON.stringify(await customCard.innerText()),
  );
  // Located by every translation of its label: the row's own copy changes when the language does, so a
  // locator filtered by the current language stops matching the moment the switch lands.
  const appearanceLanguageRow = page
    .locator('.omc-settings-page .settings-toggle-row')
    .filter({ hasText: /Language|界面语言|介面語言|Bahasa/ });
  await appearanceLanguageRow.locator('.ant-segmented-item').filter({ hasText: /繁體中文/ }).click();
  await until(async () => (await customCard.innerText()).includes('自訂'), {
    label: 'the custom label to follow the reading language',
  });
  check(
    'the custom label is translated rather than hardcoded',
    !(await customCard.innerText()).includes('Custom'),
    JSON.stringify(await customCard.innerText()),
  );
  await appearanceLanguageRow.locator('.ant-segmented-item').filter({ hasText: /English/ }).click();
  await until(async () => (await customCard.innerText()).includes('Custom'), {
    label: 'the language to return to English',
  });

  // ── the editing model: live repaint, one request per completed change ────
  //
  // The console repaints as the edit proceeds and only a *completed* change is persisted, so an
  // operator can experiment without a half-chosen palette reaching the deployment.
  //
  // The gesture driven here is the editor's own "start from" control, which writes the same draft and
  // commits through the same path a colour drag does. The colour panel's own handler is deliberately
  // not driven: it tracks a captured pointer, and synthesised input cannot follow a pointer capture, so
  // a scripted drag on it reports nothing rather than reporting a defect. What that leaves unasserted is
  // Ant Design's drag plumbing; the console's editing model is what these checks cover.
  const accentRow = page.locator('.palette-token-row').filter({ hasText: /Accent|强调色/ });
  check(
    'the accent token reports its own contrast against the page',
    /[✓⚠]\s[\d.]+:1/.test(await accentRow.locator('.palette-token-ratio').innerText()),
    `ratio=${await accentRow.locator('.palette-token-ratio').innerText()}`,
  );
  // Every token is judged against the floor its own role carries, so a correct palette never shows a
  // marker it did not earn: the nine rows of a freshly seeded palette are the six built-ins' own.
  const ratios = await page.locator('.palette-token-row .palette-token-ratio').allInnerTexts();
  check(
    'no token of a freshly seeded palette is flagged',
    ratios.every((text) => text.startsWith('✓') || text.startsWith('·')),
    JSON.stringify(ratios),
  );

  const baseSelect = page.locator('.palette-editor .ant-select').first();
  await baseSelect.click();
  const baseOptions = await page.locator('.ant-select-dropdown:visible .ant-select-item-option').allInnerTexts();
  check(
    'the editor starts a palette from this mode\'s own palettes',
    baseOptions.length === 3 && !baseOptions.some((label) => /Midnight|Forest|OMC Dark/.test(label)),
    JSON.stringify(baseOptions),
  );
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /Sandstone/ }).first().click();
  let repainted = '';
  await until(async () => {
    repainted = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    return repainted.toLowerCase() === '#0f766e';
  }, { label: 'the edit to repaint the console' }).catch(() => undefined);
  check(
    'an edit repaints the whole console rather than only the editor',
    repainted.toLowerCase() === '#0f766e',
    `--accent=${repainted}`,
  );
  check(
    'a completed change is what reaches the deployment',
    writes.some((write) => {
      if (write.key !== 'omc_theme') return false;
      return JSON.parse(write.body)?.custom?.light?.core?.accent?.toLowerCase() === '#0f766e';
    }),
    `writes=${JSON.stringify(writes.filter((write) => write.key === 'omc_theme').slice(-1))}`,
  );

  await page.locator('.palette-editor').getByRole('button', { name: /Done|完成/ }).click();
  await until(async () => (await page.locator('.palette-editor').count()) === 0, { label: 'the editor to close' });
  check(
    'closing the editor returns the console to the mode in force',
    (await page.locator('html').getAttribute('data-theme-mode')) === 'dark'
      && (await page.locator('html').getAttribute('data-theme-preview')) === null,
    `mode=${await page.locator('html').getAttribute('data-theme-mode')} preview=${await page.locator('html').getAttribute('data-theme-preview')}`,
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  const lightGroupAfterReload = page.locator('.omc-settings-page .theme-preset-grid').nth(0);
  check(
    'the authored palette is stored under its own mode and survives a reload',
    (await lightGroupAfterReload.locator('.theme-preset-card.is-active').getAttribute('class') ?? '').includes('is-custom')
      && (await lightGroupAfterReload.locator('.theme-preset-card.is-active').innerText()).includes('Custom'),
    `active=${await lightGroupAfterReload.locator('.theme-preset-card.is-active').innerText().catch(() => '')}`,
  );
  // The deployment holds the same document, not just this browser: the preference endpoint is what
  // makes a palette follow the operator to another machine.
  check(
    'the theme reaches the deployment as one document',
    writes.some((write) => {
      if (write.key !== 'omc_theme') return false;
      const document = JSON.parse(write.body);
      return document.mode === 'dark' && document.palettes?.light === 'custom' && document.custom?.light?.base === 'sandstone';
    }),
    `writes=${JSON.stringify(writes.filter((write) => write.key === 'omc_theme').slice(-1))}`,
  );

  // ── the appearance settings drive the live console ────────────────────────
  // Theme and language stay in the browser, and the page's controls must therefore drive the app
  // rather than a copy: switching the language re-renders this page's own copy, and it also makes
  // the Chinese scale selectable. The option is located by its endonym, which is the one label this
  // row shows in every reading (see the header menu's own check below).
  const languageRow = page.locator('.omc-settings-page .settings-toggle-row').filter({ hasText: /Language|界面语言|介面語言|Bahasa/ });
  await languageRow.locator('.ant-segmented-item').filter({ hasText: /简体中文/ }).click();
  let becameChinese = false;
  await until(async () => {
    becameChinese = /OMC 设置/.test(await page.locator('.omc-settings-page .terminal-title').innerText());
    return becameChinese;
  }, { label: 'the page to re-render in the chosen language' }).catch(() => {});
  check('switching the language on this page re-renders the console', becameChinese);
  check(
    'the Chinese unit style becomes selectable once the console is Chinese',
    !(await chineseScaleOption().locator('input').isDisabled()),
  );

  // ── the header's language menu, and the geometry a switch must not disturb ─
  // The reported defect: the cluster's labels change length with the language - "退出" beside
  // "Sign out" - so a switch slid every control beside the one that was just clicked out from
  // under the pointer. Fixed-size controls are the fix, and this is the only place it is
  // observable: the widths are a fact about the painted layout, not about the components.
  const headerActionGeometry = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.app-header-actions .ant-btn'))
        .map((node) => {
          const box = node.getBoundingClientRect();
          return `${Math.round(box.x)},${Math.round(box.width)}`;
        })
        .join(' '),
    );
  await settleLayout(page);
  const geometryInChinese = await headerActionGeometry();
  check(
    'the header actions are measured before the language switch',
    geometryInChinese.split(' ').length === 4,
    `geometry=${JSON.stringify(geometryInChinese)}`,
  );

  const languageMenuButton = () => page.locator('.app-header').getByRole('button', { name: /Language|界面语言|介面語言|Bahasa/ });
  await languageMenuButton().click();
  const languageMenuItems = page.locator('.ant-dropdown:visible .language-menu-item');
  await languageMenuItems.first().waitFor({ timeout: 10_000 });
  check(
    'the header language menu lists the registered languages with their flags',
    (await languageMenuItems.count()) === 4
      && (await page.locator('.ant-dropdown:visible .language-flag svg').count()) === 4,
    `items=${await languageMenuItems.count()} flags=${await page.locator('.ant-dropdown:visible .language-flag svg').count()}`,
  );
  await languageMenuItems.filter({ hasText: /English/ }).click();
  let becameEnglish = false;
  await until(async () => {
    becameEnglish = /OMC Settings/.test(await page.locator('.omc-settings-page .terminal-title').innerText());
    return becameEnglish;
  }, { label: 'the header menu to switch the console to English' }).catch(() => {});
  check(
    'the header language menu switches the reading language and stores it',
    becameEnglish && (await page.evaluate(() => localStorage.getItem('omc-lang'))) === 'en',
  );
  // The menu names each language in its own script and is never translated. This is the state where a
  // translated name would appear, and the reason the rule exists: the reader this menu has to serve is
  // the one who cannot read the console's current language, so "Simplified Chinese" would hide the way
  // back for exactly that person.
  await languageMenuButton().click();
  await page.locator('.ant-dropdown:visible .language-menu-item').first().waitFor({ timeout: 10_000 });
  const menuNamesInEnglish = await page.locator('.ant-dropdown:visible .language-menu-item').allInnerTexts();
  check(
    'the language menu names each language in its own script in every reading',
    menuNamesInEnglish.length === 4
      && menuNamesInEnglish.some((text) => text.includes('简体中文'))
      && menuNamesInEnglish.some((text) => text.includes('繁體中文'))
      && menuNamesInEnglish.some((text) => text.includes('English'))
      && menuNamesInEnglish.some((text) => text.includes('Bahasa Melayu'))
      && !menuNamesInEnglish.some((text) => /Simplified Chinese/.test(text)),
    JSON.stringify(menuNamesInEnglish),
  );
  await languageMenuItems.filter({ hasText: /繁體中文/ }).click();
  let becameTraditionalChinese = false;
  await until(async () => {
    becameTraditionalChinese = /OMC 設定/.test(await page.locator('.omc-settings-page .terminal-title').innerText())
      && (await page.evaluate(() => document.documentElement.lang)) === 'zh-Hant';
    return becameTraditionalChinese;
  }, { label: 'the header menu to switch the console to Traditional Chinese' }).catch(() => {});
  check(
    'Traditional Chinese is a complete reading language with the Chinese unit scale',
    becameTraditionalChinese
      && (await page.evaluate(() => localStorage.getItem('omc-lang'))) === 'zh-Hant'
      && !(await chineseScaleOption().locator('input').isDisabled()),
  );

  await languageMenuButton().click();
  await page.locator('.ant-dropdown:visible .language-menu-item').filter({ hasText: /Bahasa Melayu/ }).click();
  let becameMalay = false;
  await until(async () => {
    becameMalay = /Tetapan OMC/.test(await page.locator('.omc-settings-page .terminal-title').innerText())
      && (await page.evaluate(() => document.documentElement.lang)) === 'ms-MY';
    return becameMalay;
  }, { label: 'the header menu to switch the console to Malay' }).catch(() => {});
  check(
    'Malay is a complete reading language and keeps the Chinese scale unavailable',
    becameMalay
      && (await page.evaluate(() => localStorage.getItem('omc-lang'))) === 'ms'
      && await chineseScaleOption().locator('input').isDisabled(),
  );

  await languageMenuButton().click();
  await page.locator('.ant-dropdown:visible .language-menu-item').filter({ hasText: /English/ }).click();
  await until(async () => /OMC Settings/.test(await page.locator('.omc-settings-page .terminal-title').innerText()), {
    label: 'the header menu to return the console to English',
  });
  await page.keyboard.press('Escape');
  await settleLayout(page);
  check(
    'a language switch does not move the header controls beside it',
    (await headerActionGeometry()) === geometryInChinese,
    `zh=${JSON.stringify(geometryInChinese)} en=${JSON.stringify(await headerActionGeometry())}`,
  );

  // ── a catalog whose chunk cannot be fetched ──────────────────────────────
  //
  // The additional catalogs are separate chunks, so a tab older than the deployment serving it asks
  // for a chunk name that no longer exists. Two failure modes came out of that, and neither is about
  // the copy the console prints: a stored language whose chunk could not be fetched left the provider
  // with nothing to render - a blank page, with no way out but clearing storage - and a switch that
  // failed leaked an unhandled rejection and cached it.
  //
  // Both are asserted on the console rather than on the string: a blank document, a leaked error, and
  // a stored preference overwritten by the fallback are the three things a reader would be left with.
  // The fetch is failed by aborting the chunk request, which is the same state a redeploy produces.
  // The browser refuses to re-fetch a module whose import has already failed in a document, so the
  // recovery asserted below is the reload, not a second click.
  const isCatalogChunk = (url) => /\/i18n\/locales\/ms(\.ts)?$/.test(url.pathname) || /\/assets\/ms-[^/]*\.js$/.test(url.pathname);
  const pageErrors = [];
  const collectPageError = (error) => pageErrors.push(String(error.message));
  page.on('pageerror', collectPageError);
  const abortCatalogChunk = async () => {
    await page.route('**/*', (route) => (isCatalogChunk(new URL(route.request().url())) ? route.abort() : route.fallback()));
  };
  const languageState = () => page.evaluate(() => ({
    lang: document.documentElement.lang,
    stored: localStorage.getItem('omc-lang'),
    // The page's own title, which is the copy actually on screen: a document attribute alone would be
    // satisfied by the markup the server sent, before React has rendered anything.
    title: document.querySelector('.omc-settings-page .terminal-title')?.textContent ?? '',
  }));

  // A fresh document, because the catalogs the earlier checks switched to are still in memory: a switch
  // would find them there without fetching anything, and the failure being asserted is the fetch's.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  const beforeBlockedSwitch = await languageState();
  await abortCatalogChunk();
  pageErrors.length = 0;
  await languageMenuButton().click();
  await page.locator('.ant-dropdown:visible .language-menu-item').filter({ hasText: /Bahasa Melayu/ }).click();
  // Long enough for a failed fetch to have landed: the assertion is that nothing changed, and a
  // shorter window would pass before the rejection existed.
  await sleep(1_000);
  const afterBlockedSwitch = await languageState();
  check(
    'a switch whose catalog cannot be fetched leaves the console readable and unchanged',
    afterBlockedSwitch.lang === beforeBlockedSwitch.lang
      && afterBlockedSwitch.stored === beforeBlockedSwitch.stored
      && afterBlockedSwitch.title === beforeBlockedSwitch.title,
    `before=${JSON.stringify(beforeBlockedSwitch)} after=${JSON.stringify(afterBlockedSwitch)}`,
  );
  check(
    'a catalog that failed to load raises no unhandled error',
    pageErrors.length === 0,
    JSON.stringify(pageErrors.slice(0, 2)),
  );
  await page.unroute('**/*');

  // A stored deferred language is reached before the first paint, so its chunk failing there is the
  // state that used to render nothing at all. Asserted through the rendered document, and through the
  // stored value: the console falls back to its default reading language, and the reader's own choice
  // is still stored for the load that can read it.
  await page.evaluate(() => localStorage.setItem('omc-lang', 'ms'));
  await abortCatalogChunk();
  pageErrors.length = 0;
  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  // Waited for by the copy that proves the page rendered *in the fallback language*: an empty document
  // and a document whose attributes say `zh-CN` while React has painted nothing both satisfy a weaker
  // reading, and "the console is still usable" is the claim.
  const fellBack = await until(async () => {
    const state = await languageState();
    return /OMC 设置/.test(state.title) ? state : false;
  }, { label: 'the console to render in its default language while the stored catalog is unreachable' }).catch(() => null);
  check(
    'a stored catalog that cannot be fetched renders the console in its default language',
    fellBack !== null && fellBack.lang === 'zh-CN' && fellBack.stored === 'ms',
    `state=${JSON.stringify(fellBack ?? await languageState())}`,
  );
  check(
    'the fallback does not raise an unhandled error either',
    pageErrors.length === 0,
    JSON.stringify(pageErrors.slice(0, 2)),
  );
  await page.unroute('**/*');
  page.off('pageerror', collectPageError);

  // The recovery path the fallback leaves open: the preferred language is still stored, so the load
  // that can fetch the chunk comes up in it rather than in the fallback.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const recovered = await until(async () => {
    const state = await languageState();
    return /Tetapan OMC/.test(state.title) ? state : false;
  }, { label: 'the stored language to load once its chunk is reachable again' }).catch(() => null);
  check(
    'the language a failed load could not print is still the stored choice',
    recovered !== null && recovered.lang === 'ms-MY' && recovered.stored === 'ms',
    `state=${JSON.stringify(recovered ?? await languageState())}`,
  );
  await page.evaluate(() => localStorage.setItem('omc-lang', 'en'));
}

