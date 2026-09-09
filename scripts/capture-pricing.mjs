import { chromium } from 'playwright-core';

const outDir = '<capture-output-directory>';
const baseUrl = 'http://localhost:5173/omc';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
  await page.waitForTimeout(800);

  // 1. Dark mode
  await page.screenshot({ path: `${outDir}/pricing_dark.png` });
  console.log('Saved pricing_dark.png');

  // Toggle theme to light mode: Header has theme toggle icon
  // Check header buttons
  const themeBtn = page.locator('.ant-layout-header button:has(.anticon-sun), .ant-layout-header button:has(.anticon-moon), button[title*="主题"], button[aria-label*="主题"]');
  if (await themeBtn.count() > 0) {
    await themeBtn.first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${outDir}/pricing_light.png` });
    console.log('Saved pricing_light.png');

    // 2. Open Modal in light mode
    const addBtn = page.locator('button:has-text("添加价格")');
    if (await addBtn.count() > 0) {
      await addBtn.first().click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${outDir}/pricing_modal_light.png` });
      console.log('Saved pricing_modal_light.png');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    // Toggle back to dark
    await themeBtn.first().click();
    await page.waitForTimeout(400);
  } else {
    // If button not found by class, look for any header button that toggles theme
    const allHeaderBtns = page.locator('.ant-layout-header button');
    const count = await allHeaderBtns.count();
    console.log('Header buttons count:', count);
  }

  await browser.close();
  console.log('Done!');
}

main().catch(console.error);
