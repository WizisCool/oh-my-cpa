/**
 * Theme and brand release acceptance: persisted light/dark selection, mobile
 * overflow, and the brand drawing's ink/accent following the console theme.
 */
export async function runThemeBrandAcceptance({
  appURL,
  page,
  check,
  until,
  measureStable,
  settleLayout,
}) {
/**
 * Reads a brand drawing's resolved source and its rendered ink.
 *
 * The pixel count is the part that matters: the light and dark drawings are separate files
 * with the same geometry, so a wrong or missing fill still loads, still reports a positive
 * naturalWidth, and still differs by filename. Only counting the drawn ink shows whether the
 * mark is actually visible against the surface it sits on.
 */
/**
 * Reads the brand mark's rendered ink straight off the inline SVG.
 *
 * The artwork used to be an `<img>`, so this decoded it to a canvas and counted pixels. It is inline
 * now - that is what lets its accent follow the theme token - so the fills are read from the
 * rendered elements instead. That is strictly better evidence for the claim being made: the previous
 * version proved *some* pixels were dark or light, while this reads the two colours the drawing
 * actually paints and can therefore assert the accent is the theme's accent.
 */
async function brandMarkState(page, selector = '.app-brand-logo') {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { src: '', naturalWidth: 0, darkPixels: 0, lightPixels: 0, hasDarkInk: false, hasLightInk: false, ink: '', accent: '' };
    // The mark is an inline `<svg>`; resolve the tokens on it so the returned colours are what the
    // browser painted rather than the `var()` reference.
    const inkGroup = root.querySelector('#main-text, [fill]:not(#accent-text)');
    const accentGroup = root.querySelector('#accent-text');
    const resolve = (node, fallbackNode) => {
      const target = node ?? fallbackNode;
      if (!target) return '';
      const colour = getComputedStyle(target).fill;
      if (colour && colour !== 'none') return colour;
      const fill = target.getAttribute('fill') ?? '';
      if (!fill.startsWith('var(')) return fill;
      // A `var()` reference resolves against an element's own computed style.
      const probe = document.createElement('span');
      probe.style.color = `var(${fill.slice(4, -1)})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const luminance = (colour) => {
      const parts = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      if (parts.length < 3) return null;
      const [r, g, b] = parts.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ink = resolve(inkGroup, root);
    const accent = resolve(accentGroup, null);
    const inkLuminance = luminance(ink);
    const box = root.getBoundingClientRect();
    return {
      src: root.tagName.toLowerCase(),
      naturalWidth: Math.round(box.width),
      darkPixels: inkLuminance !== null && inkLuminance < 0.4 ? 100 : 0,
      lightPixels: inkLuminance !== null && inkLuminance > 0.6 ? 100 : 0,
      hasDarkInk: inkLuminance !== null && inkLuminance < 0.4,
      hasLightInk: inkLuminance !== null && inkLuminance > 0.6,
      ink,
      accent,
      // The accent is only drawn by the wordmark; the standalone `o` has no accent marks.
      hasAccent: accentGroup !== null,
    };
  }, selector);
}

/**
 * Whether two CSS colours are the same, across the notations the two sides arrive in.
 *
 * The two are deliberately different: a computed style is always `rgb()`/`oklch()`, while a custom
 * property read with `getPropertyValue` is whatever the stylesheet wrote - a hex literal, here. A
 * matcher that only parsed one notation would compare `#005d8f` as the numbers 5 and 8 and report a
 * mismatch on two values that are in fact identical, which is exactly what happened.
 */
function sameColour(left, right) {
  const channels = (value) => {
    const text = String(value).trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(text);
    if (hex) {
      const digits = hex[1];
      return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
    }
    return (text.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => Math.round(Number(part)));
  };
  const a = channels(left);
  const b = channels(right);
  return a.length === 3 && b.length === 3 && a.every((value, index) => value === b[index]);
}

  await page.goto(`${appURL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('omc-theme', 'omc-light'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The stored theme is applied during hydration. Waiting for it is the readiness
  // signal both checks below depend on, and it is stronger than a pause: a
  // half-hydrated page can show the dark theme with correct geometry.
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'omc-light'), {
    label: 'the stored light theme to be applied after reload',
  });
  const mobileOverflow = await measureStable(
    () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { page, label: 'the light-mode mobile overflow measurement' },
  );
  check('390px light view has no document overflow', mobileOverflow <= 1, `overflow=${mobileOverflow}`);
  check('light theme is active', await page.evaluate(() => document.documentElement.dataset.theme === 'omc-light'));

  // ---- the brand mark follows the console's own theme ----
  // Checking the resolved source rather than the theme attribute: the two drawings are
  // separate files, so a wrong pick is invisible to every other assertion in this module.
  // It has to be the console's theme, not the OS scheme, because that setting can
  // contradict the operating system.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${appURL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('omc-theme', 'omc-light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'omc-light'), {
    label: 'the light theme before reading the brand mark',
  });
  const lightMark = await brandMarkState(page);
  check('the brand mark renders in the light theme', lightMark.naturalWidth > 0, `width=${lightMark.naturalWidth}`);
  check('the light wordmark renders near-black ink', lightMark.hasDarkInk, `ink=${lightMark.ink}`);
  // The accent inside the wordmark is the theme's accent, not a colour frozen in a file. This is the
  // assertion that would have caught the shipped mismatch: the artwork carried a hand-picked
  // `#00A3FD` while the console's accent was `#007AFF`, and nothing compared the two.
  const lightAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check(
    'the light wordmark draws its accent in the theme accent',
    lightMark.hasAccent && sameColour(lightMark.accent, lightAccent),
    `mark=${lightMark.accent} token=${lightAccent}`,
  );

  await page.evaluate(() => localStorage.setItem('omc-theme', 'omc-dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'omc-dark'), {
    label: 'the dark theme before reading the brand mark',
  });
  const darkMark = await brandMarkState(page);
  check('the brand mark renders in the dark theme', darkMark.naturalWidth > 0, `width=${darkMark.naturalWidth}`);
  check('the dark wordmark renders near-white ink', darkMark.hasLightInk, `ink=${darkMark.ink}`);
  const darkAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check(
    'the dark wordmark draws its accent in the theme accent',
    darkMark.hasAccent && sameColour(darkMark.accent, darkAccent),
    `mark=${darkMark.accent} token=${darkAccent}`,
  );
  // The two themes resolve different ink *and* different accents, so a mark that stopped following
  // the theme would fail here rather than merely looking slightly off.
  check('the two themes do not resolve the same ink', !sameColour(lightMark.ink, darkMark.ink), `light=${lightMark.ink} dark=${darkMark.ink}`);
  check('the two themes do not resolve the same accent', !sameColour(lightMark.accent, darkMark.accent), `light=${lightMark.accent} dark=${darkMark.accent}`);

  // The wordmark is left-aligned on the rail's own text axis, not centred, so it lines up
  // with the navigation below it.
  const markBox = await page.locator('.app-brand-logo').first().boundingBox();
  const navBox = await page.locator('.app-menu .ant-menu-item').first().boundingBox();
  check('the brand mark sits on the navigation column', markBox !== null && navBox !== null && Math.abs(markBox.x - navBox.x) <= 6, `mark.x=${markBox?.x} nav.x=${navBox?.x}`);
  check('the brand mark does not fill the rail', markBox !== null && markBox.width < 200, `width=${markBox?.width}`);

  // Collapsed, the rail cannot hold the wordmark, so it shows the O. That drawing has its
  // own colour pair, which is what the earlier per-file check could not catch.
  // The viewport was widened above, and `isMobile` is recomputed from a resize event, so the
  // click has to wait for that reflow: before it lands the rail is still 0px wide and the
  // toggle is not the control this step means to press.
  await settleLayout(page);
  const collapseToggle = page.getByRole('button', { name: /收起侧栏|Collapse sidebar/ });
  await collapseToggle.waitFor({ state: 'visible', timeout: 10000 });
  await collapseToggle.click();
  await until(async () => (await page.locator('.app-brand-collapsed').count()) > 0, {
    label: 'the collapsed rail to appear',
  });
  // The rail's width is animated, so the class appearing is the start of the transition,
  // not its end: measuring then reads a 236px rail and reports a mark that is really
  // centred as off-centre. Wait for the width itself to settle.
  await measureStable(
    () => page.evaluate(() => document.querySelector('.app-sider')?.getBoundingClientRect().width ?? 0),
    { page, label: 'the collapsed rail width' },
  );
  const collapsedMark = await brandMarkState(page, '.app-brand-collapsed svg');
  check('the collapsed rail shows a mark', collapsedMark.naturalWidth > 0, `width=${collapsedMark.naturalWidth}`);
  check('the collapsed mark renders visible ink on the rail', collapsedMark.hasLightInk, `ink=${collapsedMark.ink}`);
  const collapsedBox = await page.locator('.app-brand-collapsed svg').boundingBox();
  const railBox = await page.locator('.app-sider').boundingBox();
  check(
    'the collapsed mark is centred in the rail',
    collapsedBox !== null && railBox !== null && Math.abs((collapsedBox.x + collapsedBox.width / 2) - (railBox.x + railBox.width / 2)) <= 2,
    `markCentre=${collapsedBox ? collapsedBox.x + collapsedBox.width / 2 : null} railCentre=${railBox ? railBox.x + railBox.width / 2 : null}`,
  );
  await page.locator('.app-brand-collapsed').click();
  await page.evaluate(() => localStorage.setItem('omc-theme', 'omc-dark'));

}
