/** Browser-only owner of activity motion, clipping and contrast while rough progress is held. */
export async function checkWaitingActivity({ base, page, check }, selector, { shouldChangeTheme = false } = {}) {
  const progress = page.locator(selector);
  const moduleUrl = `${new URL(base).pathname}/src/utils/progressTasks.ts`;
  // A settled burst brings the estimate forward; enough new work then holds it below that frontier.
  await page.evaluate(async ({ moduleUrl, selector }) => {
    const { beginProgressTask } = await import(moduleUrl);
    const settleTasks = Array.from({ length: 19 }, () => beginProgressTask());
    for (const settleTask of settleTasks) settleTask();
  }, { moduleUrl, selector });
  await page.waitForFunction(selector => {
    const fill = document.querySelector(selector)?.querySelector('.progress-bar-fill');
    return fill && new DOMMatrix(getComputedStyle(fill).transform).a >= 0.95;
  }, selector);
  await page.evaluate(async ({ moduleUrl, selector }) => {
    const { beginProgressTask } = await import(moduleUrl);
    window.__progressElement = document.querySelector(selector);
    window.__progressAnimation = window.__progressElement.querySelector('.progress-bar-activity-mark').getAnimations()[0];
    window.__progressActivityTime = window.__progressAnimation?.currentTime;
    window.__settleLateProgressTasks = Array.from({ length: 100 }, () => beginProgressTask());
  }, { moduleUrl, selector });
  try {
    await page.waitForFunction(() => window.__progressAnimation?.currentTime > window.__progressActivityTime);
    check(`${selector}: activity advances on its own animation clock`, await progress.evaluate(root =>
      root.querySelector('.progress-bar-activity-mark').getAnimations()[0] === window.__progressAnimation));
    await progress.evaluate(root => {
      const animation = root.querySelector('.progress-bar-activity-mark').getAnimations()[0];
      animation.pause();
    });

    const viewports = shouldChangeTheme
      ? [{ width: 1280, mode: 'light' }, { width: 375, mode: 'dark' }]
      : [{ width: 1280 }, { width: 375 }];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: 800 });
      if (viewport.mode) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (await page.evaluate(mode => document.documentElement.dataset.themeMode === mode, viewport.mode)) break;
          await page.getByRole('button', { name: /^Theme:/ }).click();
        }
        check(`${selector}/${viewport.mode}: the real theme control selects the test mode`,
          await page.evaluate(mode => document.documentElement.dataset.themeMode === mode, viewport.mode));
      }
      const samples = [];
      for (const phase of [0, 300, 600, 1200]) {
        samples.push(await progress.evaluate(async (root, phase) => {
          const mark = root.querySelector('.progress-bar-activity-mark');
          const animation = mark.getAnimations()[0];
          animation.pause();
          animation.currentTime = phase;
          await new Promise(resolve => requestAnimationFrame(resolve));
          const fill = root.querySelector('.progress-bar-fill');
          const windowBounds = root.querySelector('.progress-bar-activity-window').getBoundingClientRect();
          const markBounds = mark.getBoundingClientRect();
          const rootBounds = root.getBoundingClientRect();
          return {
            scale: new DOMMatrix(getComputedStyle(fill).transform).a,
            x: new DOMMatrix(getComputedStyle(mark).transform).e,
            opacity: Number(getComputedStyle(mark).opacity),
            fillOpacity: Number(getComputedStyle(fill).opacity),
            color: getComputedStyle(mark).backgroundColor,
            fillColor: getComputedStyle(fill).backgroundColor,
            width: rootBounds.width,
            height: rootBounds.height,
            windowWidth: windowBounds.width,
            markWidth: markBounds.width,
            windowRight: windowBounds.right,
            frontier: rootBounds.left + rootBounds.width * new DOMMatrix(getComputedStyle(fill).transform).a,
            isSameRoot: root === window.__progressElement,
            isSameAnimation: animation === window.__progressAnimation,
            isBusy: root.getAttribute('aria-busy') === 'true',
            hasAccessiblePercentage: root.hasAttribute('aria-valuenow'),
            contentTop: root.parentElement.getBoundingClientRect().top,
          };
        }, phase));
      }
      const [start, early, later, wrap] = samples;
      const detail = JSON.stringify(samples);
      check(`${selector}/${viewport.width}: a held estimate still has a visibly moving activity segment`,
        early.x < later.x && early.opacity > 0 && later.opacity > 0 &&
        samples.every(sample => sample.scale === start.scale && sample.scale < 1 && sample.isBusy), detail);
      check(`${selector}/${viewport.width}: the cycle wraps while invisible`, start.opacity === 0 && wrap.opacity === 0, detail);
      check(`${selector}/${viewport.width}: the marker stays within the rough frontier and its small-area budget`,
        samples.every(sample => sample.windowWidth <= 64 && sample.windowWidth <= sample.width * 0.16 + 0.1 &&
          sample.markWidth <= 16 && sample.windowRight <= sample.frontier + 0.1 && sample.height === 2), detail);
      check(`${selector}/${viewport.width}: the activity uses a stronger version of the fill's theme color`,
        early.color === early.fillColor && early.fillOpacity === 0.65 && early.opacity > early.fillOpacity, detail);
      check(`${selector}/${viewport.width}: frames keep root and animation identity without layout movement or numeric claims`,
        samples.every(sample => sample.isSameRoot && sample.isSameAnimation && !sample.hasAccessiblePercentage &&
          sample.contentTop === start.contentTop), detail);
    }
  } finally {
    await page.evaluate(() => {
      window.__progressAnimation?.play();
      for (const settle of window.__settleLateProgressTasks ?? []) settle();
      delete window.__settleLateProgressTasks;
    });
    await page.setViewportSize({ width: 1280, height: 800 });
  }
}
