import { fulfillFixture } from '../browser-guard.mjs';
import { settleLayout, until } from '../harness.mjs';

const KNOWN_COOLDOWN_REASON = JSON.stringify({ error: { code: 'credential_quota', message: 'Fixture quota exhausted' } });

const files = Array.from({ length: 12 }, (_, index) => {
  // auth-12 is the reset-credit credential, and it is Codex: the redemption action exists
  // only there, so a fixture that borrowed another provider would prove nothing.
  const provider = index === 11 ? 'codex' : ['codex', 'claude', 'kimi', 'xai'][index % 4];
  return {
    name: `credential-${String(index + 1).padStart(2, '0')}.json`,
    auth_index: `auth-${String(index + 1).padStart(2, '0')}`,
    type: provider,
    provider,
    disabled: false,
    unavailable: false,
    runtime_only: false,
    email: `operator-${index + 1}@example.test`,
    success: 20 - index,
    failed: index % 3,
    priority: index === 0 ? 0 : 1,
    weight: 1,
    note: index % 2 === 0 ? 'Production credential' : undefined,
  };
});

function quotaFor(index) {
  const sixWindows = index === 3;
  const windows = Array.from({ length: sixWindows ? 6 : 2 }, (_, windowIndex) => ({
    id: `auth-${String(index + 1).padStart(2, '0')}-window-${windowIndex}`,
    label: sixWindows ? `Model group ${Math.floor(windowIndex / 2) + 1} · Window ${windowIndex % 2 + 1}` : `Window ${windowIndex + 1}`,
    // The grouped provider answers with a period rather than a kind, which is what the row
    // has to read; the flat records keep the explicit kind.
    kind: sixWindows ? undefined : (windowIndex === 0 ? 'five_hour' : 'weekly'),
    period_hours: windowIndex % 2 === 0 ? 5 : 168,
    scope: sixWindows ? 'group' : 'standard',
    used_percent: 20 + windowIndex * 5,
    remaining_percent: 80 - windowIndex * 5,
    reset_at_ms: Date.now() + (windowIndex + 1) * 3_600_000,
    // Only the first credential carries an estimate, so the record beside it is the same
    // row without one. The figures are four-digit dollars: the widest reading a row has to fit.
    ...(index === 0 ? {
      usage: { from_ms: Date.now() - 3_600_000, to_ms: Date.now(), requests: 420, priced_requests: 420, tokens: 61_250_000, cost_nanos: 308_500_000_000 },
      ...(windowIndex === 1 ? { capacity_unavailable: 'low_usage' } : {}),
      capacity: { tokens: 245_000_000, cost_nanos: 1_234_000_000_000, error_percent: 2.5, basis: windowIndex === 0 ? 'current_cycle' : 'previous_cycle', observed_at_ms: Date.now() - 86_400_000 },
    } : index === 1 ? { capacity_unavailable: 'scope_unknown' } : {}),
  }));
  const cooldown = index === 8 || index === 9;
  const unsupported = index === 10;
  const credits = index === 11;
  return {
    auth_index: files[index].auth_index,
    name: files[index].name,
    type: files[index].type,
    provider: files[index].provider,
    disabled: false,
    status: cooldown ? 'cooldown' : unsupported ? 'idle' : 'healthy',
    observed_at_ms: Date.now(),
    plan: { plan_type: 'pro', plan_label: 'Pro', tier: 'premium', ...(index === 3 ? { subscription_active: false } : {}) },
    windows,
    active_cooldown: cooldown ? { is_active: true, reason: index === 9 ? KNOWN_COOLDOWN_REASON : 'Fixture unexpected upstream cooldown', recover_at_ms: Date.now() + 900_000 } : undefined,
    // The bank holds two credits while upstream considers none of them applicable right
    // now. That combination is exactly the reported defect: the action must still exist.
    reset_credits: credits ? { available_count: 2, applicable_available_count: 0 } : undefined,
    recommendation: { status: cooldown ? 'cooldown' : 'healthy', priority: cooldown ? 'high' : 'none', action: cooldown ? 'clear_cooldown' : 'none', reason: '' },
    capabilities: {
      refresh_supported: !unsupported,
      clear_cooldown_supported: cooldown,
      reset_credit_supported: credits,
    },
    ...(index === 9 ? { error: 'Fixture quota refresh failed' } : {}),
    quota_exceeded: false,
  };
}

const quota = Array.from({ length: files.length }, (_, index) => quotaFor(index));

export async function oauthManagement({ base, page, check }) {
  const oauthStarts = [];
  const redeemPosts = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/management/oauth/start')) oauthStarts.push(request.url());
    // Redemption spends a real entitlement, so the probe records every request rather than
    // letting the mocked network hide an action that fired without confirmation.
    if (request.method() === 'POST' && request.url().includes('/management/quota/redeem-credit')) redeemPosts.push(request.url());
  });

  await page.goto(`${base}/oauth-management?density=compact`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="oauth-credential-record"]').first().waitFor({ state: 'visible', timeout: 20_000 });
  const providerTabs = await page.locator('.oauth-management-page .ant-tabs-tab').allInnerTexts();
  check(
    'provider strip has one All tab and no authorization-only Anthropic duplicate',
    providerTabs.filter((label) => /^All\b/.test(label.trim())).length === 1
      && providerTabs.some((label) => /^Claude\b/.test(label.trim()))
      && !providerTabs.some((label) => /^Anthropic\b/.test(label.trim())),
    providerTabs.join(' | '),
  );


  check('the collection presents a single overview with no density switch', (await page.locator('.oauth-management-page .ant-segmented').count()) === 0);
  const compactVisible = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="oauth-credential-record"]')];
    return rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0;
    }).length;
  });
  console.log(`OAuth density: ${page.viewportSize().width}x${page.viewportSize().height}, compact=${compactVisible}`);
  await page.screenshot({ path: 'tmp/oauth-management-compact-desktop.png' });
  check(
    'oauth management shows at least six complete records at 1440x900',
    compactVisible >= 6,
    `visible=${compactVisible}`,
  );

  const firstRecord = page.getByTestId('oauth-credential-record').first();
  check('explicit zero priority and default weight remain visible',
    (await firstRecord.innerText()).includes('Priority 0') && (await firstRecord.innerText()).includes('Weight 1'));

  // The row answers "can this credential serve the next request" without a click, so the
  // credential's own family carries both bars, and its way into the rest is one Details link.
  const twoWindowRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-01"]');
  check(
    'a compact record bars its five-hour and weekly windows',
    (await twoWindowRow.locator('[data-quota-compact-window="five_hour"]').count()) === 1
      && (await twoWindowRow.locator('[data-quota-compact-window="weekly"]').count()) === 1
      && (await twoWindowRow.locator('[data-quota-compact-window] .ant-progress').count()) === 2,
    (await twoWindowRow.innerText()).replace(/\n/g, ' | '),
  );
  const plainRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-02"]');
  const compactHeight = (row) => row.locator('[data-quota-density="compact"]').evaluate((body) => body.getBoundingClientRect().height);
  const [estimatedHeight, plainHeight] = [await compactHeight(twoWindowRow), await compactHeight(plainRow)];
  const compactEstimates = await twoWindowRow.locator('[data-quota-compact-capacity]').evaluateAll((cells) => cells.map((cell) => ({
    text: cell.textContent,
    clipped: cell.scrollWidth > cell.clientWidth + 1,
  })));
  check(
    'a compact record carries each window\'s estimated capacity without growing or clipping it',
    compactEstimates.length === 2
      && compactEstimates.every((cell, index) => cell.text === (index === 0 ? '≈$1,230' : 'Prev ≈$1,230') && !cell.clipped)
      && Math.abs(estimatedHeight - plainHeight) <= 0.5
      && (await plainRow.locator('[data-quota-compact-capacity]').count()) === 0,
    `estimates=${JSON.stringify(compactEstimates)} heights=${estimatedHeight}/${plainHeight}`,
  );
  check(
    'a compact record reaches the full reading through its own Details action',
    (await twoWindowRow.getByRole('button', { name: /^(Details|详情):/i }).count()) === 1,
  );

  const groupRecord = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-04"]');
  const groupLabels = await groupRecord
    .locator('[data-quota-compact-window]')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-quota-window-label') ?? ''));
  check(
    'a compact record never shows a model family it does not belong to',
    groupLabels.length === 2
      && groupLabels.every((label) => label.startsWith('Model group 1'))
      && !groupLabels.some((label) => label.includes('Model group 2') || label.includes('Model group 3')),
    groupLabels.join(' | '),
  );
  check('an explicitly inactive subscription is visible in its compact reading', await groupRecord.locator('[data-subscription-inactive]').isVisible());
  await groupRecord.getByRole('button', { name: /^(Details|详情):/i }).click();
  const detailPanel = page.locator('.ant-drawer-open');
  await detailPanel.locator('[data-quota-density="expanded"]').waitFor();
  check('an explicitly inactive subscription is visible in credential details', await detailPanel.locator('[data-subscription-inactive]').isVisible());
  check('quota tab shows every model group without unrelated configuration',
    (await detailPanel.locator('.ant-progress').count()) === 6
      && (await detailPanel.innerText()).includes('Model group 3 · Window 2')
      && !(await detailPanel.locator('#note').isVisible()));
  const labels = await detailPanel.locator('[class*=progress-label-row]').allInnerTexts();
  check('quota windows stay grouped in source order', labels[0]?.includes('Model group 1') && labels[1]?.includes('Model group 1') && labels[2]?.includes('Model group 2'), labels.join(' | '));
  await settleLayout(page);
  await page.screenshot({ path: 'tmp/oauth-management-quota-drawer.png' });
  await detailPanel.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await detailPanel.locator('#note').fill('Keep this draft while checking quota');
  await detailPanel.getByRole('button', { name: 'Add mapping', exact: true }).click();
  await detailPanel.getByRole('textbox', { name: 'Upstream model 1', exact: true }).fill('gpt-5');
  await detailPanel.getByRole('textbox', { name: 'Client alias 1', exact: true }).fill('credential-gpt');
  await detailPanel.getByRole('textbox', { name: 'Display name 1', exact: true }).fill('Credential GPT');
  await detailPanel.getByRole('checkbox', { name: 'Force mapping', exact: true }).check();
  const aliasEntry = detailPanel.locator('li').filter({ has: page.getByRole('textbox', { name: 'Client alias 1', exact: true }) });
  await aliasEntry.scrollIntoViewIfNeeded();
  await settleLayout(page);
  await page.screenshot({ path: 'tmp/oauth-credential-aliases-desktop.png' });
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await settleLayout(page);
  await aliasEntry.scrollIntoViewIfNeeded();
  check('credential alias fields stay inside the phone drawer', await aliasEntry.evaluate((node) => node.scrollWidth <= node.clientWidth && [...node.querySelectorAll('input')].every((input) => input.getBoundingClientRect().right <= window.innerWidth)));
  await page.screenshot({ path: 'tmp/oauth-credential-aliases-phone.png' });
  await page.setViewportSize(desktopViewport);
  await settleLayout(page);
  await detailPanel.getByRole('tab', { name: 'Quota', exact: true }).click();
  check('configuration fields stay outside the quota tab', !(await detailPanel.locator('#note').isVisible()));
  await detailPanel.getByRole('tab', { name: /Configuration/ }).click();
  check('switching tabs preserves an unsaved configuration draft',
    (await detailPanel.locator('#note').inputValue()) === 'Keep this draft while checking quota');
  check('credential aliases share the guarded configuration draft',
    await detailPanel.getByRole('textbox', { name: 'Client alias 1', exact: true }).inputValue() === 'credential-gpt'
      && await detailPanel.getByRole('checkbox', { name: 'Force mapping', exact: true }).isChecked());
  await detailPanel.getByRole('tab', { name: 'Quota', exact: true }).click();
  await detailPanel.locator('.ant-drawer-close').click();
  const discard = page.locator('.ant-modal-confirm');
  await discard.waitFor();
  check('closing from quota still guards a dirty configuration tab', await discard.isVisible());
  await discard.getByRole('button', { name: /Confirm/ }).click();
  await detailPanel.waitFor({ state: 'hidden' });

  const unsupportedRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-11"]');
  check(
    'an unsupported live probe still renders its observed primary window',
    (await unsupportedRow.locator('[data-quota-unsupported="true"]').count()) > 0
      && (await unsupportedRow.getByText('80%').count()) > 0,
    `unsupported=${await unsupportedRow.locator('[data-quota-unsupported="true"]').count()}`,
  );
  const cooldownRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-10"]');
  check('a known credential_quota reason is consolidated into the CPA cooldown status',
    await cooldownRow.getByText('CPA Cooldown', { exact: true }).isVisible()
      && !(await cooldownRow.innerText()).includes('credential_quota')
      && await cooldownRow.locator('[class*="rec-banner-danger"]').count() === 0);
  await cooldownRow.getByText('CPA Cooldown', { exact: true }).hover();
  const cooldownTooltip = page.getByRole('tooltip').filter({ hasText: 'CPA 429 rate limit protection active' });
  await cooldownTooltip.waitFor({ state: 'visible' });
  check('the consolidated cooldown status explains the known condition', (await cooldownTooltip.innerText()).includes('CPA 429 rate limit protection active'));
  await cooldownRow.getByRole('button', { name: /^(Details|详情):/i }).click();
  await detailPanel.locator('[data-quota-density="expanded"]').waitFor();
  check('the quota drawer retains raw cooldown evidence and refresh failure diagnostics',
    (await detailPanel.innerText()).includes(KNOWN_COOLDOWN_REASON)
      && (await detailPanel.innerText()).includes('Fixture quota refresh failed'));
  await detailPanel.locator('.ant-drawer-close').click();
  await detailPanel.waitFor({ state: 'hidden' });
  const unexpectedCooldownRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-09"]');
  check('an unexpected cooldown reason remains readable in the compact row',
    await unexpectedCooldownRow.getByText('Fixture unexpected upstream cooldown', { exact: true }).isVisible());
  await cooldownRow.getByRole('button', { name: /More actions|更多操作/i }).click();
  const cooldownItem = page.getByRole('menuitem', { name: /Clear Cooldown|清除冷却/i });
  check('an active cooldown stays actionable through the row menu', await cooldownItem.isEnabled());
  await page.keyboard.press('Escape');

  const creditRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-12"]');
  check(
    'a row reports the banked reset credits it holds',
    (await creditRow.getByText(/Available 2|可用 2 个/).count()) > 0,
  );
  check(
    'the row itself offers no reset-credit action',
    (await creditRow.getByRole('button', { name: /Reset quota|重置额度/i }).count()) === 0,
    'spending a credit is irreversible and belongs in the Drawer beside the expiries it consumes',
  );
  await creditRow.getByRole('button', { name: /More actions|更多操作/i }).click();
  check(
    'the row menu offers no reset-credit action either',
    (await page.locator('.ant-dropdown-menu').getByRole('menuitem', { name: /Reset quota|重置额度/i }).count()) === 0,
  );
  await page.keyboard.press('Escape');

  await creditRow.getByRole('button', { name: /^Details:/ }).click();
  await page.locator('.ant-drawer-open [data-quota-density="expanded"]').waitFor();
  const drawerRedeem = page.locator('.ant-drawer-open').getByRole('button', { name: /Reset quota|重置额度/i });
  check('the Drawer carries the reset-credit action', (await drawerRedeem.count()) === 1);

  await drawerRedeem.click();
  const redeemConfirm = page.locator('.ant-popconfirm');
  await redeemConfirm.waitFor();
  check('the reset action asks for confirmation before spending a credit', await redeemConfirm.isVisible());
  await redeemConfirm.getByRole('button', { name: /Cancel|取消/i }).click();
  await redeemConfirm.waitFor({ state: 'hidden' });
  check('cancelling spends nothing', redeemPosts.length === 0, `posts=${redeemPosts.length}`);

  await drawerRedeem.click();
  const confirmed = page.locator('.ant-popconfirm');
  await confirmed.waitFor();
  await confirmed.getByRole('button', { name: /Confirm|确定/i }).click();
  await page.getByText(/Credit redeemed successfully|积分重置成功/).waitFor({ timeout: 10_000 });
  check('confirming in the Drawer issues exactly one redemption request', redeemPosts.length === 1, `posts=${redeemPosts.length}`);

  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await page.locator('.ant-drawer-open').waitFor({ state: 'hidden' });

  await page.goto(`${base}/oauth-management`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="oauth-credential-record"]').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('button', { name: /OAuth sign-in/i }).click();
  await page.locator('[data-testid="oauth-connect-panel"]').waitFor({ state: 'visible', timeout: 5000 });
  await settleLayout(page);
  const picker = page.locator('#oauth-connect-provider');
  await picker.click();
  await page.getByTitle('Codex OAuth', { exact: true }).last().click();
  check('selecting a Connect provider makes no authorization request', oauthStarts.length === 0, `starts=${oauthStarts.length}`);
  await page.locator('[data-oauth-start="codex"]').click();
  await until(() => oauthStarts.length > 0, { label: 'the explicit OAuth start request' });
  check('Start authorization issues exactly one request', oauthStarts.length === 1, `starts=${oauthStarts.length}`);
  await page.getByRole('button', { name: 'Cancel Authorization', exact: true }).waitFor({ state: 'visible' });
  // Minimize the active session through the drawer's explicit dismissal control.
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
  check(
    'a minimized authorization remains visible in the workspace strip',
    (await page.getByTestId('oauth-session-pill').count()) > 0,
    `sessions=${await page.getByTestId('oauth-session-pill').count()}`,
  );

  await page.goto(`${base}/oauth?provider=codex`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/oauth-management**', { timeout: 10_000 });
  await page.locator('[data-testid="oauth-connect-panel"]').waitFor({ state: 'visible', timeout: 10_000 });
  check(
    'old provider-specific sign-in URL opens Connect without an automatic start',
    oauthStarts.length === 1,
    `starts=${oauthStarts.length}`,
  );
  await page.keyboard.press('Escape');

  // A status read that never reaches CPA must not end the attempt: the operator may
  // still be completing sign-in, and a terminal panel offers only a Retry that opens a
  // second upstream session. These fixtures answer this attempt's first status read
  // with 502 and its second with success, so the poll armed before the failure has to
  // land the completion on its own.
  const startsBeforeBlip = oauthStarts.length;
  await page.getByRole('button', { name: /OAuth sign-in|OAuth 登录/i }).click();
  const blipPanel = page.locator('[data-testid="oauth-connect-panel"]');
  await blipPanel.waitFor({ state: 'visible', timeout: 10_000 });
  // The panel keeps the provider a previous block selected, so the provider is chosen
  // through the same selector the operator uses rather than through the tile grid.
  await blipPanel.locator('#oauth-connect-provider').click();
  await page.getByTitle('Meta Muse OAuth', { exact: true }).last().click();
  await page.locator('[data-oauth-start="meta"]').click();
  await blipPanel.locator('[data-oauth-user-code]').waitFor({ state: 'visible', timeout: 10_000 });
  check(
    'the device attempt opens exactly one authorization session',
    oauthStarts.length === startsBeforeBlip + 1,
    `starts=${oauthStarts.length - startsBeforeBlip}`,
  );

  await blipPanel.getByRole('button', { name: /Check Authorization Status|检查授权状态/i }).click();
  await blipPanel.locator('[data-oauth-status-read-failure]').waitFor({ state: 'visible', timeout: 10_000 });
  const cancelWhileUnread = await blipPanel.getByRole('button', { name: /Cancel Authorization|取消授权/i }).count();
  const retryWhileUnread = await blipPanel.getByRole('button', { name: /^Retry$|^重试$/ }).count();
  check(
    'a status read that fails before CPA answers leaves the attempt waiting and cancellable',
    cancelWhileUnread === 1 && retryWhileUnread === 0,
    `cancel=${cancelWhileUnread} retry=${retryWhileUnread}`,
  );

  const blipCompleted = await blipPanel
    .getByRole('button', { name: /Sign in another account|登录其他账号/i })
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(
    'the poll armed before the failed read still completes the attempt',
    blipCompleted,
    `completed=${blipCompleted}`,
  );
  const completionToast = page.locator('.omc-toast').filter({
    has: page.getByRole('button', { name: /View credentials|查看凭证/i }),
  });
  await completionToast.waitFor({ state: 'visible', timeout: 10_000 });
  check(
    'workspace completion reports once through its credential-aware toast',
    await page.locator('.omc-toast').count() === 1,
    `toasts=${await page.locator('.omc-toast').count()}`,
  );
  await page.keyboard.press('Escape');

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${base}/oauth-management?density=compact`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="oauth-credential-record"]').first().waitFor({ state: 'visible', timeout: 20_000 });
    const layout = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('[data-testid="oauth-credential-record"] button, [data-testid="oauth-credential-record"] input')];
      const outside = controls.filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1);
      }).length;
      return {
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        controls: controls.length,
        outside,
      };
    });
    check(
      `oauth management reflows without horizontal overflow at ${width}px`,
      layout.overflow === 0 && layout.controls > 0 && layout.outside === 0,
      JSON.stringify(layout),
    );
    const phoneEstimates = await page.locator('[data-auth-index="auth-01"] [data-quota-compact-capacity]').evaluateAll((cells) => cells.map((cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth + 1 && cell.scrollWidth <= cell.clientWidth + 1;
    }));
    check(
      `a phone row shows each estimated capacity whole at ${width}px`,
      phoneEstimates.length === 2 && phoneEstimates.every(Boolean),
      JSON.stringify(phoneEstimates),
    );
    await page.screenshot({ path: `tmp/oauth-management-overview-${width}.png` });
    await page.getByTestId('oauth-credential-record').first().getByRole('button', { name: /^Details:/ }).click();
    const phoneDrawer = page.locator('.ant-drawer-open');
    await phoneDrawer.getByRole('tab', { name: 'Quota', exact: true }).waitFor();
    await settleLayout(page);
    const drawerOverflow = await phoneDrawer.evaluate((drawer) => drawer.querySelector('.ant-drawer-body').scrollWidth - drawer.querySelector('.ant-drawer-body').clientWidth);
    check(`tabbed quota drawer has no horizontal overflow at ${width}px`, drawerOverflow <= 1, `overflow=${drawerOverflow}`);
    // Recorded usage and the estimate wrap onto their own lines here; neither may leave the panel.
    const drawerEstimates = await phoneDrawer.evaluate((drawer) => {
      const panel = drawer.querySelector('.ant-drawer-body').getBoundingClientRect();
      return [...drawer.querySelectorAll('[data-quota-capacity="estimated"] > span')].map((part) => {
        const rect = part.getBoundingClientRect();
        return rect.width > 0 && rect.left >= panel.left - 1 && rect.right <= panel.right + 1;
      });
    });
    check(
      `the quota drawer keeps recorded usage and the estimate inside the panel at ${width}px`,
      drawerEstimates.length === 5 && drawerEstimates.every(Boolean)
        && (await phoneDrawer.locator('[data-quota-capacity-hint]').isVisible())
        && (await phoneDrawer.locator('[data-quota-capacity-basis="previous_cycle"]').innerText()).includes('Previous cycle estimate'),
      JSON.stringify(drawerEstimates),
    );
    await page.screenshot({ path: `tmp/oauth-management-drawer-${width}.png` });
    await phoneDrawer.locator('.ant-drawer-close').click();
    await phoneDrawer.waitFor({ state: 'hidden' });
    const filterToggle = page.getByRole('button', { name: /Filters|筛选|篩選|Penapis/i }).first();
    check(
      `oauth management exposes one mobile filter disclosure at ${width}px`,
      await filterToggle.isVisible() && (await page.locator('#oauth-connect-provider').count()) === 0,
    );
    await filterToggle.click();
    check(
      `the mobile filter disclosure reveals the collection controls at ${width}px`,
      (await page.locator('.oauth-management-page .ant-select').count()) >= 3,
    );
  }
}


async function verifyFullTokenCapacity({ base, page, check }) {
  const tokenQuota = structuredClone(quota);
  const previousWindow = tokenQuota[0].windows[1];
  previousWindow.capacity.tokens = 123_456_789_012_345;
  delete previousWindow.capacity.cost_nanos;
  const quotaPattern = '**/api/v1/management/quota';
  const quotaHandler = (route) => route.fulfill({ json: { quotas: tokenQuota, total: tokenQuota.length } });
  await page.route(quotaPattern, quotaHandler);
  const setTokenStyle = (style) => page.evaluate(async (value) => {
    const response = await fetch('/omc/api/v1/preferences/omc_token_style', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error('Token style preference write failed');
  }, style);
  try {
    await setTokenStyle('full');
    for (const width of [1440, 375, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await page.goto(`${base}/oauth-management?density=compact`, { waitUntil: 'domcontentloaded' });
      const previousEstimate = page.locator('[data-auth-index="auth-01"] [data-quota-compact-window="weekly"] [data-quota-compact-capacity]');
      await until(async () => (await previousEstimate.innerText()) === 'Prev ≈123,456,789,012,345 tokens', {
        label: 'the previous-cycle token estimate in full-digit style',
      });
      await until(async () => page.getByTestId('oauth-credential-record').first().evaluate((element) => {
        return getComputedStyle(element).gridTemplateColumns.split(' ').length === (window.innerWidth <= 640 ? 1 : 6);
      }), { label: 'the credential row to adopt the target viewport' });
      await settleLayout(page);
      const geometry = await previousEstimate.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const windowBounds = element.closest('[data-quota-compact-window]').getBoundingClientRect();
        const textRange = document.createRange();
        textRange.selectNodeContents(element);
        const fragments = [...textRange.getClientRects()];
        return {
          text: element.textContent,
          isContained: bounds.width > 0 && bounds.left >= windowBounds.left - 1 && bounds.right <= windowBounds.right + 1
            && element.scrollWidth <= element.clientWidth + 1
            && fragments.every((fragment) => fragment.left >= windowBounds.left - 1 && fragment.right <= windowBounds.right + 1),
          overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        };
      });
      check(
        `the full-digit previous-cycle token estimate stays readable within its window at ${width}px`,
        geometry.text === 'Prev ≈123,456,789,012,345 tokens' && geometry.isContained && geometry.overflow === 0,
        JSON.stringify(geometry),
      );
    }
  } finally {
    await page.unroute(quotaPattern, quotaHandler);
    await setTokenStyle('en-compact');
  }

}

async function verifyPluginConnections({ base, page, check, oauthStarts }) {
  // An auth-provider interface also serves API-key plugins. Their own page must
  // remain reachable without starting the interactive login method they reject.
  const plugins = [
    {
      id: 'key-bridge', configured: true, registered: true, enabled: true,
      effective_enabled: true, supports_oauth: true, oauth_provider: 'key-service',
      metadata: { name: 'Key Bridge' }, config_fields: [],
      pages: [{ path: '/v0/resource/plugins/key-bridge/console', label: 'Key credentials' }],
    },
    {
      id: 'interactive-auth', configured: true, registered: true, enabled: true,
      effective_enabled: true, supports_oauth: true, oauth_provider: 'interactive',
      metadata: { name: 'Interactive Auth' }, config_fields: [], pages: [],
    },
  ];
  await page.route('**/management/plugins', (route) => route.fulfill({ json: { plugins, total: plugins.length } }));
  await page.route('**/plugin-host/v0/resource/plugins/key-bridge/console', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Key credentials</title><h1>Import API key</h1>',
  }));
  let pluginFlow = 'device';
  await page.route('**/management/oauth/start', (route) => {
    const provider = route.request().postDataJSON().provider;
    if (provider !== 'interactive') return route.fallback();
    return route.fulfill({ json: {
      url: 'https://auth.example.test/authorize', state: 'plugin-session',
      ...(pluginFlow === 'device' ? { flow: 'device', user_code: 'PLUGIN-CODE' } : {}),
    } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const openPluginConnection = async (provider) => {
    await page.goto(`${base}/oauth-management`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('oauth-credential-record').first().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /OAuth sign-in/i }).click();
    await page.locator(`button[data-oauth-card="${provider}"]`).click();
    await page.locator('[data-testid="oauth-connect-panel"]').waitFor({ state: 'visible' });
  };
  await openPluginConnection('key-service');
  const pluginPanel = page.getByTestId('oauth-connect-panel');
  check('an API-key auth provider is plugin-managed rather than an OAuth redirect',
    (await pluginPanel.getByText('Plugin-managed', { exact: true }).count()) === 1
      && (await pluginPanel.getByText('Key Bridge', { exact: true }).count()) > 0
      && (await pluginPanel.getByText('Redirect callback', { exact: true }).count()) === 0
      && (await pluginPanel.locator('[data-oauth-start]').count()) === 0);
  const startsBeforePluginPage = oauthStarts.length;
  await pluginPanel.locator('[data-plugin-connect="key-service"]').click();
  await page.waitForURL('**/plugin-pages/key-bridge/0');
  await page.locator('[data-plugin-page="key-bridge"]').waitFor({ state: 'visible' });
  check('opening plugin credentials sends no OAuth start request', oauthStarts.length === startsBeforePluginPage);

  for (const flow of ['device', 'redirect']) {
    pluginFlow = flow;
    await openPluginConnection('interactive');
    check(`plugin ${flow} flow is not assumed before Start`,
      (await pluginPanel.getByText('Plugin-managed', { exact: true }).count()) === 1);
    await pluginPanel.locator('[data-oauth-start="interactive"]').click();
    if (flow === 'device') {
      await pluginPanel.locator('[data-oauth-user-code]').waitFor({ state: 'visible' });
      check('a real plugin device response exposes its code but no callback input',
        (await pluginPanel.getByText('Device code', { exact: true }).count()) > 0
          && (await pluginPanel.locator('[data-oauth-callback-input]').count()) === 0);
    } else {
      await pluginPanel.getByText('Redirect callback', { exact: true }).waitFor({ state: 'visible' });
      check('a legacy plugin login URL and state retain manual callback support',
        (await pluginPanel.locator('[data-oauth-callback-input]').count()) === 1);
    }
  }
}


async function checkOAuthModelRules({ page, base, check }) {
  await page.goto(`${base}/oauth-management`);
  await page.getByTestId('oauth-management-model-rules-open').first().waitFor();
  const writes = [];
  let aliasState = { claude: [{ name: 'claude-sonnet-4', alias: 'sonnet-latest', fork: true }] };
  let exclusionState = { codex: ['gpt-5-mini', 'gpt-4*'] };
  await page.route('**/management/auth-files/model-aliases', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      writes.push(body);
      aliasState = { ...aliasState, [body.provider]: body.aliases };
      await route.fulfill({ json: { status: 'ok', provider: body.provider, aliases: body.aliases } });
    } else await route.fulfill({ json: { aliases: aliasState } });
  });
  await page.route('**/management/auth-files/excluded-models', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      writes.push(body);
      exclusionState = { ...exclusionState, [body.provider]: body.models };
      await route.fulfill({ json: { status: 'ok', provider: body.provider, models: body.models } });
    } else await route.fulfill({ json: { excluded_models: exclusionState } });
  });
  const openRules = page.getByTestId('oauth-management-model-rules-open').first();
  await openRules.click();
  const drawer = page.getByTestId('oauth-model-rules-drawer');
  await drawer.locator('[data-alias-field="alias"]').waitFor({ state: 'visible' });
  const closeButton = drawer.getByRole('button', { name: 'Close', exact: true });
  const closeBounds = await closeButton.boundingBox();
  const drawerBounds = await drawer.boundingBox();
  check('model rules keep the close action at the trailing header edge',
    closeBounds.x > drawerBounds.x + drawerBounds.width / 2);
  const provider = drawer.getByTestId('oauth-model-rules-provider');
  const identity = provider.getByTestId('oauth-model-rules-provider-identity');
  check('model rules use the provider tab name and mark in the selected control',
    (await identity.innerText()) === 'Claude' && (await identity.locator('img, [aria-hidden="true"]').count()) > 0
      && (await provider.getAttribute('data-provider')) === 'claude');
  await drawer.locator('[data-alias-field="alias"]').fill('sonnet-preview');
  await drawer.getByTestId('oauth-model-rules-tab-excluded').click();
  await drawer.getByTestId('oauth-excluded-models-rule-input').fill('claude-3*');
  await drawer.getByTestId('oauth-excluded-models-rule-add').click();
  await drawer.getByTestId('oauth-model-rules-tab-aliases').click();
  check('switching sections preserves the alias draft and marks both unsaved tabs',
    (await drawer.locator('[data-alias-field="alias"]').inputValue()) === 'sonnet-preview'
      && (await drawer.getByRole('img', { name: 'Unsaved changes', exact: true }).count()) === 2);
  await drawer.getByTestId('oauth-model-rules-save').click();
  await until(() => drawer.getByTestId('oauth-model-rules-save').isDisabled());
  check('saving aliases writes only that section while exclusion drafts remain protected',
    writes.length === 1 && writes[0].provider === 'claude' && writes[0].aliases[0].alias === 'sonnet-preview'
      && (await provider.getByRole('combobox').isDisabled()));
  await drawer.getByTestId('oauth-model-rules-tab-excluded').click();
  check('the other section still has its draft after the alias save',
    (await drawer.locator('[data-rule="claude-3*"]').count()) === 1);
  await page.goBack();
  const discard = page.locator('.ant-modal-confirm').last();
  await discard.waitFor({ state: 'visible' });
  await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
  await discard.waitFor({ state: 'hidden' });
  check('declining native Back leaves the rules and draft visible', await drawer.locator('[data-rule="claude-3*"]').isVisible());
  await drawer.getByTestId('oauth-model-rules-revert').click();
  const picker = provider.getByRole('combobox');
  await picker.fill('Codex');
  const codexOption = page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Codex' });
  await codexOption.waitFor({ state: 'visible' });
  check('provider options carry tab names and brand artwork', (await codexOption.locator('img, [aria-hidden="true"]').count()) > 0);
  await codexOption.click();
  await drawer.locator('[data-model="gpt-4.1"]').waitFor({ state: 'visible' });
  const wildcardModel = drawer.locator('[data-model="gpt-4.1"]').getByRole('checkbox');
  check('catalog models covered by a wildcard cannot be unchecked independently',
    await wildcardModel.isChecked() && await wildcardModel.isDisabled());
  await drawer.getByTestId('oauth-excluded-models-rule-input').fill('*');
  await drawer.getByTestId('oauth-excluded-models-rule-add').click();
  await drawer.getByTestId('oauth-model-rules-save').click();
  await until(() => drawer.getByTestId('oauth-model-rules-save').isDisabled());
  check('global exclusion write preserves existing rules and targets the provider key',
    writes.length === 2 && writes[1].provider === 'codex' && writes[1].models.join(',') === 'gpt-5-mini,gpt-4*,*');
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await settleLayout(page);
    await until(() => drawer.evaluate((element) => element.getBoundingClientRect().left >= -1));
    const geometry = await drawer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const body = element.querySelector('.ant-drawer-body');
      const footer = element.querySelector('.ant-drawer-footer').getBoundingClientRect();
      return { left: rect.left, right: rect.right, bodyOverflow: body.scrollWidth - body.clientWidth, footerBottom: footer.bottom };
    });
    check(`model rules ${width}px stay within the viewport and keep the footer reachable`,
      geometry.left >= -1 && geometry.right <= width + 1 && geometry.bodyOverflow <= 1 && geometry.footerBottom <= 901,
      JSON.stringify(geometry));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goBack();
  await drawer.waitFor({ state: 'hidden' });
  check('native Back closes the saved rules without leaving the OAuth workspace', page.url().includes('/oauth-management'));
  await openRules.click();
  await drawer.getByTestId('oauth-model-rules-tab-excluded').click();
  await drawer.locator('[data-rule="claude-3*"]').waitFor({ state: 'hidden' });
  check('a discarded section draft is not resurrected when the drawer reopens', (await drawer.locator('[data-rule="claude-3*"]').count()) === 0);
  await drawer.locator('.ant-drawer-close').click();
  await drawer.waitFor({ state: 'hidden' });
  await page.unroute('**/management/auth-files/model-aliases');
  await page.unroute('**/management/auth-files/excluded-models');
}

export const oauthManagementFixtures = {
  files,
  quota,
  routes: [
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/auth-files/safe-fields'), url => {
      const file = files.find(file => file.name === url.searchParams.get('name'));
      return { name:file?.name, priority:file?.priority, weight:file?.weight, note:file?.note??'', disable_cooling:false, websockets:false, using_api:false, model_aliases:[], excluded_models:[] };
    }],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/auth-files/models'), () => ({models:[]})],
    [(url) => url.pathname.endsWith('/management/auth-files'), () => ({ files, total: files.length })],
    [(url) => url.pathname.endsWith('/management/quota'), () => ({
      summary: { total_credentials: quota.length, healthy_count: quota.length, warning_count: 0, exhausted_count: 0, cooldown_count: 0, attention_count: 0 },
      quotas: quota,
      total: quota.length,
    })],
    // Confirming a redemption is mocked here: the real call spends an entitlement, so the
    // probe only proves the request is issued once, from the enabled action.
    [(url, method) => method === 'POST' && url.pathname.endsWith('/management/quota/redeem-credit'), () => ({ status: 'ok', quota: quota[11] })],
    [(url) => url.pathname.endsWith('/management/auth-files/model-aliases'), () => ({ aliases: { claude: [{ name: 'claude-sonnet-4', alias: 'sonnet-latest', fork: true }] } })],
    [(url) => url.pathname.endsWith('/management/auth-files/excluded-models'), () => ({ excluded_models: { codex: ['gpt-5-mini', 'gpt-4*'] } })],
    [(url) => url.pathname.endsWith('/management/auth-files/provider-models'), (url) => ({
      provider: url.searchParams.get('provider'), available: true,
      models: url.searchParams.get('provider') === 'codex'
        ? [{ id: 'gpt-5', display_name: 'GPT-5' }, { id: 'gpt-5-mini' }, { id: 'gpt-4.1' }]
        : [{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4' }],
    })],
    [(url) => url.pathname.endsWith('/management/plugins'), () => ({ plugins: [], total: 0 })],
    [(url, method) => method === 'POST' && url.pathname.endsWith('/management/oauth/start'), () => ({
      url: 'https://auth.example.test/authorize',
      state: 'probe-state',
      session_id: 'probe-state',
      provider: 'codex',
      flow: 'redirect',
    })],
    [(url) => url.pathname.endsWith('/management/oauth/status'), () => ({ status: 'wait', message: 'waiting' })],
  ],
};

/**
 * The probe scenario's routes: the shared fixtures plus one attempt whose first
 * status read fails before CPA answers.
 *
 * The counter lives in this closure rather than in the shared fixture table because
 * the overlay scenario spreads that table too, and a blip consumed by a different
 * scenario would make this probe assert nothing.
 */
export function oauthManagementProbeRoutes() {
  let statusReads = 0;
  return [
    [
      (url, method) => method === 'POST' && url.pathname.endsWith('/management/oauth/start'),
      (url, method, request) => {
        const provider = JSON.parse(request.postData() ?? '{}').provider;
        if (provider !== 'meta') {
          return { url: 'https://auth.example.test/authorize', state: 'probe-state', session_id: 'probe-state', provider, flow: 'redirect' };
        }
        return {
          url: 'https://auth.example.test/device',
          state: 'probe-blip',
          session_id: 'probe-blip',
          provider,
          flow: 'device',
          user_code: 'PROBE-CODE-1',
        };
      },
    ],
    [
      (url, method) => method === 'GET' && url.pathname.endsWith('/management/oauth/status')
        && url.searchParams.get('state') === 'probe-blip',
      () => {
        statusReads += 1;
        // The probe's own check and the poll armed three seconds after the start response
        // can arrive in either order, and both are failures of this fixture: only the read
        // after them answers success, so the completion is always the surviving poll's.
        return statusReads <= 2 ? { status: 502, json: { error: 'gateway unavailable' } } : { status: 'ok' };
      },
    ],
    ...oauthManagementFixtures.routes,
  ];
}


async function verifyAuthorizationOutcomes({ base, page, check }) {
  for (const outcome of ['new', 'ambiguous', 'refresh-failed']) {
    let hasCompleted = false;
    const newFile = { ...files[0], name: 'completion-new.json', auth_index: 'completion-new' };
    const filesHandler = async (route) => {
      if (hasCompleted && outcome === 'refresh-failed') {
        await fulfillFixture(route, { status: 502, json: { error: 'completion list unavailable' } });
        return;
      }
      const currentFiles = hasCompleted && outcome === 'new' ? [...files, newFile] : files;
      await route.fulfill({ json: { files: currentFiles, total: currentFiles.length } });
    };
    const startHandler = async (route) => route.fulfill({ json: {
      provider: 'codex', flow: 'device', url: 'https://auth.example.test/device',
      user_code: 'COMPLETION-CODE', state: `completion-${outcome}`, session_id: `completion-${outcome}`,
    } });
    const statusHandler = async (route) => {
      hasCompleted = true;
      await route.fulfill({ json: { status: 'ok' } });
    };
    await page.route('**/management/auth-files', filesHandler);
    await page.route('**/management/oauth/start', startHandler);
    await page.route('**/management/oauth/status?*', statusHandler);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/oauth-management`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('oauth-credential-record').first().waitFor();
      await page.getByRole('button', { name: /OAuth sign-in|OAuth 登录/i }).click();
      const panel = page.getByTestId('oauth-connect-panel');
      await panel.locator('#oauth-connect-provider').click();
      await page.getByTitle('Codex OAuth', { exact: true }).last().click();
      await panel.locator('[data-oauth-start="codex"]').click();
      await panel.getByRole('button', { name: /Check Authorization Status|检查授权状态/i }).waitFor();
      await panel.getByRole('button', { name: /Check Authorization Status|检查授权状态/i }).click();
      const expectedTitle = outcome === 'new' ? /one new credential was confirmed|确认一个新的凭证/
        : outcome === 'ambiguous' ? /could not be identified uniquely|无法唯一确认/
          : /refreshing the credential list failed|刷新凭证列表失败/;
      const completionToast = page.locator('.omc-toast').filter({ hasText: expectedTitle });
      await completionToast.waitFor();
      check(`${outcome} authorization has exactly one outcome toast`, await page.locator('.omc-toast').count() === 1);
      await completionToast.getByRole('button', { name: /View credentials|查看凭证/i }).click();
      await completionToast.waitFor({ state: 'detached' });
      await panel.waitFor({ state: 'hidden' });
      check(`${outcome} completion action reveals the provider collection`,
        new URL(page.url()).searchParams.get('provider') === 'codex');
      if (outcome === 'new') {
        check('the confirmed credential remains visible after the completion action',
          await page.locator('[data-auth-index="completion-new"]').isVisible());
      }
    } finally {
      await page.unroute('**/management/auth-files', filesHandler);
      await page.unroute('**/management/oauth/start', startHandler);
      await page.unroute('**/management/oauth/status?*', statusHandler);
    }
  }
}


async function verifyWorkspaceScale({ base, page, check }) {
  const scaleFiles = Array.from({ length: 48 }, (_, index) => ({
    ...files[index % files.length],
    name: `scale-${String(index).padStart(2, '0')}.json`,
    auth_index: `scale-${index}`,
  }));
  const scaleQuota = scaleFiles.map((file, index) => ({
    ...quotaFor(index % files.length),
    name: file.name,
    auth_index: file.auth_index,
    capabilities: { refresh_supported: index < 23 },
  }));
  const reads = { files: 0, quota: 0, models: 0 };
  const batches = [];
  let activeBatches = 0;
  let peakBatches = 0;
  const filesHandler = async (route) => {
    reads.files += 1;
    await route.fulfill({ json: { files: scaleFiles, total: 48 } });
  };
  const quotaHandler = async (route) => {
    reads.quota += 1;
    await route.fulfill({ json: { quotas: scaleQuota, total: 48 } });
  };
  const pendingBatches = [];
  const batchHandler = async (route) => {
    const indexes = route.request().postDataJSON().auth_indexes;
    batches.push(indexes);
    activeBatches += 1;
    peakBatches = Math.max(peakBatches, activeBatches);
    if (batches.length === 1) await new Promise(resolve => pendingBatches.push(resolve));
    activeBatches -= 1;
    await route.fulfill({ json: { status: 'ok', quotas: indexes
      .filter((index) => index !== 'scale-13')
      .map((index) => ({ ...scaleQuota.find((item) => item.auth_index === index),
        ...(index === 'scale-7' ? { status: 'error', error: `Fixture upstream failure (refresh ${Math.ceil(batches.length / 3)})` } : {}),
      })) } });
  };
  const countModels = (request) => {
    if (request.url().includes('/auth-files/models')) reads.models += 1;
  };
  page.on('request', countModels);
  await page.route('**/management/auth-files', filesHandler);
  await page.route('**/management/quota', quotaHandler);
  await page.route('**/management/quota/refresh', batchHandler);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/oauth-management?page_size=48&density=compact`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="oauth-credential-record"][data-auth-index="scale-47"]').waitFor();
    await settleLayout(page);
    check('48 credentials share collection queries without per-row model reads',
      reads.files <= 2 && reads.quota <= 2 && reads.models === 0, JSON.stringify(reads));
    await page.getByRole('button', { name: /Refresh quota \(23\)/ }).click();
    await until(() => pendingBatches.length > 0, {label:'held quota batch'});
    check('quota refresh starts only one batch while the first response is held', activeBatches === 1);
    pendingBatches.splice(0).forEach(release => release());
    // This fixture run has failures, so the outcome is the report toast that lists each
    // target's reason, and it is the only toast the run raises.
    await page.getByTestId('quota-operation-report').waitFor();
    const report = await page.getByTestId('quota-operation-report').innerText();
    check('a failing refresh raises one report toast and nothing beside it',
      (await page.locator('.omc-toast').count()) === 1,
      `toasts=${await page.locator('.omc-toast').count()}`);
    check('23 eligible quota targets use sequential 10/10/3 batches exactly once',
      batches.map((batch) => batch.length).join('/') === '10/10/3'
        && new Set(batches.flat()).size === 23 && peakBatches === 1,
      JSON.stringify({ sizes: batches.map((batch) => batch.length), peakBatches }));
    check('batch errors and missing results remain visible to the operator',
      report.includes('Fixture upstream failure') && report.includes('scale-13'), report);
    // Exercise the real copy action without depending on the machine's clipboard permission.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => {} },
    }));
    await page.getByRole('button', { name: /OAuth sign-in|OAuth 登录/i }).click();
    const copyPanel = page.getByTestId('oauth-connect-panel');
    await copyPanel.locator('#oauth-connect-provider').click();
    await page.getByTitle('Codex OAuth', { exact: true }).last().click();
    await copyPanel.locator('[data-oauth-start="codex"]').click();
    const copyLink = copyPanel.getByRole('button', { name: /Copy Link|复制链接/i });
    await copyLink.waitFor();
    // Retention, not pointer geometry: dispatch the burst in one task so none of the four
    // ordinary notices can expire before the oldest-report eviction would happen.
    await copyLink.evaluate((button) => {
      for (let i = 0; i < 4; i += 1) button.click();
    });
    await until(async () => await page.locator('.omc-toast-success').count() === 4,
      { label: 'four independent copy acknowledgements are present together' });
    check('four ordinary notifications cannot evict the persistent quota report',
      await page.getByTestId('quota-operation-report').isVisible()
        && await page.getByTestId('quota-operation-report').evaluate((notice) => !notice.className.includes('-leave')));
    const closeCopyPanel = page.locator('.ant-drawer-open .ant-drawer-close');
    await closeCopyPanel.focus();
    await closeCopyPanel.press('Enter');
    await copyPanel.waitFor({ state: 'hidden' });
    // Dismiss the ordinary notices so the next refresh's count proves replacement, not expiry.
    await page.locator('.omc-toast-success .ant-notification-notice-close').evaluateAll((buttons) => {
      for (const button of buttons) button.click();
    });
    await until(async () => await page.locator('.omc-toast-success').count() === 0,
      { label: 'copy acknowledgements are dismissed' });
    const previousBatches = batches.length;
    await page.getByRole('button', { name: /Refresh quota \(23\)/ }).click();
    await until(() => batches.length === previousBatches + 3, { label: 'the second refresh completes every batch' });
    await until(async () => (await page.getByTestId('quota-operation-report').innerText()).includes('Fixture upstream failure (refresh 2)'),
      { label: 'the replacement report has the settled refresh outcome' });
    check('another refresh replaces the report instead of stacking it',
      await page.getByTestId('quota-operation-report').count() === 1 && await page.locator('.omc-toast').count() === 1);
    await page.getByTestId('quota-operation-report').locator('.ant-notification-notice-close').click();
    await page.getByTestId('quota-operation-report').waitFor({ state: 'detached' });
    // A hard navigation ends the copy fixture's synthetic authorization before the scale sessions.
    await page.goto(`${base}/oauth-management?page_size=48&density=compact`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('oauth-credential-record').first().waitFor();
    const starts = [];
    const pollReads = {};
    const pendingPolls = {};
    let hasConcurrentPoll = false;
    const startHandler = async (route) => {
      const provider = route.request().postDataJSON().provider;
      starts.push(provider);
      await route.fulfill({ json: { provider, flow: 'redirect',
        url: 'https://auth.example.test/authorize', state: `scale-${provider}`, session_id: `scale-${provider}` } });
    };
    const heldPolls = [];
    const statusHandler = async (route) => {
      const state = new URL(route.request().url()).searchParams.get('state');
      pollReads[state] = (pollReads[state] ?? 0) + 1;
      pendingPolls[state] = (pendingPolls[state] ?? 0) + 1;
      if (pendingPolls[state] > 1) hasConcurrentPoll = true;
      await new Promise(resolve => heldPolls.push(resolve));
      pendingPolls[state] -= 1;
      await route.fulfill({ json: { status: 'wait' } });
    };
    await page.route('**/management/oauth/start', startHandler);
    await page.route('**/management/oauth/status?*', statusHandler);
    for (const [provider, label] of [['codex', 'Codex OAuth'], ['anthropic', 'Anthropic OAuth']]) {
      await page.getByRole('button', { name: /OAuth sign-in/ }).click();
      await page.locator('#oauth-connect-provider').click();
      await page.getByTitle(label, { exact: true }).last().click();
      await page.locator(`[data-oauth-start="${provider}"]`).click();
      await page.locator(`[data-oauth-card="${provider}"]`).getByRole('button', { name: /Cancel Authorization/ }).waitFor();
      await page.locator('.ant-drawer-open .ant-drawer-close').click();
      await page.locator('.ant-drawer-open').waitFor({ state: 'hidden' });
    }
    await page.getByTestId('oauth-session-pill').first().getByRole('button').click();
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden' });
    await until(() => heldPolls.length >= 2, {label:'both minimized authorization polls held'});
    check('48 records retain two independent minimized sessions without duplicate checkers',
      starts.join('/') === 'codex/anthropic' && !hasConcurrentPoll
        && pollReads['scale-codex'] >= 1 && pollReads['scale-anthropic'] >= 1
        && (await page.getByTestId('oauth-session-pill').count()) === 2,
      JSON.stringify({ starts, pollReads, hasConcurrentPoll }));
    console.log(`OAuth scale: ${JSON.stringify({ reads, sizes: batches.map((batch) => batch.length), peakBatches, starts, pollReads })}`);
    heldPolls.splice(0).forEach(release => release());
    // Hard navigation ends these synthetic attempts before removing their fixtures.
    await page.goto(`${base}/oauth-management?density=compact`);
    await page.unroute('**/management/oauth/start', startHandler);
    await page.unroute('**/management/oauth/status?*', statusHandler);
  } finally {
    pendingBatches.splice(0).forEach(release => release());
    page.off('request', countModels);
    await page.unroute('**/management/auth-files', filesHandler);
    await page.unroute('**/management/quota', quotaHandler);
    await page.unroute('**/management/quota/refresh', batchHandler);
  }
}

async function verifyVertexImportDialog({ page, check }) {
  const openImport = page.getByRole('button', { name: 'Import Vertex key', exact: true });
  await openImport.click();
  const dialog = page.getByRole('dialog', { name: 'Import a Vertex service account key' });
  await dialog.waitFor();
  check('Vertex import starts with no key and cannot submit', await dialog.getByRole('button', { name: 'Import', exact: true }).isDisabled());
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'service-account-fixture.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ project_id: 'fixture-project', private_key: 'SYNTHETIC-KEY-FIXTURE', client_email: 'fixture@fixture-project.iam.gserviceaccount.com' })),
  });
  await dialog.getByText('fixture-project', { exact: true }).waitFor();
  check('Vertex import presents identity without rendering key contents', (await dialog.innerText()).includes('fixture@fixture-project.iam.gserviceaccount.com') && !(await dialog.innerText()).includes('SYNTHETIC-KEY-FIXTURE'));
  await settleLayout(page);
  await page.screenshot({ path: 'tmp/vertex-import-desktop.png' });
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await settleLayout(page);
  check('the Vertex import dialog fits a phone viewport', await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= window.innerWidth));
  await page.screenshot({ path: 'tmp/vertex-import-phone.png' });
  await dialog.getByRole('textbox', { name: 'Location', exact: true }).fill('us-central1.evil.test');
  check('an invalid Vertex region prevents submitting', await dialog.getByRole('button', { name: 'Import', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize(desktopViewport);
  await openImport.click();
  await dialog.waitFor();
  check('reopening Vertex import discards the selected key', await dialog.getByText('fixture-project', { exact: true }).count() === 0 && await dialog.getByRole('button', { name: 'Import', exact: true }).isDisabled());
  await page.evaluate(() => {
    const readFile = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== 'delayed-service-account-fixture.json') return readFile.call(this);
      return new Promise((resolve) => {
        window.__releaseVertexFile = () => resolve(JSON.stringify({ project_id: 'delayed-project', private_key: 'SYNTHETIC-DELAYED-KEY' }));
      });
    };
  });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'delayed-service-account-fixture.json', mimeType: 'application/json', buffer: Buffer.from('{}'),
  });
  await until(async () => await page.evaluate(() => typeof window.__releaseVertexFile === 'function'), { label: 'the held Vertex file read' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await openImport.click();
  await dialog.waitFor();
  await page.evaluate(() => window.__releaseVertexFile());
  await settleLayout(page);
  check('a file read from a cancelled Vertex dialog cannot repopulate its next opening', await dialog.getByText('delayed-project', { exact: true }).count() === 0 && await dialog.getByRole('button', { name: 'Import', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

export async function oauthVertexImport({base, page, check, step}) {
  await page.goto(`${base}/oauth-management`);
  await page.getByTestId('oauth-credential-record').first().waitFor();
  await step('Vertex file lifecycle', () => verifyVertexImportDialog({page,check}));
}
export async function oauthModelRules(fixtures) {
  await fixtures.step('model alias and exclusion writes', () => checkOAuthModelRules(fixtures));
}
export async function oauthTokenCapacity(fixtures) {
  await fixtures.page.goto(`${fixtures.base}/oauth-management`);
  await fixtures.page.getByTestId('oauth-credential-record').first().waitFor();
  await fixtures.step('capacity formats and phone bounds', () => verifyFullTokenCapacity(fixtures));
}
export async function oauthAuthorizationOutcomes(fixtures) {
  await fixtures.step('authorization completion and read failures', () => verifyAuthorizationOutcomes(fixtures));
}
export async function oauthWorkspaceScale(fixtures) {
  await fixtures.step('batch quotas and cancellation', () => verifyWorkspaceScale(fixtures));
}
export async function oauthPluginConnections(fixtures) {
  const oauthStarts = [];
  fixtures.page.on('request', request => { if (request.url().includes('/management/oauth/start')) oauthStarts.push(request.url()); });
  await fixtures.step('key and interactive plugin connections', () => verifyPluginConnections({...fixtures,oauthStarts}));
}
