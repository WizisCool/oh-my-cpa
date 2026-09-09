import { chromium } from 'playwright-core';

const outDir = '<capture-output-directory>';
const baseUrl = 'http://localhost:5173/omc';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();

  console.log('Navigating to login...');
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

  const pwd = page.locator('input[type="password"]');
  if (await pwd.count() > 0) {
    console.log('Logging in...');
    await pwd.fill('admin');
    await page.locator('button[type="submit"], button:has-text("登录")').click();
    await page.waitForTimeout(1000);
  }

  console.log('Navigating to pricing...');
  await page.goto(`${baseUrl}/pricing`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const leaderboard = page.locator('[data-testid="pricing-leaderboard"]');

  // 1. Chinese mode leaderboard
  if (await leaderboard.count() > 0) {
    await leaderboard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await leaderboard.screenshot({ path: `${outDir}/pricing_leaderboard_zh.png` });
    console.log('Saved pricing_leaderboard_zh.png');
  }

  // 2. Toggle language to English: click language button
  const langBtn = page.locator('button:has(span.terminal-mono:text("EN")), button:has(span.terminal-mono:text("中"))');
  if (await langBtn.count() > 0) {
    const text = await langBtn.innerText();
    // If it says EN, clicking it switches to EN
    if (text.includes('EN')) {
      await langBtn.click();
      await page.waitForTimeout(600);
    }
  }

  // 3. English mode leaderboard
  if (await leaderboard.count() > 0) {
    await leaderboard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await leaderboard.screenshot({ path: `${outDir}/pricing_leaderboard_en.png` });
    console.log('Saved pricing_leaderboard_en.png');
  }

  // 4. English mode full pricing page
  await page.screenshot({ path: `${outDir}/pricing_full_en.png` });
  console.log('Saved pricing_full_en.png');

  // Switch back to Chinese
  if (await langBtn.count() > 0) {
    const text = await langBtn.innerText();
    if (text.includes('中')) {
      await langBtn.click();
      await page.waitForTimeout(600);
    }
  }

  // 5. Chinese mode full pricing page
  await page.screenshot({ path: `${outDir}/pricing_full_zh.png` });
  console.log('Saved pricing_full_zh.png');

  await browser.close();
  console.log('Done!');
}

main().catch(console.error);
