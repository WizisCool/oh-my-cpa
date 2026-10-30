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
  await settleLayout(page);
}

/** A pointer drag opens a tier of its own above the top one, and the lens walks the new order. */
export async function routingBoard({ base, page, check }) {
  // With motion on, as an operator has it: the page's entrance animation is part of what the
  // lifted card is positioned through, and reduced motion would remove it from the check.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openBoard(page, base);
  check('tiers follow stored priority, peers sharing a band', (await tierNames(page)).join(' > ') === 'Overflow seat+Primary seat > Anthropic Claude+Backup seat', (await tierNames(page)).join(' > '));
  // Before any model is chosen the route already says who carries traffic and who waits.
  check('the top tier says it serves and splits evenly', await tierText(page, 1).then((text) => text.includes('Serving requests') && text.includes('50%')), await tierText(page, 1));
  check('the tier below stands by', await tierText(page, 2).then((text) => text.includes('Standby until every tier above is unavailable')), await tierText(page, 2));

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
  // The lifted card is drawn where the hand took it. A route that grew as the drag began left it
  // tens of pixels off; the slack here is only the lifted card's own slight scale.
  const lifted = await page.locator('[class*="card-overlay"]').boundingBox();
  const pointer = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  check('the lifted card stays under the pointer',
    lifted && Math.abs(lifted.x + 40 - pointer.x) <= 4 && Math.abs(lifted.y + lifted.height / 2 - pointer.y) <= 4,
    JSON.stringify({ lifted, pointer }));
  await page.mouse.up();
  await until(async () => (await tierNames(page))[0] === 'Backup seat', { label: 'card landed in a new top tier' });
  check('dropping in the top gap opens a tier above the rest', (await tierNames(page)).join(' > ') === 'Backup seat > Overflow seat+Primary seat > Anthropic Claude', (await tierNames(page)).join(' > '));
  check('the move is one pending change', await page.getByText('1 change', { exact: true }).isVisible());
  check('the new tier is numbered above the old top', await page.locator('li[aria-label="Tier 1"]').innerText().then((text) => text.includes('Priority 20')), await page.locator('li[aria-label="Tier 1"]').innerText());

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
