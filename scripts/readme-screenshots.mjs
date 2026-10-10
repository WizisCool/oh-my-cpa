#!/usr/bin/env node
/**
 * Writes the screenshots the READMEs embed, under docs/images/readme/.
 *
 * The pictures are taken from the Go binary's demonstration mode, so they show the
 * sample dataset the public demo serves and can never contain an operator's data.
 * Deliberately outside every verification gate: a screenshot changes with the clock
 * the fixture is re-based to, so a freshness check on it could only ever be noise.
 * Run it by hand when a pictured page changes how it looks.
 *
 * Usage:
 *   pnpm build && pnpm readme:screenshots
 * Env overrides:
 *   OMCPA_BROWSER (explicit Chromium/Chrome/Edge executable), OMCPA_README_PORT
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { DEMO_ROUTES } from './demo-readiness.mjs';
import { hasReadmeScreenshotContent } from './readme-screenshot-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'images', 'readme');
const port = Number(process.env.OMCPA_README_PORT ?? 8791);
const base = `http://127.0.0.1:${port}`;

/** One set per README: the English page and the Simplified Chinese one. */
const LANGUAGES = ['en', 'zh'];
const MODES = ['light', 'dark'];

const DESKTOP = { width: 1440, height: 900, scale: 2 };
const PHONE = { width: 390, height: 844, scale: 3 };

/** Pages pictured on their own, each in both themes. */
const FEATURE_ROUTES = ['/usage/events', '/pricing', '/oauth-management', '/ai-providers'];
/** The three phones, left to right; alternating themes shows both in one picture. */
const PHONE_SHOTS = [
  { path: '/dashboard', mode: 'dark' },
  { path: '/usage/events', mode: 'light' },
  { path: '/oauth-management', mode: 'dark' },
];

const WEBP_QUALITY = 0.86;

function contentSelectorFor(routePath) {
  const route = DEMO_ROUTES.find((candidate) => candidate.path === routePath);
  if (!route) throw new Error(`no demo route for ${routePath}`);
  return route.content;
}

function fileNameFor(routePath) {
  return routePath.replace(/^\//, '').replaceAll('/', '-');
}

async function startDemoServer() {
  if (!fs.existsSync(path.join(root, 'internal', 'web', 'dist', 'index.html'))) {
    throw new Error('internal/web/dist is missing: run `pnpm build` first');
  }
  const server = spawn('go', ['run', './cmd/oh-my-cpa'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    // Its own process group, so stopping it also stops the binary `go run` started.
    detached: true,
    env: {
      ...process.env,
      OMCPA_DEMO_MODE: 'true',
      OMCPA_LISTEN_ADDR: `127.0.0.1:${port}`,
      OMCPA_BASE_PATH: '/',
      // A picture must not depend on what GitHub's release feed answers that day.
      OMCPA_UPDATE_CHECK_ENABLED: 'false',
      OMCPA_UPDATE_CHECK_ON_PAGE_LOAD: 'false',
    },
  });
  const exited = new Promise((_, reject) => {
    server.once('exit', (code) => reject(new Error(`demo server exited early with ${code}`)));
  });
  const healthy = (async () => {
    for (;;) {
      try {
        const response = await fetch(`${base}/api/healthz`);
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  await Promise.race([healthy, exited]);
  return () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
}

/** The dashboard window pictured: a month shows the fixture's traffic, a day is mostly empty. */
const DASHBOARD_RANGE = { preset: '30d' };

/**
 * Captures one route and returns the PNG with the page's own background colour.
 *
 * The theme and language are browser state, seeded before the console boots. The
 * dashboard window is a stored preference, so it is supplied the way the console reads
 * it: in the preference document it fetches. Choosing it through the console instead
 * would be a write, and a write in the demonstration raises its "changes are not
 * persisted" notice over the page being pictured.
 */
async function capture(browser, { routePath, mode, lang, viewport }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    reducedMotion: 'reduce',
    isMobile: viewport === PHONE,
    hasTouch: viewport === PHONE,
  });
  await context.addInitScript(([themeMode, language]) => {
    window.localStorage.setItem('omc-theme', JSON.stringify({ mode: themeMode }));
    window.localStorage.setItem('omc-lang', language);
  }, [mode, lang]);
  await context.route('**/api/v1/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.preferences = { ...body.preferences, dashboard_range: DASHBOARD_RANGE };
    return route.fulfill({ response, json: body });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}${routePath}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(hasReadmeScreenshotContent, contentSelectorFor(routePath), { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // Charts draw on animation frames after their data arrives; two frames settle them.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (!await page.evaluate(hasReadmeScreenshotContent, contentSelectorFor(routePath))) {
      throw new Error(`screenshot content became unsettled: ${routePath} (${lang}, ${mode})`);
    }
    const png = await page.screenshot({ type: 'png' });
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, background };
  } finally {
    await context.close();
  }
}

const WINDOW_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; }
  #stage { display: inline-block; padding: 36px 44px 60px; }
  .window { position: relative; width: 1200px; border-radius: 14px; overflow: hidden;
    box-shadow: 0 0 0 1px rgba(128, 128, 128, 0.32), 0 28px 60px -18px rgba(0, 0, 0, 0.45); }
  .layer { display: block; }
  .layer + .layer { position: absolute; inset: 0; }
  .bar { height: 34px; display: flex; align-items: center; gap: 7px; padding: 0 14px; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: rgba(128, 128, 128, 0.45); }
  .layer img { display: block; width: 100%; }
  .split { clip-path: polygon(58% 0, 100% 0, 100% 100%, 42% 100%); }
`;

function windowLayer(shot, className = '') {
  return `<div class="layer ${className}" style="background:${shot.background}">
    <div class="bar"><i></i><i></i><i></i></div><img src="${shot.dataUrl}"></div>`;
}

/** A framed window; with two shots the second covers the right of a diagonal. */
function windowDocument(first, second) {
  return `<style>${WINDOW_CSS}</style><div id="stage"><div class="window">
    ${windowLayer(first)}${second ? windowLayer(second, 'split') : ''}</div></div>`;
}

const PHONE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; }
  #stage { display: inline-flex; gap: 56px; padding: 36px 44px 64px; align-items: flex-start; }
  .phone { position: relative; width: 318px; padding: 9px; border-radius: 50px; background: #0c0c0e;
    box-shadow: 0 0 0 1.5px #3a3a40, 0 30px 60px -20px rgba(0, 0, 0, 0.55); }
  .phone:nth-child(2) { margin-top: 44px; }
  .screen { border-radius: 41px; overflow: hidden; }
  .status { height: 38px; display: flex; align-items: flex-end; justify-content: space-between;
    padding: 0 26px 6px; font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; }
  .island { position: absolute; top: 19px; left: 50%; width: 86px; height: 24px; margin-left: -43px;
    border-radius: 12px; background: #0c0c0e; }
  .battery { width: 22px; height: 11px; margin-bottom: 2px; padding: 1.5px; border: 1px solid currentColor;
    border-radius: 3.5px; opacity: 0.85; }
  .battery::after { content: ''; display: block; width: 78%; height: 100%; border-radius: 1.5px; background: currentColor; }
  .screen img { display: block; width: 100%; }
`;

function phoneDocument(shots) {
  const phones = shots.map((shot) => {
    const ink = shot.mode === 'dark' ? '#f2f2f2' : '#18181b';
    return `<div class="phone"><div class="screen" style="background:${shot.background}">
      <div class="status" style="color:${ink}"><span>9:41</span><span class="battery"></span></div>
      <img src="${shot.dataUrl}"></div><div class="island"></div></div>`;
  });
  return `<style>${PHONE_CSS}</style><div id="stage">${phones.join('')}</div>`;
}

/**
 * Renders a composition and writes it as WebP with its transparent margin intact.
 *
 * Chromium screenshots are PNG or JPEG only, and a 2x PNG of a dashboard is several
 * megabytes; re-encoding through a canvas reaches WebP without adding an image
 * library to the toolchain.
 */
async function writeComposition(page, html, file) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const png = await page.locator('#stage').screenshot({ type: 'png', omitBackground: true });
  const webp = await page.evaluate(async ([source, quality]) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/webp', quality);
  }, [`data:image/png;base64,${png.toString('base64')}`, WEBP_QUALITY]);
  const target = path.join(outDir, file);
  fs.writeFileSync(target, Buffer.from(webp.slice(webp.indexOf(',') + 1), 'base64'));
  console.log(`${path.relative(root, target)}  ${(fs.statSync(target).size / 1024).toFixed(0)} KiB`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const stopServer = await startDemoServer();
  const executablePath = (process.env.OMCPA_BROWSER || '').trim();
  const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
  try {
    const composer = await (await browser.newContext({ deviceScaleFactor: 2 })).newPage();
    for (const lang of LANGUAGES) {
      const [light, dark] = await Promise.all(MODES.map((mode) =>
        capture(browser, { routePath: '/dashboard', mode, lang, viewport: DESKTOP })));
      await writeComposition(composer, windowDocument(light, dark), `hero-split.${lang}.webp`);

      for (const routePath of FEATURE_ROUTES) {
        for (const mode of MODES) {
          const shot = await capture(browser, { routePath, mode, lang, viewport: DESKTOP });
          await writeComposition(composer, windowDocument(shot), `${fileNameFor(routePath)}-${mode}.${lang}.webp`);
        }
      }

      const phones = [];
      for (const { path: routePath, mode } of PHONE_SHOTS) {
        phones.push({ ...(await capture(browser, { routePath, mode, lang, viewport: PHONE })), mode });
      }
      await writeComposition(composer, phoneDocument(phones), `mobile.${lang}.webp`);
    }
  } finally {
    await browser.close();
    stopServer();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
