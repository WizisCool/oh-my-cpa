import { until, settleLayout } from '../harness.mjs';

const member = (key, name, priority, kind = 'credential', overrides = {}) => ({
  key, kind, id: key.split(':')[1], family: kind === 'provider' ? 'claude' : 'codex', name, priority,
  weights: [{ index: 0, auth_index: `auth-${key}`, weight: null }],
  key_count: 1, is_disabled: false, is_unavailable: false, is_runtime_only: false, ...overrides,
});

const BOARD = {
  revision: 'rev-1',
  settings: {
    strategy: 'round-robin', session_affinity: false, session_affinity_ttl: '', request_retry: 2,
    max_retry_credentials: 0, max_retry_interval: 30, disable_cooling: false, transient_error_cooldown_seconds: 0,
    force_model_prefix: false,
  },
  members: [
    member('credential:primary.json', 'Primary seat', 10),
    member('credential:overflow.json', 'Overflow seat', 10),
    member('provider:claude-0', 'Anthropic Claude', 0, 'provider', { key_count: 2, weights: [{ index: 0, weight: 2 }, { index: 1, weight: null }] }),
    member('credential:backup.json', 'Backup seat', 0),
  ],
  partial: [],
};

const MODELS = {
  models: {
    'credential:primary.json': ['gpt-x'],
    'credential:overflow.json': ['gpt-x'],
    'provider:claude-0': ['claude-x'],
    'credential:backup.json': ['gpt-x'],
  },
  unknown: [],
};

export function routingBoardFixtures() {
  return [
    [(url) => url.pathname.endsWith('/preferences'), () => ({ preferences: { provider_icons: { 'claude-0': 'OpenCode' } } })],
    [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [{ id: 'claude-0', family: 'claude', name: 'Anthropic Claude' }], total: 1 })],
    [(url) => url.pathname.endsWith('/management/routing'), () => BOARD],
    [(url) => url.pathname.endsWith('/management/routing/models'), () => MODELS],
  ];
}

const tierNames = (page) => page.locator('[data-testid="routing-page"] ol > li[aria-label^="Tier"]').evaluateAll((tiers) =>
  tiers.map((tier) => [...tier.querySelectorAll('[data-member]')].map((card) => card.getAttribute('aria-label')).join('+')));

const tierText = (page, n) => page.locator(`li[aria-label="Tier ${n}"]`).innerText();

async function openBoard(page, base) {
  await page.goto(`${base}/routing`, { waitUntil: 'domcontentloaded' });
  const cards = page.locator('[data-testid="routing-page"] [data-member]');
  await until(async () => await cards.count() === BOARD.members.length, { label: 'routing cards' });
  await page.locator('[data-member="provider:claude-0"] span[style*="opencode.svg"]').waitFor({ state: 'visible' });
  await settleLayout(page);
}

/**
 * A card dragged along its tier changes only where it is drawn; dragged onto a link it opens a tier
 * of its own, and the lens walks the new order.
 */
export async function routingBoard({ base, page, check }) {
  // With motion on, as an operator has it: the page's entrance animation is part of what the
  // lifted card is positioned through, and reduced motion would remove it from the check.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openBoard(page, base);
  const selectedMark = page.locator('[data-member="provider:claude-0"] span[style*="opencode.svg"]');
  check('routing uses the saved connection mark instead of its protocol brand', await selectedMark.evaluate(node => getComputedStyle(node).maskImage.includes('/omc/lobe-icons/opencode.svg')));
  check('tiers follow stored priority, peers sharing a band', (await tierNames(page)).join(' > ') === 'Overflow seat+Primary seat > Anthropic Claude+Backup seat', (await tierNames(page)).join(' > '));
  // Before a model is chosen no member is known to serve a request, so the route shows its order
  // and strategy but no share of traffic.
  check('without a model the top tier is tried first and shows no share',
    await tierText(page, 1).then((text) => text.includes('Tried first') && text.includes('Shared in turn') && !text.includes('%')), await tierText(page, 1));
  check('the tier below stands by', await tierText(page, 2).then((text) => text.includes('Standby until every tier above is unavailable')), await tierText(page, 2));

  // Along its tier a card trades places live and the drop keeps them, as the operator's own display
  // order: it is stored as a preference and is no change to the plan.
  const overflow = await page.locator('[data-member="credential:overflow.json"]').boundingBox();
  const primary = await page.locator('[data-member="credential:primary.json"]').boundingBox();
  const savedOrder = page.waitForResponse((response) => response.url().endsWith('/preferences/routing_card_order') && response.request().method() === 'PUT');
  await page.mouse.move(overflow.x + 40, overflow.y + overflow.height / 2);
  await page.mouse.down();
  await page.mouse.move(primary.x + primary.width * 0.8, primary.y + primary.height / 2, { steps: 12 });
  await until(async () => (await tierNames(page))[0] === 'Primary seat+Overflow seat', { label: 'the tier to sort as the card passes' });
  await page.mouse.up();
  check('a card dragged along its tier keeps its new place', (await tierNames(page))[0] === 'Primary seat+Overflow seat', (await tierNames(page)).join(' > '));
  check('the order along a tier is stored as a display preference', (await savedOrder).ok());
  check('the order along a tier is no change to the plan', await page.getByText(/^\d+ changes?$/).count() === 0);

  const card = page.locator('[data-member="credential:backup.json"]');
  const from = await card.boundingBox();
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 - 12, { steps: 4 });
  const gap = page.locator('[data-testid="routing-page"] [data-gap="0"]');
  await until(async () => (await gap.getAttribute('class'))?.includes('link-active'), { label: 'links become drop targets while dragging' });
  const target = await gap.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await until(async () => (await gap.getAttribute('class'))?.includes('link-over'), { label: 'gap highlighted under the pointer' });
  const hovered = await gap.boundingBox();
  check('a link under the card keeps its height', Math.abs(hovered.height - target.height) < 1, JSON.stringify({ before: target.height, over: hovered.height }));
  // The lifted card is drawn where the hand took it. A route that grew as the drag began left it
  // tens of pixels off; the slack here is only the lifted card's own slight scale.
  const lifted = await page.locator('[class*="card-overlay"]').boundingBox();
  const pointer = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  check('the lifted card stays under the pointer',
    lifted && Math.abs(lifted.x + 40 - pointer.x) <= 4 && Math.abs(lifted.y + lifted.height / 2 - pointer.y) <= 4,
    JSON.stringify({ lifted, pointer }));
  // Sampled frame by frame from before the drop: the tier the drop opens unfolds into the route
  // rather than appearing between two frames.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'false');
  const unfolding = sampleLadder(page);
  await page.mouse.up();
  await until(async () => (await tierNames(page))[0] === 'Backup seat', { label: 'card landed in a new top tier' });
  const opened = (await unfolding).map((frame) => frame.backupTier).filter((height) => height !== null);
  check('a tier a drop opens unfolds over several frames', growsOverFrames(opened), JSON.stringify(opened.map(Math.round)));
  check('an unfolding tier runs to its height without a stall', movesWithoutStall(opened, opened.at(-1)), JSON.stringify(opened.map(Math.round)));
  check('dropping in the top gap opens a tier above the rest', (await tierNames(page)).join(' > ') === 'Backup seat > Primary seat+Overflow seat > Anthropic Claude', (await tierNames(page)).join(' > '));
  check('the move is one pending change', await page.getByText('1 change', { exact: true }).isVisible());
  check('the new tier is numbered above the old top', await page.locator('li[aria-label="Tier 1"]').innerText().then((text) => text.includes('Priority 20')), await page.locator('li[aria-label="Tier 1"]').innerText());

  // A tier a move closes folds away where it stood, and is never read as a tier while it does.
  const backup = page.locator('[data-member="credential:backup.json"]');
  const standing = (await page.locator('[data-testid="routing-page"] li[aria-label="Tier 1"]').boundingBox()).height;
  const folding = sampleLadder(page, { isFold: true });
  await backup.getByRole('button', { name: 'Change tier' }).click();
  await page.getByRole('button', { name: 'Move down a tier' }).click();
  await until(async () => (await tierNames(page)).length === 2, { label: 'moving the lone card down closes its tier' });
  const folded = await folding;
  const leavingHeights = folded.map((frame) => frame.leaving).filter((height) => height !== null);
  check('a tier a move closes folds away over several frames', shrinksOverFrames(leavingHeights), JSON.stringify(leavingHeights.map(Math.round)));
  // Its cards leave with the move, but not their space: the fold starts from the height the tier
  // stood at and closes without a jolt.
  // Its first moving frame is the one a jolt would show; later frames a busy machine drops are not.
  const firstStep = standing - (leavingHeights.find((height) => standing - height > 0.5) ?? standing);
  check('a folding tier starts at its own height and closes without a jolt',
    firstStep <= standing * 0.35 && leavingHeights.at(-1) <= 2,
    JSON.stringify({ standing: Math.round(standing), firstStep: Math.round(firstStep), frames: leavingHeights.map(Math.round) }));
  check('a folding tier closes without a stall', movesWithoutStall(leavingHeights, 0), JSON.stringify(leavingHeights.map((height) => +height.toFixed(1))));
  check('a folding tier is never read as a tier', folded.every((frame) => frame.isEveryTierFilled));
  await until(() => page.locator('[data-testid="routing-page"] ol > li[aria-hidden="true"]:not([data-gap])').count().then((count) => count === 0), { label: 'the folded tier is gone' });
  // Back to the arrangement the drop made, for the checks below.
  await backup.getByRole('button', { name: 'Change tier' }).click();
  await page.getByRole('button', { name: 'Own tier above' }).click();
  await until(async () => (await tierNames(page))[0] === 'Backup seat', { label: 'the card takes its own tier again' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'true');

  const lens = page.getByRole('combobox', { name: 'Model' });
  await lens.click();
  await page.locator('.ant-select-item-option[title="gpt-x"]').waitFor({ state: 'visible' });
  await lens.fill('gpt-x');
  await lens.press('Enter');
  await until(async () => (await tierText(page, 3)).includes('Does not serve this model'), { label: 'lens narrows the route' });
  check('the top tier serves all of it', await page.locator('[data-member="credential:backup.json"]').innerText().then((text) => text.includes('100%')));
  check('the tier without the model is skipped', (await tierText(page, 3)).includes('requests skip this tier'), await tierText(page, 3));

  const home = page.locator('.app-menu [data-route-path="/dashboard"]').first();
  await home.click();
  const leaveDialog = page.getByRole('dialog').filter({ hasText: 'Leave routing?' });
  await leaveDialog.waitFor();
  await leaveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await leaveDialog.waitFor({ state: 'hidden' });
  check('declining departure keeps the routing arrangement', new URL(page.url()).pathname.endsWith('/routing') && (await tierNames(page))[0] === 'Backup seat');
  check('declining departure returns focus to the navigation control', await home.evaluate(element => element === document.activeElement || element.contains(document.activeElement)));
  await home.click();
  await leaveDialog.waitFor();
  await leaveDialog.getByRole('button', { name: 'Leave page', exact: true }).click();
  await page.waitForURL(url => url.pathname.endsWith('/dashboard'));
  check('confirmed departure opens the chosen page', new URL(page.url()).pathname.endsWith('/dashboard'));
}

/**
 * Reads the ladder on every animation frame for half a second, from now: the height of a top tier
 * holding only the backup card, the height of a tier folding away, and whether every tier the page
 * names holds a card.
 */
function sampleLadder(page, { isFold = false } = {}) {
  return page.evaluate((isFold) => new Promise((resolve) => {
    const samples = [];
    const start = performance.now();
    const tick = () => {
      const ladder = document.querySelector('[data-testid="routing-page"] ol');
      const top = ladder?.querySelector(':scope > li[aria-label="Tier 1"]');
      const leaving = ladder?.querySelector(':scope > li[aria-hidden="true"]:not([data-gap])');
      const named = [...(ladder?.querySelectorAll(':scope > li[aria-label^="Tier"]') ?? [])];
      samples.push({
        backupTier: top && top.textContent.includes('Backup seat') && !top.textContent.includes('Anthropic') ? top.getBoundingClientRect().height : null,
        leaving: leaving ? leaving.getBoundingClientRect().height : null,
        isEveryTierFilled: named.every((tier) => tier.querySelector('[data-member]')),
      });
      // A fold is followed until its tier is gone: a fixed window would cut it short on a busy
      // machine and read its tail as a stall.
      const isDone = isFold
        ? samples.some((sample) => sample.leaving !== null) && !leaving
        : performance.now() - start >= 500;
      if (!isDone && performance.now() - start < 3000) requestAnimationFrame(tick);
      else resolve(samples);
    };
    tick();
  }), isFold);
}

/** From its lowest frame, at least three frames strictly between that and the settled height. */
function growsOverFrames(heights) {
  const lowest = heights.indexOf(Math.min(...heights));
  const rising = heights.slice(lowest);
  if (rising.length < 4) return false;
  const final = rising.at(-1);
  const between = rising.filter((height) => height > rising[0] + 1 && height < final - 1);
  return rising[0] < final / 2 && between.length >= 3;
}

/**
 * Once a fold or unfold is moving, it slows only as it arrives. A frame that barely moved while still
 * short of where the motion ends is a stall, and a stall is followed by the snap that finishes it.
 */
function movesWithoutStall(heights, end) {
  const start = heights.findIndex((height, index) => index > 0 && Math.abs(height - heights[index - 1]) > 0.5);
  if (start < 0) return false;
  return heights.every((height, index) => index <= start || Math.abs(height - heights[index - 1]) >= 0.5 || Math.abs(height - end) <= 2);
}

function shrinksOverFrames(heights) {
  if (heights.length < 4) return false;
  return heights.filter((height, index) => index > 0 && height < heights[index - 1] - 0.5).length >= 3;
}

/** On a phone the board is arranged through each card's menu and fits the screen. */
export async function routingBoardPhone({ base, page, check }) {
  await openBoard(page, base);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('the board fits a phone without horizontal scrolling', overflow <= 0, `overflow=${overflow}`);
  const card = page.locator('[data-member="credential:backup.json"]');
  await card.getByRole('button', { name: 'Change tier' }).click();
  await page.getByRole('button', { name: 'Move up a tier' }).click();
  await until(async () => (await tierNames(page))[0].includes('Backup seat'), { label: 'menu move' });
  check('a menu move joins the tier above', (await tierNames(page))[0] === 'Overflow seat+Primary seat+Backup seat', (await tierNames(page)).join(' > '));

  const failover = page.getByRole('button', { name: /^Failover/ });
  await failover.scrollIntoViewIfNeeded();
  await failover.click();
  const cooling = page.getByRole('switch', { name: 'Disable Credential Cooling', exact: true });
  await cooling.scrollIntoViewIfNeeded();
  await settleLayout(page);
  await page.locator('.app-content').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await settleLayout(page);
  const lastSetting = await cooling.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = element.closest('.settings-toggle-row').getBoundingClientRect();
    const bar = document.querySelector('.config-dirty-bar').getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return { canHit: element === hit || element.contains(hit), rowBottom: row.bottom, barTop: bar.top };
  });
  const canReachSetting = lastSetting.canHit && lastSetting.rowBottom <= lastSetting.barTop - 4;
  check('the last policy label and control scroll above the save bar', canReachSetting, JSON.stringify(lastSetting));
  if (canReachSetting) {
    await cooling.click();
    check('the phone can change the last policy setting with a pending draft', await cooling.getAttribute('aria-checked') === 'true');
  }
}
