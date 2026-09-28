// Ad-hoc dual-language capture of the price book and its editor, for design review.
//
// Deliberately outside every verification gate: browser-acceptance.mjs owns
// assertions, this script only writes PNGs. It drives a real browser against a
// real instance, so it needs a running server and the real management key.
//
// Usage:
//   node scripts/capture-pricing.mjs
// Env overrides:
//   OMCPA_URL, OMCPA_CAPTURE_DIR, OMCPA_CPA_MANAGEMENT_KEY,
//   OMCPA_BROWSER (explicit Chromium/Chrome/Edge executable)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.OMCPA_URL || 'http://127.0.0.1:5173/omc').replace(/\/$/, '');
// Resolved against the repository root so a relative override still lands in the
// worktree, and defaulted into gitignored tmp/ so captures cannot be committed.
const outDir = path.resolve(root, process.env.OMCPA_CAPTURE_DIR || 'tmp/captures');
// Oh My CPA has no separate admin password: login uses the CPA management key.
const password = process.env.OMCPA_CPA_MANAGEMENT_KEY || readEnvFile('OMCPA_CPA_MANAGEMENT_KEY') || '';

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

// Playwright resolves its own downloaded Chromium when no explicit path is
// given, which is the only portable option: a hand-written search for Windows
// Chrome/Edge install locations finds nothing on Linux or macOS.
function launchOptions() {
  const executablePath = (process.env.OMCPA_BROWSER || '').trim();
  return executablePath ? { executablePath, headless: true } : { headless: true };
}

// The language switch is a menu: the trigger opens it, and the reading language is
// picked from the list rather than cycled to.
async function switchLanguage(page, label) {
  const trigger = page.locator('.app-header').getByRole('button', { name: /Language|界面语言/ });
  if ((await trigger.count()) === 0) return false;
  await trigger.click();
  const item = page.locator('.ant-dropdown:visible .language-menu-item').filter({ hasText: new RegExp(label) });
  if ((await item.count()) === 0) return false;
  await item.first().click();
  await page.waitForTimeout(600);
  return true;
}

async function main() {
  if (!password) throw new Error('OMCPA_CPA_MANAGEMENT_KEY is required (set it or fill .env)');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch(launchOptions());
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const page = await context.newPage();

    console.log(`Capturing into ${outDir}`);
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

    const passwordInput = page.locator('input[type="password"]');
    if ((await passwordInput.count()) > 0) {
      await passwordInput.fill(password);
      await page.locator('button[type="submit"], button:has-text("登录")').click();
      await page.waitForTimeout(1000);
    }

    await page.goto(`${baseUrl}/pricing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // The book, then one model's editor drawer, then the channel tab: the three surfaces a
    // pricing change touches.
    const captureAll = async (suffix) => {
      await page.screenshot({ path: path.join(outDir, `pricing_book_${suffix}.png`), fullPage: true });
      const edit = page.locator('[data-testid="pricing-row-edit"]').first();
      if ((await edit.count()) > 0) {
        await edit.click();
        await page.locator('[data-testid="pricing-editor"]').waitFor({ state: 'visible' });
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(outDir, `pricing_editor_${suffix}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      await page.goto(`${baseUrl}/pricing?tab=channels`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outDir, `pricing_channels_${suffix}.png`), fullPage: true });
      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
    };

    await captureAll('zh');
    if (await switchLanguage(page, 'English')) {
      await captureAll('en');
    }
  } finally {
    await browser.close();
  }
  console.log('Done!');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
