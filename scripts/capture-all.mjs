// Ad-hoc screenshot capture of every route, for design review by a human.
//
// Deliberately outside every verification gate: browser-acceptance.mjs owns
// assertions, this script only writes PNGs. It drives a real Chromium against a
// real instance, so it needs a running server and the real management key.
//
// Usage:
//   node scripts/capture-all.mjs
// Env overrides:
//   OMCPA_URL, OMCPA_CAPTURE_DIR, OMCPA_CPA_MANAGEMENT_KEY,
//   OMCPA_BROWSER (absolute path to a Chromium/Edge/Chrome executable)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.OMCPA_URL || 'http://127.0.0.1:5173/omc').replace(/\/$/, '');
// Defaulting inside tmp/ keeps captures out of the worktree and out of commits:
// tmp/ is gitignored, so this cannot leak review screenshots into the repository.
const outDir = process.env.OMCPA_CAPTURE_DIR || path.join(root, 'tmp', 'captures');
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

function browserExecutable() {
  const candidates = [process.env.OMCPA_BROWSER].filter(Boolean);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const playwrightRoot = path.join(localAppData, 'ms-playwright');
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  if (fs.existsSync(playwrightRoot)) {
    for (const entry of fs.readdirSync(playwrightRoot)) {
      for (const name of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
        const full = path.join(playwrightRoot, entry, name);
        if (fs.existsSync(full)) return full;
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
  const executable = browserExecutable();
  if (!executable) throw new Error('no Chromium/Edge/Chrome executable found; set OMCPA_BROWSER');
  if (!password) throw new Error('OMCPA_CPA_MANAGEMENT_KEY is required (set it or fill .env)');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ executablePath: executable, headless: true });
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

  await browser.close();
  console.log('Done!');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
