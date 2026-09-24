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
  }));
  const cooldown = index === 9;
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
    plan: { plan_type: 'pro', plan_label: 'Pro', tier: 'premium' },
    windows,
    active_cooldown: cooldown ? { is_active: true, reason: 'Rate limit protection active', recover_at_ms: Date.now() + 900_000 } : undefined,
    // The bank holds two credits while upstream considers none of them applicable right
    // now. That combination is exactly the reported defect: the action must still exist.
    reset_credits: credits ? { available_count: 2, applicable_available_count: 0 } : undefined,
    recommendation: { status: cooldown ? 'cooldown' : 'healthy', priority: cooldown ? 'high' : 'none', action: cooldown ? 'clear_cooldown' : 'none', reason: '' },
    capabilities: {
      refresh_supported: !unsupported,
      clear_cooldown_supported: cooldown,
      reset_credit_supported: credits,
    },
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
  await groupRecord.getByRole('button', { name: /^(Details|详情):/i }).click();
  const detailPanel = page.locator('.ant-drawer-open');
  await detailPanel.locator('[data-quota-density="expanded"]').waitFor();
  check('quota tab shows every model group without unrelated configuration',
    (await detailPanel.locator('.ant-progress').count()) === 6
      && (await detailPanel.innerText()).includes('Model group 3 · Window 2')
      && !(await detailPanel.locator('#note').isVisible()));
  const labels = await detailPanel.locator('[class*=progress-label-row]').allInnerTexts();
  check('quota windows stay grouped in source order', labels[0]?.includes('Model group 1') && labels[1]?.includes('Model group 1') && labels[2]?.includes('Model group 2'), labels.join(' | '));
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'tmp/oauth-management-quota-drawer.png' });
  await detailPanel.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await detailPanel.locator('#note').fill('Keep this draft while checking quota');
  await detailPanel.getByRole('tab', { name: 'Quota', exact: true }).click();
  check('configuration fields stay outside the quota tab', !(await detailPanel.locator('#note').isVisible()));
  await detailPanel.getByRole('tab', { name: /Configuration/ }).click();
  check('switching tabs preserves an unsaved configuration draft',
    (await detailPanel.locator('#note').inputValue()) === 'Keep this draft while checking quota');
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
  await cooldownRow.getByRole('button', { name: /More actions|更多操作/i }).click();
  const cooldownItem = page.getByRole('menuitem', { name: /Clear Cooldown|清除冷却/i });
  check('an active cooldown stays actionable through the row menu', await cooldownItem.isEnabled());
  await page.keyboard.press('Escape');

  const creditRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-12"]');
  const inlineRedeem = creditRow.getByRole('button', { name: /Reset quota|重置额度/i });
  check(
    'a credential with a reset credit and no applicable one still offers the reset action',
    await inlineRedeem.isEnabled(),
    `reset quota button enabled=${await inlineRedeem.isEnabled()}`,
  );
  await inlineRedeem.click();
  const redeemConfirm = page.locator('.ant-popconfirm');
  await redeemConfirm.waitFor();
  check('the reset action asks for confirmation before spending a credit', await redeemConfirm.isVisible());
  await redeemConfirm.getByRole('button', { name: /Cancel|取消/i }).click();
  await redeemConfirm.waitFor({ state: 'hidden' });

  await creditRow.getByRole('button', { name: /^Details:/ }).click();
  await page.locator('.ant-drawer-open [data-quota-density="expanded"]').waitFor();
  check('quota details retain the confirmed reset-credit action',
    (await page.locator('.ant-drawer-open').getByRole('button', { name: /Reset quota|重置额度/i }).count()) === 1);
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await page.locator('.ant-drawer-open').waitFor({ state: 'hidden' });
  check('no redemption request leaves the browser without a confirmation', redeemPosts.length === 0, `posts=${redeemPosts.length}`);

  await inlineRedeem.click();
  const confirmed = page.locator('.ant-popconfirm');
  await confirmed.waitFor();
  await confirmed.getByRole('button', { name: /Confirm|确定/i }).click();
  await page.getByText(/Credit redeemed successfully|积分重置成功/).waitFor({ timeout: 10_000 });
  check('confirming issues exactly one redemption request', redeemPosts.length === 1, `posts=${redeemPosts.length}`);

  await page.goto(`${base}/oauth-management`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="oauth-credential-record"]').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('button', { name: /OAuth sign-in/i }).click();
  await page.locator('[data-testid="oauth-connect-panel"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  const picker = page.locator('#oauth-connect-provider');
  await picker.click();
  await page.getByTitle('Codex OAuth', { exact: true }).last().click();
  check('selecting a Connect provider makes no authorization request', oauthStarts.length === 0, `starts=${oauthStarts.length}`);
  await page.locator('[data-oauth-start="codex"]').click();
  for (let attempt = 0; attempt < 50 && oauthStarts.length === 0; attempt += 1) {
    await page.waitForTimeout(100);
  }
  check('Start authorization issues exactly one request', oauthStarts.length === 1, `starts=${oauthStarts.length}`);
  await page.keyboard.press('Escape');
  await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
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
    await page.screenshot({ path: `tmp/oauth-management-overview-${width}.png` });
    await page.getByTestId('oauth-credential-record').first().getByRole('button', { name: /^Details:/ }).click();
    const phoneDrawer = page.locator('.ant-drawer-open');
    await phoneDrawer.getByRole('tab', { name: 'Quota', exact: true }).waitFor();
    await page.waitForTimeout(350);
    const drawerOverflow = await phoneDrawer.evaluate((drawer) => drawer.querySelector('.ant-drawer-body').scrollWidth - drawer.querySelector('.ant-drawer-body').clientWidth);
    check(`tabbed quota drawer has no horizontal overflow at ${width}px`, drawerOverflow <= 1, `overflow=${drawerOverflow}`);
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
  await verifyWorkspaceScale({ base, page, check });
}

export const oauthManagementFixtures = {
  files,
  quota,
  routes: [
    [(url) => url.pathname.endsWith('/management/auth-files'), () => ({ files, total: files.length })],
    [(url) => url.pathname.endsWith('/management/quota'), () => ({
      summary: { total_credentials: quota.length, healthy_count: quota.length, warning_count: 0, exhausted_count: 0, cooldown_count: 0, attention_count: 0 },
      quotas: quota,
      total: quota.length,
    })],
    // Confirming a redemption is mocked here: the real call spends an entitlement, so the
    // probe only proves the request is issued once, from the enabled action.
    [(url, method) => method === 'POST' && url.pathname.endsWith('/management/quota/redeem-credit'), () => ({ status: 'ok', quota: quota[11] })],
    [(url) => url.pathname.endsWith('/management/auth-files/model-aliases'), () => ({ 'oauth-model-alias': {}, supported: true })],
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
  const batchHandler = async (route) => {
    const indexes = route.request().postDataJSON().auth_indexes;
    batches.push(indexes);
    activeBatches += 1;
    peakBatches = Math.max(peakBatches, activeBatches);
    await page.waitForTimeout(80);
    activeBatches -= 1;
    await route.fulfill({ json: { status: 'ok', quotas: indexes
      .filter((index) => index !== 'scale-13')
      .map((index) => ({ ...scaleQuota.find((item) => item.auth_index === index),
        ...(index === 'scale-7' ? { status: 'error', error: 'Fixture upstream failure' } : {}),
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
    await page.waitForTimeout(200);
    check('48 credentials share collection queries without per-row model reads',
      reads.files <= 2 && reads.quota <= 2 && reads.models === 0, JSON.stringify(reads));
    await page.getByRole('button', { name: /Refresh quota \(23\)/ }).click();
    await page.getByTestId('quota-operation-report').waitFor();
    const report = await page.getByTestId('quota-operation-report').innerText();
    check('23 eligible quota targets use sequential 10/10/3 batches exactly once',
      batches.map((batch) => batch.length).join('/') === '10/10/3'
        && new Set(batches.flat()).size === 23 && peakBatches === 1,
      JSON.stringify({ sizes: batches.map((batch) => batch.length), peakBatches }));
    check('batch errors and missing results remain visible to the operator',
      report.includes('Fixture upstream failure') && report.includes('scale-13'), report);
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
    const statusHandler = async (route) => {
      const state = new URL(route.request().url()).searchParams.get('state');
      pollReads[state] = (pollReads[state] ?? 0) + 1;
      pendingPolls[state] = (pendingPolls[state] ?? 0) + 1;
      if (pendingPolls[state] > 1) hasConcurrentPoll = true;
      await page.waitForTimeout(120);
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
    await page.waitForTimeout(3400);
    check('48 records retain two independent minimized sessions without duplicate checkers',
      starts.join('/') === 'codex/anthropic' && !hasConcurrentPoll
        && pollReads['scale-codex'] >= 1 && pollReads['scale-anthropic'] >= 1
        && (await page.getByTestId('oauth-session-pill').count()) === 2,
      JSON.stringify({ starts, pollReads, hasConcurrentPoll }));
    console.log(`OAuth scale: ${JSON.stringify({ reads, sizes: batches.map((batch) => batch.length), peakBatches, starts, pollReads })}`);
    // Hard navigation ends these synthetic attempts before removing their fixtures.
    await page.goto(`${base}/oauth-management?density=compact`);
    await page.unroute('**/management/oauth/start', startHandler);
    await page.unroute('**/management/oauth/status?*', statusHandler);
  } finally {
    page.off('request', countModels);
    await page.unroute('**/management/auth-files', filesHandler);
    await page.unroute('**/management/quota', quotaHandler);
    await page.unroute('**/management/quota/refresh', batchHandler);
  }
}
