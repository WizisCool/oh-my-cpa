import { chromium } from 'playwright-core';

const outDir = '<capture-output-directory>';
const baseUrl = 'http://localhost:5173/omc';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
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

  // 1. Dark mode full viewport
  await page.screenshot({ path: `${outDir}/pricing_dark.png` });
  console.log('Saved pricing_dark.png');

  // Scroll to leaderboard
  const leaderboard = page.locator('[data-testid="pricing-leaderboard"]');
  if (await leaderboard.count() > 0) {
    await leaderboard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    // Hover on first bar to show popover
    const firstBar = leaderboard.locator('[class*="barRow"]').first();
    if (await firstBar.count() > 0) {
      await firstBar.hover();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: `${outDir}/pricing_leaderboard_dark.png` });
    console.log('Saved pricing_leaderboard_dark.png');
  }

  // Toggle theme to light mode: Header has theme toggle icon
  const themeBtn = page.locator('.ant-layout-header button:has(.anticon-sun), .ant-layout-header button:has(.anticon-moon), button[title*="主题"], button[aria-label*="主题"]');
  if (await themeBtn.count() > 0) {
    await themeBtn.first().click();
    await page.waitForTimeout(800);

    // Light mode leaderboard
    if (await leaderboard.count() > 0) {
      await leaderboard.scrollIntoViewIfNeeded();
      const firstBar = leaderboard.locator('[class*="barRow"]').first();
      if (await firstBar.count() > 0) {
        await firstBar.hover();
        await page.waitForTimeout(500);
      }
      await page.screenshot({ path: `${outDir}/pricing_leaderboard_light.png` });
      console.log('Saved pricing_leaderboard_light.png');
    }

    // Full page light
    await page.screenshot({ path: `${outDir}/pricing_light.png` });
    console.log('Saved pricing_light.png');

    // Toggle back to dark
    await themeBtn.first().click();
    await page.waitForTimeout(400);
  }

  await browser.close();
  console.log('Done!');
}

main().catch(console.error);
