import path from 'node:path';

/**
 * The manual refresh and the layout sweeps: the facets a refresh re-reads, and every
 * supported viewport's overflow.
 */
export async function refreshAndLayoutSection(context) {
  const {
    root,
    page,
    check,
    checkEventually,
    measureStable,
    responseBodies,
    clickSettled,
    autoRefreshSwitch,
  } = context;


  // Switching the poll off again keeps the rest of the audit deterministic.
  await autoRefreshSwitch.click();
  check('auto-refresh turns off again', !(await autoRefreshSwitch.isChecked()));

  // A manual refresh is the other event that re-reads the facets: the operator
  // asked for current data, and stale dropdown counts are on screen too.
  const manualFacets = [];
  const countManualFacet = (request) => {
    if (request.url().includes('/usage/facets')) manualFacets.push(request.url());
  };
  page.on('request', countManualFacet);
  // The evidence is a network event, so the wait is for that event. A flat window
  // could only hope the request had already happened, and would report the count
  // as zero when the machine was merely slow.
  const facetRefresh = page
    .waitForRequest((request) => request.url().includes('/usage/facets'), { timeout: 10000 })
    .catch(() => null);
  await page.locator('.terminal-page-head .request-actions button').last().click();
  const facetRefreshLanded = (await facetRefresh) !== null;
  page.off('request', countManualFacet);
  check('a manual refresh re-reads the facets', facetRefreshLanded && manualFacets.length >= 1, `requests=${manualFacets.length}`);
  await page.screenshot({ path: path.join(root, 'tmp', 'req-page-desktop.png') });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 800 });
    // Measured once it stops moving instead of after a flat pause: the property
    // the old sleep was guessing at is that the responsive reflow has finished.
    const overflow = await measureStable(
      () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)),
      { page, label: 'the request page overflow measurement' },
    );
    check(`request records ${width}px viewport has no overflow`, overflow === 0, `overflow=${overflow}`);
    const actionsFit = await page.evaluate(() => {
      const actions = document.querySelector('.usage-events-page .terminal-page-head .request-actions');
      if (!actions) return -1;
      const box = actions.getBoundingClientRect();
      // The action group must stay inside the viewport it sits in.
      return Math.round(box.right - window.innerWidth);
    });
    check(`request records ${width}px header actions stay in view`, actionsFit <= 1, `rightOverhang=${actionsFit}`);

    // The panel and the time dialog are the two surfaces that only exist while
    // open, so the closed-page overflow check above cannot see them.
    await page.locator('.req-more-filters').click();
    await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
    const drawerOverflow = await measureStable(
      () =>
        page.evaluate(() => {
          const panel = document.querySelector('.req-filter-drawer .ant-drawer-body');
          if (!panel) return -1;
          // Content wider than the panel is the failure mode a narrow viewport
          // exposes: a range pair whose inputs cannot shrink pushes the dialog off
          // screen.
          return Math.round(panel.scrollWidth - panel.clientWidth);
        }),
      { page, label: 'the filter drawer overflow measurement' },
    );
    check(`filter drawer fits at ${width}px`, drawerOverflow <= 1, `drawerOverflow=${drawerOverflow}`);
    const drawerOnScreen = () =>
      page.evaluate(() => {
        const root = document.querySelector('.req-filter-drawer');
        if (!root) return 'no root';
        // The positioning element is not guaranteed to be a fixed class name in
        // antd v6, so the check walks the drawer's own elements and requires that
        // at least one sizing box sits inside the viewport.
        const boxes = [root, ...root.querySelectorAll('*')]
          .map((node) => ({ node, box: node.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 100 && box.height > 100);
        if (boxes.length === 0) {
          return `no sized element; classes=${root.className} inner=${root.innerHTML.slice(0, 200)}`;
        }
        const offender = boxes.find(({ box }) => box.left < -1 || box.right > window.innerWidth + 1);
        if (offender) {
          return `${offender.node.className} left=${Math.round(offender.box.left)} right=${Math.round(offender.box.right)} viewport=${window.innerWidth}`;
        }
        return true;
      });
    // The assertion is also the wait. The drawer slides in from the right, so a
    // fixed pause either samples it mid-slide - reporting an off-screen panel as a
    // failure, which is what a flat 250ms did here - or wastes the rest of the
    // window on a drawer that arrived immediately.
    await checkEventually(
      `filter drawer stays on screen at ${width}px`,
      async () => (await drawerOnScreen()) === true,
      { detail: async () => String(await drawerOnScreen()) },
    );
    await page.locator('[data-testid="req-filter-cancel"]').click();
    await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });

    await clickSettled('.req-time-button', 'the time-range control');
    // The trigger opens the preset menu; the absolute dialog is a menu item, so a
    // click on the trigger alone never opens it.
    await page
      .locator('.ant-dropdown-menu-item')
      .filter({ hasText: /自定义时间|Custom range/ })
      .first()
      .click();
    await page.locator('.req-time-modal').waitFor({ state: 'visible', timeout: 10000 });
    const modalOnScreen = () =>
      page.evaluate(() => {
        const dialog = document.querySelector('.req-time-modal');
        if (!dialog) return 'no dialog';
        const box = dialog.getBoundingClientRect();
        if (box.left < -1 || box.right > window.innerWidth + 1) {
          return `left=${Math.round(box.left)} right=${Math.round(box.right)} viewport=${window.innerWidth}`;
        }
        return true;
      });
    // Same shape as the drawer above: the dialog scales into place, so the
    // placement assertion waits for it rather than sampling a fixed pause after
    // it became nominally visible.
    await checkEventually(
      `custom time dialog stays on screen at ${width}px`,
      async () => (await modalOnScreen()) === true,
      { detail: async () => String(await modalOnScreen()) },
    );
    await page.keyboard.press('Escape');
    await page.locator('.req-time-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The detail drawer's copy control sits inside a container that traps focus, which
  // is exactly what makes it worth a browser assertion: a copy path that attaches its
  // scratch element outside the drawer selects nothing, and `execCommand('copy')`
  // answers `true` for that empty selection - so the console announced a copy that
  // never happened. A toast therefore proves nothing. The value is pasted back out of
  // the browser's own pipeline instead, with the drawer closed, because its focus trap
  // would keep the probe input from taking focus while it is open.
  await page.locator('.request-row').first().click();
  await page.locator('.request-detail-id').waitFor({ state: 'visible', timeout: 10000 });
  const drawerRequestId = (await page.locator('.request-detail-id span').first().innerText()).trim();
  const drawerCopyMessage = page.locator('.ant-message').getByText(/已复制|Copied/);
  // Waited for rather than edited away: the message nodes belong to React, and removing
  // one detaches the holder the next message is rendered into, so the copy below would
  // report itself nowhere. Waiting for a leftover carrying this text also keeps the
  // assertion below from passing on a toast an earlier step left behind.
  await drawerCopyMessage.waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
  await page.locator('.request-detail-id').getByRole('button').first().click();
  // The app's own statement that the copy completed, rather than a fixed pause that
  // only guesses when it did.
  await checkEventually(
    'the request detail copy control reports a copy it made',
    async () => (await drawerCopyMessage.count()) > 0,
    { label: "the drawer's copy success message" },
  );
  await page.keyboard.press('Escape');
  // Waited for rather than tolerated: a drawer still closing leaves a mask over the
  // page, and the probe input below could not take focus through it.
  await page.locator('.request-detail-id').waitFor({ state: 'hidden', timeout: 10000 });
  await page.locator('.ant-drawer-mask').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => undefined);
  await page.evaluate(() => {
    const probe = document.createElement('input');
    probe.setAttribute('data-copy-probe', '');
    probe.style.position = 'fixed';
    probe.style.top = '0';
    probe.style.left = '-9999px';
    probe.value = '';
    document.body.appendChild(probe);
    probe.focus();
  });
  await page.keyboard.press('Control+V');
  const pastedRequestId = await page.evaluate(() => document.querySelector('input[data-copy-probe]')?.value ?? '');
  await page.evaluate(() => document.querySelector('input[data-copy-probe]')?.remove());
  check(
    'the request detail copy control puts the id on the clipboard',
    drawerRequestId.length > 0 && pastedRequestId === drawerRequestId,
    `match=${pastedRequestId === drawerRequestId} pastedLength=${pastedRequestId.length} expectedLength=${drawerRequestId.length}`,
  );

  responseBodies.length = 0;
}
