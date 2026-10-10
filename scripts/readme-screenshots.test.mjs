import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, windowDocument } from './readme-screenshots.mjs';
import { hasReadmeScreenshotContent } from './readme-screenshot-readiness.mjs';

const CAPTURE_OPTIONS = {
  routePath: '/dashboard', mode: 'light', lang: 'en',
  viewport: { width: 1440, height: 900, scale: 2 },
};

function createCaptureFixture(waitBeforeCapture) {
  let waitCount = 0;
  let evaluationCount = 0;
  let hasCaptured = false;
  let hasClosed = false;
  const page = {
    goto: async () => {},
    waitForFunction: async (predicate, selector, options) => {
      assert.equal(predicate, hasReadmeScreenshotContent);
      assert.equal(selector, '.dashboard-activity-row .heatmap-grid');
      assert.deepEqual(options, { timeout: 30_000 });
      waitCount += 1;
      if (waitCount === 2) await waitBeforeCapture();
    },
    evaluate: async (predicate) => {
      // The first wait passed before the late arrival toast mounted.
      if (predicate === hasReadmeScreenshotContent) return false;
      evaluationCount += 1;
      return evaluationCount === 3 ? 'rgb(255, 255, 255)' : undefined;
    },
    screenshot: async () => { hasCaptured = true; return Buffer.from('fixture'); },
  };
  const context = {
    addInitScript: async () => {},
    route: async () => {},
    newPage: async () => page,
    close: async () => { hasClosed = true; },
  };
  return {
    browser: { newContext: async () => context },
    readState: () => ({ waitCount, hasCaptured, hasClosed }),
  };
}

test('capture waits for late feedback to detach after fonts and chart frames settle', async () => {
  let releaseFeedback;
  let markWaiting;
  const feedbackDetached = new Promise(resolve => { releaseFeedback = resolve; });
  const isWaiting = new Promise(resolve => { markWaiting = resolve; });
  const fixture = createCaptureFixture(async () => {
    markWaiting();
    await feedbackDetached;
  });
  const captured = capture(fixture.browser, CAPTURE_OPTIONS);
  try {
    await Promise.race([
      isWaiting,
      captured.then(() => { throw new Error('captured without waiting for late feedback'); }),
    ]);
    assert.deepEqual(fixture.readState(), { waitCount: 2, hasCaptured: false, hasClosed: false });
    releaseFeedback();
    assert.deepEqual(await captured, {
      dataUrl: `data:image/png;base64,${Buffer.from('fixture').toString('base64')}`,
      background: 'rgb(255, 255, 255)',
    });
    assert.deepEqual(fixture.readState(), { waitCount: 2, hasCaptured: true, hasClosed: true });
  } finally {
    releaseFeedback();
    await captured.catch(() => {});
  }
});

test('capture propagates final readiness timeout without a screenshot and closes its context', async () => {
  const timeout = new Error('late feedback did not detach within the readiness deadline');
  const fixture = createCaptureFixture(async () => { throw timeout; });
  await assert.rejects(capture(fixture.browser, CAPTURE_OPTIONS), error => error === timeout);
  assert.deepEqual(fixture.readState(), { waitCount: 2, hasCaptured: false, hasClosed: true });
});

test('feature windows render one capture and dashboard windows render both themes', () => {
  const light = { dataUrl: 'data:image/png;base64,light', background: '#ffffff' };
  const dark = { dataUrl: 'data:image/png;base64,dark', background: '#131215' };
  for (const shot of [light, dark]) {
    const html = windowDocument(shot);
    assert.equal((html.match(/<img /g) ?? []).length, 1);
    assert.ok(html.includes(`src="${shot.dataUrl}"`));
    assert.ok(html.includes(`style="background:${shot.background}"`));
    assert.ok(html.includes('class="window"'));
    assert.ok(!html.includes('<svg'));
    assert.ok(!html.includes('class="layer split"'));
  }
  const hero = windowDocument(light, dark);
  assert.equal((hero.match(/<img /g) ?? []).length, 2);
  assert.ok(hero.includes('class="layer split"'));
  assert.ok(hero.includes('<svg class="divider"'));
});
