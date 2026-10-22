/**
 * Adding a provider through the console reaches the gateway: the editor's save becomes a
 * CPA configuration write, and the provider list read back from CPA shows the new entry.
 */
const PROVIDER_NAME = 'Acceptance Relay';
const PROVIDER_BASE_URL = 'https://relay.acceptance.test/v1';

export async function runAddProviderAcceptance({ appURL, page, check, checkEventually, fakeCpa }) {
  await page.goto(`${appURL}/ai-providers`, { waitUntil: 'domcontentloaded' });
  await page.locator('.providers-page').first().waitFor({ state: 'visible', timeout: 15_000 });
  const writesBefore = fakeCpa.requests.filter((request) => request.method !== 'GET').length;

  await page.getByRole('button', { name: /添加提供商|Add Provider/ }).first().click();
  await page.getByRole('combobox', { name: /驱动类型 \/ 协议|Driver \/ Protocol/ }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByPlaceholder(/DeepSeek 官方主线路|DeepSeek Official/).fill(PROVIDER_NAME);
  await page.getByPlaceholder(/api\.deepseek\.com\/v1/).fill(PROVIDER_BASE_URL);
  await page.getByPlaceholder(/请输入上游提供商 API 密钥|Enter upstream provider API key/).first().fill('acceptance-relay-key-0001');
  await page.getByRole('button', { name: /^(保存|Save)$/ }).click();

  await checkEventually(
    'saving a new provider writes CPA configuration',
    () => fakeCpa.requests.filter((request) => request.method !== 'GET').length > writesBefore,
    { timeoutMs: 15_000 },
  );
  await checkEventually(
    'the new provider is listed from what CPA now holds',
    async () => {
      const response = await page.request.get(`${appURL}/api/v1/management/providers`);
      const body = await response.json();
      return (body.providers ?? []).some((provider) => provider.name === PROVIDER_NAME && provider.base_url === PROVIDER_BASE_URL);
    },
    { timeoutMs: 15_000 },
  );
  await checkEventually(
    'the provider list shows the new provider',
    () => page.locator('.providers-page').getByText(PROVIDER_NAME, { exact: true }).first().isVisible(),
    { timeoutMs: 15_000 },
  );
}
