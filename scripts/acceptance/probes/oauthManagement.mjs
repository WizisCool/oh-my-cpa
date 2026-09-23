const files = Array.from({ length: 12 }, (_, index) => {
  const provider = ['codex', 'claude', 'kimi', 'xai'][index % 4];
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
    priority: 1,
    weight: 1,
    note: index % 2 === 0 ? 'Production credential' : undefined,
  };
});

function quotaFor(index) {
  const sixWindows = index === 3;
  const windows = Array.from({ length: sixWindows ? 6 : 2 }, (_, windowIndex) => ({
    id: `auth-${String(index + 1).padStart(2, '0')}-window-${windowIndex}`,
    label: sixWindows ? `Model group ${Math.floor(windowIndex / 2) + 1} · Window ${windowIndex % 2 + 1}` : `Window ${windowIndex + 1}`,
    kind: sixWindows ? (windowIndex % 2 === 0 ? 'five_hour' : 'weekly') : (windowIndex === 0 ? 'five_hour' : 'weekly'),
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
    reset_credits: credits ? { available_count: 1, applicable_available_count: 1 } : undefined,
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
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/management/oauth/start')) oauthStarts.push(request.url());
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

  const compactVisible = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="oauth-credential-record"]')];
    return rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0;
    }).length;
  });
  await page.screenshot({ path: 'tmp/oauth-management-compact-desktop.png' });
  check(
    'oauth management compact density shows at least eight complete records at 1440x900',
    compactVisible >= 8,
    `visible=${compactVisible}`,
  );

  const unsupportedRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-11"]');
  check(
    'an unsupported live probe still renders its observed primary window',
    (await unsupportedRow.locator('[data-quota-unsupported="true"]').count()) > 0
      && (await unsupportedRow.getByText('80%').count()) > 0,
    `unsupported=${await unsupportedRow.locator('[data-quota-unsupported="true"]').count()}`,
  );
  const cooldownRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-10"]');
  check(
    'an active cooldown remains actionable in compact density',
    (await cooldownRow.getByRole('button', { name: /Clear Cooldown|清除冷却/i }).count()) === 1,
  );

  await page.goto(`${base}/oauth-management?density=expanded`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-quota-density="expanded"]').first().waitFor({ state: 'visible', timeout: 20_000 });
  const expanded = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="oauth-credential-record"]')];
    const complete = rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight && row.querySelector('[data-quota-window-count="2"]');
    }).length;
    const body = rows[0]?.querySelector('[data-quota-body]');
    return {
      complete,
      declared: Number(body?.getAttribute('data-quota-window-count') ?? 0),
      rendered: body?.querySelectorAll('.ant-progress').length ?? 0,
    };
  });
  await page.screenshot({ path: 'tmp/oauth-management-expanded-desktop.png' });
  check(
    'oauth management expanded density shows at least three complete ordinary quota records',
    expanded.complete >= 3,
    JSON.stringify(expanded),
  );
  check(
    'expanded quota rendering does not truncate its declared windows',
    expanded.declared > 0 && expanded.declared === expanded.rendered,
    JSON.stringify(expanded),
  );

  const creditRow = page.locator('[data-testid="oauth-credential-record"][data-auth-index="auth-12"]');
  check(
    'an embedded expanded record keeps the reset-credit action',
    (await creditRow.getByRole('button', { name: /Reset quota|重置额度/i }).count()) === 1,
  );

  const sixWindow = page.locator('[data-quota-window-count="6"]').first();
  await sixWindow.scrollIntoViewIfNeeded();
  const sixWindowAudit = await sixWindow.evaluate((body) => ({
    declared: Number(body.getAttribute('data-quota-window-count') ?? 0),
    rendered: body.querySelectorAll('.ant-progress').length,
  }));
  check('six model/group quota windows remain complete', sixWindowAudit.declared === 6 && sixWindowAudit.rendered === 6, JSON.stringify(sixWindowAudit));

  await page.goto(`${base}/oauth-management`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="oauth-credential-record"]').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('button', { name: /Connect account/i }).click();
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
