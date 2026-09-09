import { chromium } from 'playwright-core';
import path from 'node:path';

const outDir = '<capture-output-directory>';
const baseUrl = process.env.OMCPA_URL || 'http://127.0.0.1:5173/omc';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log('Navigating to login...');
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

  // Check if login form is present
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.count() > 0) {
    console.log('Logging in with admin...');
    await passwordInput.fill('admin');
    await page.locator('button[type="submit"], button:has-text("登录")').click();
    await page.waitForTimeout(1000);
  }

  const routes = [
    { name: 'dashboard', path: '/dashboard' },
    { name: 'ai_providers', path: '/ai-providers' },
    { name: 'auth_files', path: '/auth-files' },
    { name: 'quota', path: '/quota' },
    { name: 'usage_events', path: '/usage/events' },
    { name: 'config', path: '/config' },
    { name: 'pricing', path: '/pricing' },
    { name: 'oauth', path: '/oauth' },
    { name: 'system', path: '/system' },
    { name: 'quick_start', path: '/quick-start' },
  ];

  for (const r of routes) {
    const url = `${baseUrl}${r.path}`;
    console.log(`Capturing ${r.name} at ${url}...`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(800);
      const outPath = path.join(outDir, `page_${r.name}.png`);
      await page.screenshot({ path: outPath });
      console.log(`Saved ${outPath}`);
    } catch (e) {
      console.error(`Error capturing ${r.name}:`, e.message);
    }
  }

  await browser.close();
  console.log('Done!');
}

main().catch(console.error);
