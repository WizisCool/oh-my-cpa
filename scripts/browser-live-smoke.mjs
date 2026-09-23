// Browser acceptance for the Oh My CPA management centre.
//
// It drives a real Chromium against a running Oh My CPA instance. By default
// it targets the embedded production build at http://127.0.0.1:8080/omc/;
// override OMCPA_URL with http://127.0.0.1:5173/omc/ to exercise the Vite dev
// entry. The API facade and CPA instance configured in .env remain real.
// Nothing is mocked: every assertion compares the DOM with the data the real
// CPA Management API returns through /api/v1/management/*.
//
// Usage:
//   node scripts/browser-acceptance.mjs
// Env overrides:
//   OMCPA_URL, OMCPA_CPA_MANAGEMENT_KEY,
//   OMCPA_BROWSER (absolute path to a Chromium/Edge/Chrome executable)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appURL = (process.env.OMCPA_URL || 'http://127.0.0.1:8080/omc/').replace(/\/$/, '');
// Oh My CPA has no separate admin password: login uses the CPA management key.
const password = process.env.OMCPA_CPA_MANAGEMENT_KEY || readEnvFile('OMCPA_CPA_MANAGEMENT_KEY') || '';
const managementKey = process.env.OMCPA_CPA_MANAGEMENT_KEY || readEnvFile('OMCPA_CPA_MANAGEMENT_KEY') || '';

function readEnvFile(name) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1).trim();
    if (trimmed.startsWith(`export ${name}=`)) return trimmed.slice(`export ${name}=`.length).trim();
  }
  return '';
}

function browserExecutable() {
  const candidates = [
    process.env.OMCPA_BROWSER,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      for (const entry of fs.readdirSync(candidate)) {
        for (const name of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
          const full = path.join(candidate, entry, name);
          if (fs.existsSync(full)) return full;
        }
      }
    }
  }
  const programFiles = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return programFiles.find((file) => fs.existsSync(file)) || '';
}

const results = [];
function check(name, detail, ok) {
  results.push({ name, detail, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const executable = browserExecutable();
  if (!executable) throw new Error('no Chromium/Edge/Chrome executable found; set OMCPA_BROWSER');
  if (!password) throw new Error('OMCPA_CPA_MANAGEMENT_KEY is required (set it or fill .env)');

  const redirect = await fetch(`${appURL}`, { redirect: 'manual' });
  check('/omc 规范跳转到 /omc/', `status=${redirect.status} location=${redirect.headers.get('location')}`,
    redirect.status >= 300 && redirect.status < 400 && (redirect.headers.get('location') || '').endsWith('/omc/'));

  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.startsWith(appURL) && !url.includes('/api/auth/session')) failedRequests.push(`${request.method()} ${url}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith(appURL)) return;
    if (url.includes('/api/auth/session') && response.status() === 401) return;
    if (response.status() >= 400) badResponses.push(`${response.status()} ${url}`);
  });

  await page.goto(`${appURL}/dashboard`, { waitUntil: 'networkidle' });
  const loginHeading = await page.locator('text=CPA 管理登录').first().isVisible().catch(() => false);
  const passwordBox = page.locator('input[type="password"]');
  const hasPasswordBox = await passwordBox.isVisible().catch(() => false);
  check('未登录时显示 CPA 管理登录界面', `heading=${loginHeading} password=${hasPasswordBox}`, loginHeading && hasPasswordBox);

  await passwordBox.fill(password);
  await page.getByRole('button', { name: '进入管理中心' }).click();
  await page.waitForURL('**/dashboard', { timeout: 15000 });
  check('登录后进入 /dashboard', page.url(), page.url().endsWith('/dashboard'));

  const overviewResponse = await page.request.get(`${appURL}/api/v1/management/overview`); // via page.request (has session + Origin)
  const overview = await overviewResponse.json();
  check('Overview 来自真实 CPA', `status=${overview.status} cpa_version=${overview.cpa_version}`,
    overviewResponse.ok() && Boolean(overview.cpa_version) && overview.status !== 'unconfigured');

  await page.waitForSelector('.terminal-title', { timeout: 15000 });
  // The runtime block is a second, independent query that mounts only once the
  // dashboard window has data. Waiting for it keeps this check about content
  // rather than about which of two requests wins the race.
  await page.waitForSelector('.runtime-list', { timeout: 15000 });
  const dashboardText = await page.locator('main').innerText();
  check('Dashboard 展示真实 CPA 版本', overview.cpa_version, dashboardText.includes(overview.cpa_version));
  const instanceName = overview.cpa_instance_name || '';
  if (instanceName) {
    check('Dashboard 展示真实实例名', instanceName, dashboardText.includes(instanceName));
  }
  const hasRequests = dashboardText.includes('请求总数') || dashboardText.includes('请求');
  const silent = dashboardText.includes('静候') || dashboardText.includes('暂无') || dashboardText.includes('尚未捕获');
  check('Dashboard 展示流量吞吐或真实静默态', `hasRequests=${hasRequests} silent=${silent}`, hasRequests || silent);

  const beforeTheme = new URL(page.url()).pathname;
  await page.getByRole('button', { name: '界面主题' }).click();
  await page.waitForTimeout(400);
  const afterTheme = new URL(page.url()).pathname;
  check('主题切换不改变路由', `${beforeTheme} -> ${afterTheme}`, beforeTheme === afterTheme);
  const themePersisted = await page.evaluate(() => window.localStorage.getItem('omc-theme') || '');
  check('主题选择已持久化', themePersisted, themePersisted !== '');

  // The mode control cycles three states (light -> dark -> follow-the-system), so returning to where this
  // started takes two more clicks. One would leave the console following the operating system, and every
  // later check that reads a colour would then depend on the machine rather than on the fixture.
  await page.getByRole('button', { name: '界面主题' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '界面主题' }).click();
  await page.waitForTimeout(300);

  // No view may paint an empty frame between states: route changes and window
  // presets must keep previous content on screen (docs/design.md).
  await page.goto(`${appURL}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-grid .dashboard-tile', { timeout: 20000 });
  await page.waitForSelector('.range-trigger', { timeout: 20000 });
  let tailPolls = 0;
  page.on('request', (req) => {
    if (req.url().includes('/management/dashboard/tail')) tailPolls += 1;
  });
  await page.evaluate(() => {
    window.__blankFrames = 0;
    const check = () => {
      const content = document.querySelector('.app-content');
      const inner = content && content.querySelector('.route-transition');
      if (!inner || inner.childElementCount === 0) window.__blankFrames += 1;
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    window.__checkBlanks = check;
  });
  for (const preset of ['近 1 小时', '近 7 天', '近 24 小时']) {
    await page.locator('.range-trigger').click();
    await page.waitForTimeout(250);
    // The panel opens on whichever tab owns the current window, so a stored
    // The custom range lands on the Custom tab. Reach the quick list the way a
    // user would.
    const quickTab = page.locator('.ant-tabs-tab', { hasText: '最近' });
    if (await quickTab.count()) await quickTab.click();
    await page.waitForTimeout(200);
    const option = page.locator('.range-option', { hasText: preset });
    if (await option.count()) {
      await option.first().click();
      await page.waitForTimeout(450);
    }
  }
  const tilesAfterPresets = await page.locator('.dashboard-tile').count();
  await page.waitForTimeout(6000);
  check('相对区间自动轮询 tail 端点', `tailPolls=${tailPolls}`, tailPolls >= 2);
  for (const item of ['OAuth 管理', '仪表盘']) {
    await page.locator('.app-sider .app-menu').getByText(item, { exact: true }).first().click({ timeout: 5000 })
      .catch(async () => { await page.goto(`${appURL}/${item === 'OAuth 管理' ? 'oauth-management' : 'dashboard'}`); });
    await page.waitForTimeout(700);
  }
  const blankFrames = await page.evaluate(() => window.__blankFrames);
  check('切换区间与路由时不出现空帧', `blankFrames=${blankFrames} tiles=${tilesAfterPresets}`,
    blankFrames === 0 && tilesAfterPresets === 6);

  await page.locator('.app-sider .app-menu').getByText(/OAuth 管理|OAuth Management/, { exact: false }).click({ timeout: 5000 }).catch(async () => {
    await page.goto(`${appURL}/oauth-management`, { waitUntil: 'networkidle' });
  });
  await page.waitForURL('**/oauth-management', { timeout: 15000 });
  await page.waitForSelector('.oauth-management-page', { timeout: 15000 });
  const authFilesResponse = await page.request.get(`${appURL}/api/v1/management/auth-files`);
  const authFiles = await authFilesResponse.json();
  const authText = await page.locator('main').innerText();
  check('OAuth 管理使用真实列表', `total=${authFiles.total}`, authFilesResponse.ok() && (authText.includes(`共 ${authFiles.total} 个`) || authText.includes(`Total ${authFiles.total}`)));
  if (authFiles.total === 0) {
    const emptyShown = authText.includes('没有可展示的认证文件');
    check('空 OAuth 管理显示真实空态', emptyShown ? 'empty state' : authText.slice(0, 80), emptyShown);
  } else {
    const first = authFiles.files.find((file) => file.name)?.name || '';
    check('OAuth 管理渲染真实条目', first, authText.includes(first));
  }

  // Logs: the tail must be real when CPA writes a log file, and must explain
  // itself when it does not. An empty list with no reason reads as broken.
  await page.goto(`${appURL}/logs`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.logs-page', { timeout: 15000 });
  await page.waitForTimeout(2500);
  const logsState = await page.evaluate(() => ({
    rows: document.querySelectorAll('.log-row').length,
    alert: document.querySelector('.logs-alert .ant-alert-message')?.innerText ?? '',
    counts: document.querySelector('.logs-counts')?.innerText ?? '',
    managementHiddenByDefault: document.querySelector('.logs-toolbar .ant-checkbox-input')?.checked ?? false,
  }));
  const logsResponse = await page.request.get(`${appURL}/api/v1/management/logs/status`);
  const logsStatus = await logsResponse.json();
  const logsExplained = logsState.rows > 0 || logsState.alert.includes('文件日志');
  check('日志页给出真实尾部或可执行解释', `rows=${logsState.rows} alert=${logsState.alert.slice(0, 16)} logging_to_file=${logsStatus.logging_to_file}`,
    logsResponse.ok() && logsExplained);
  check('日志页默认隐藏管理流量', `hidden=${logsState.managementHiddenByDefault}`, logsState.managementHiddenByDefault);

  // Log filters are a server-side preference: flipping one and reloading must
  // not quietly reset it.
  await page.locator('.logs-toolbar .ant-checkbox-wrapper').click();
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.logs-toolbar');
  await page.waitForTimeout(1200);
  const filtersAfterReload = await page.evaluate(() => document.querySelector('.logs-toolbar .ant-checkbox-input')?.checked);
  const storedPreferences = await (await page.request.get(`${appURL}/api/v1/preferences`)).json();
  check('日志筛选跨刷新持久化', `afterReload=${filtersAfterReload} stored=${JSON.stringify(storedPreferences.preferences?.log_filters)}`,
    filtersAfterReload === !logsState.managementHiddenByDefault);
  // Leave the shared dev console on the documented default.
  await page.locator('.logs-toolbar .ant-checkbox-wrapper').click();
  await page.waitForTimeout(500);
  await page.locator('.ant-tabs-tab', { hasText: '错误日志' }).click();
  await page.waitForTimeout(1200);
  const errorFiles = await page.request.get(`${appURL}/api/v1/management/request-error-logs`);
  const errorJson = await errorFiles.json();
  const errorText = await page.locator('.log-files').innerText();
  check('错误日志文件标签页读取真实列表', `files=${(errorJson.files || []).length}`,
    errorFiles.ok() && (errorText.includes('.log') || errorText.includes('没有错误日志文件')));
  await page.goto(`${appURL}/dashboard`, { waitUntil: 'networkidle' });

  if (process.env.OMCPA_WRITE_TEST === '1') {
    const fileName = `browser-acceptance-${Date.now()}.json`;
    const uploadPath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(uploadPath, JSON.stringify({ type: 'gemini-api-key', api_key: 'browser-acceptance-placeholder' }));
    await page.setInputFiles('input[type="file"]', uploadPath);
    await page.waitForSelector('.auth-file-card', { timeout: 15000 });
    const uploadListed = await page.request.get(`${appURL}/api/v1/management/auth-files?name=${encodeURIComponent(fileName)}`);
    const uploadJson = await uploadListed.json();
    check('UI 上传后 CPA 真实出现新认证文件', fileName, uploadListed.ok() && uploadJson.total === 1);

    const uploadedCard = page.locator('.auth-file-card', { hasText: fileName }).first();
    await uploadedCard.locator('.ant-switch').click();
    await page.waitForTimeout(1200);
    const disabledText = await uploadedCard.innerText();
    check('UI 开关真实禁用认证文件', disabledText.includes('DISABLED'), disabledText.includes('DISABLED'));

    await uploadedCard.locator('button[aria-label^="删除"]').click();
    await page.locator('.ant-popover .ant-btn-primary, .ant-popconfirm .ant-btn-primary').first().click();
    await page.waitForTimeout(1200);
    const afterDelete = await page.request.get(`${appURL}/api/v1/management/auth-files?name=${encodeURIComponent(fileName)}`);
    const afterDeleteJson = await afterDelete.json();
    check('UI 删除后 CPA 中文件真实移除', `total=${afterDeleteJson.total}`, afterDelete.ok() && afterDeleteJson.total === 0);
    fs.rmSync(uploadPath, { force: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const hamburger = page.getByRole('button', { name: '打开导航' });
  check('窄屏显示抽屉导航入口', hamburger ? 'visible' : 'missing', await hamburger.isVisible().catch(() => false));
  await hamburger.click();
  await page.waitForSelector('.ant-drawer-open', { timeout: 5000 });
  check('390px 抽屉可打开', 'drawer open', (await page.locator('.ant-drawer-open').count()) > 0);
  await page.locator('.ant-drawer .app-menu').getByText('配置面板', { exact: true }).click({ timeout: 5000 });
  await page.waitForURL('**/config', { timeout: 15000 });
  const drawerClosed = await page.locator('.ant-drawer-open').count();
  const placeholderText = await page.locator('main').innerText();
  check('抽屉导航可跳转并自动关闭', `drawerOpen=${drawerClosed}`, drawerClosed === 0 && placeholderText.includes('配置面板'));

  // Config page real checks:
  await page.waitForSelector('.config-visual-container', { timeout: 10000 });
  const sectionTabs = await page.locator('.config-visual-container .ant-tabs-tab').count();
  const syncBadge = await page.locator('.config-sync-badge').innerText();
  check('配置面板展示全部 7 个功能分区与完整配置项', `tabs=${sectionTabs} badge=${syncBadge}`,
    sectionTabs === 7 && syncBadge.includes('项配置'));

  // Switch to logging tab to test debug switch toggle
  await page.locator('.config-visual-container .ant-tabs-tab', { hasText: '日志与诊断' }).click();
  await page.waitForTimeout(400);
  const debugSwitch = page.locator('.config-field-row', { hasText: '调试模式' }).locator('.ant-switch');
  await debugSwitch.click();
  await page.waitForTimeout(600);
  const debugToggled = await debugSwitch.getAttribute('aria-checked');
  await debugSwitch.click();
  await page.waitForTimeout(600);
  const debugReverted = await debugSwitch.getAttribute('aria-checked');
  check('配置面板标量开关支持即时更新与安全复位', `toggled=${debugToggled} reverted=${debugReverted}`,
    debugToggled === 'true' && debugReverted === 'false');

  // Switch to YAML source tab
  await page.locator('.ant-segmented-item', { hasText: '源码' }).click();
  await page.waitForSelector('.config-yaml-editor', { timeout: 10000 });
  await page.waitForTimeout(600);
  const yamlEditor = page.locator('.config-yaml-editor');
  const yamlLen = (await yamlEditor.inputValue()).length;
  await yamlEditor.fill((await yamlEditor.inputValue()) + '\n# acceptance-test-comment\n');
  await page.waitForTimeout(400);
  const dirtyTag = await page.locator('.config-source-toolbar .ant-tag').innerText();
  await page.locator('.config-header-actions button', { hasText: '刷新' }).click();
  await page.waitForTimeout(300);
  await page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').click();
  await page.waitForTimeout(600);
  const cleanTag = await page.locator('.config-source-toolbar .ant-tag').innerText();
  check('配置源码按需加载并支持脏状态保护与重载', `len=${yamlLen} dirtyTag=${dirtyTag} cleanTag=${cleanTag}`,
    yamlLen > 1000 && dirtyTag.includes('已修改') && cleanTag.includes('已同步'));

  // Check /plugins capability placeholder page
  await page.goto(`${appURL}/plugins`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.capability-status-banner', { timeout: 10000 });
  const pluginsProbe = await page.evaluate(() => ({
    statusTag: document.querySelector('.capability-status-tag')?.innerText || '',
    checkRows: Array.from(document.querySelectorAll('.capability-content tr.ant-table-row')).map((r) => r.innerText),
  }));
  check('插件管理占位页显示真实接口探测结果', `tag=${pluginsProbe.statusTag} rows=${pluginsProbe.checkRows.length}`,
    pluginsProbe.statusTag.includes('接口就绪') && pluginsProbe.checkRows.length === 1 && pluginsProbe.checkRows[0].includes('可用'));

  // Probe API rejection of unknown key
  const unknownProbe = await page.request.get(`${appURL}/api/v1/management/capabilities/unknown-key`);
  check('未知能力探测键返回 404', `status=${unknownProbe.status()}`, unknownProbe.status() === 404);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${appURL}/dashboard`, { waitUntil: 'networkidle' });
  const domSecrets = await page.evaluate((key) => {
    const text = document.body.innerText;
    return { hit: key ? text.includes(key) : false, length: text.length };
  }, managementKey);
  const apiSecrets = JSON.stringify(overview).includes(managementKey) || JSON.stringify(authFiles).includes(managementKey);
  check('页面与 API 投影不含 CPA Management Key', `dom=${domSecrets.hit} api=${apiSecrets}`, !domSecrets.hit && !apiSecrets && Boolean(managementKey));

  const unauthenticated = await fetch(`${appURL}/api/v1/management/overview`);
  check('没有 session 时 Overview 返回 401', `status=${unauthenticated.status}`, unauthenticated.status === 401);

  check('无 console error', consoleErrors.slice(0, 3).join(' | '), consoleErrors.length === 0);
  check('无失败请求', failedRequests.slice(0, 3).join(' | '), failedRequests.length === 0);
  check('无 4xx/5xx 响应', badResponses.slice(0, 3).join(' | '), badResponses.length === 0);

  await browser.close();

  const failures = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failures.length}/${results.length} browser checks passed`);
  if (failures.length > 0) {
    console.log('failed checks:');
    for (const failure of failures) console.log(` - ${failure.name}${failure.detail ? `: ${failure.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('browser acceptance crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
