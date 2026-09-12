// Ad-hoc screenshot capture of every route, for design review by a human.
//
// Deliberately outside every verification gate: browser-acceptance.mjs owns
// assertions, this script only writes PNGs. It drives a real browser against a
// real instance, so it needs a running server and the real management key.
//
// Usage:
//   node scripts/capture-all.mjs
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

async function main() {
  if (!password) throw new Error('OMCPA_CPA_MANAGEMENT_KEY is required (set it or fill .env)');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch(launchOptions());
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log(`Capturing into ${outDir}`);
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

    const passwordInput = page.locator('input[type="password"]');
    if ((await passwordInput.count()) > 0) {
      await passwordInput.fill(password);
      await page.locator('button[type="submit"], button:has-text("登录")').click();
      await page.waitForTimeout(1000);
    }

    for (const route of routes) {
      const url = `${baseUrl}${route.path}`;
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
        await page.waitForTimeout(800);
        const outPath = path.join(outDir, `page_${route.name}.png`);
        await page.screenshot({ path: outPath });
        console.log(`Saved ${outPath}`);
      } catch (error) {
        // One unreachable route must not abandon the remaining captures.
        console.error(`Error capturing ${route.name}:`, error.message);
      }
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
