#!/usr/bin/env node
/**
 * Renders social preview cards:
 * - Public site Open Graph / Twitter cards (1200x630) into `deploy/site/og/`.
 * - GitHub repository social preview (1280x640) into `docs/images/social-preview.png`.
 *
 * The PNGs are committed; run `pnpm site:social-cards` (or pass `--only=github` / `--only=site`)
 * after changing the copy below or refreshing README screenshots. `OMCPA_BROWSER` selects a
 * Chromium binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'site', 'og');
const GITHUB_SOCIAL_PREVIEW = path.join(root, 'docs', 'images', 'social-preview.png');
const SITE_WIDTH = 1200;
const SITE_HEIGHT = 630;
const GITHUB_WIDTH = 1280;
const GITHUB_HEIGHT = 640;

const webRequire = createRequire(path.join(root, 'web', 'package.json'));
const LUCIDE_DIR = path.join(path.dirname(webRequire.resolve('lucide-react/package.json')), 'dist', 'esm', 'icons');
const PROVIDER_DIR = path.join(path.dirname(webRequire.resolve('@lobehub/icons-static-svg/package.json')), 'icons');

const GITHUB_PROVIDERS = [
  ['claude', 'claude-color'],
  ['openai', 'openai'],
  ['gemini', 'gemini-color'],
  ['antigravity', 'antigravity-color'],
  ['deepseek', 'deepseek-color'],
  ['kimi', 'kimi-color'],
];

const GITHUB_PILLARS = [
  { icon: 'server', label: 'APIs & OAuth' },
  { icon: 'layers', label: 'Visual Routing' },
  { icon: 'chart-line', label: 'Quota & Cost' },
  { icon: 'bot', label: 'Agent & MCP' },
];

const CARDS = [
  {
    file: 'home-en.png',
    lang: 'en',
    title: 'The self-hosted AI gateway console',
    lead: 'Centralize APIs, OAuth and routing, observe requests, quota and cost.',
    visual: 'hero',
  },
  {
    file: 'home-zh.png',
    lang: 'zh',
    title: '自托管的 AI 网关控制台',
    lead: '集中管理 API、OAuth 与路由，可视化观测请求、配额与成本。',
    visual: 'hero',
  },
  {
    file: 'docs-en.png',
    lang: 'en',
    title: 'Oh My CPA documentation',
    lead: 'Install in minutes, keep it running, and find every setting.',
    visual: 'paths',
    paths: [
      ['Quickstart', 'Four commands, about three minutes'],
      ['Install with an agent', 'One prompt for your coding agent'],
      ['Reference', 'Every environment variable'],
    ],
  },
  {
    file: 'docs-zh.png',
    lang: 'zh',
    title: 'Oh My CPA 文档',
    lead: '几分钟完成安装，稳定运维，查到每一项设置。',
    visual: 'paths',
    paths: [
      ['快速开始', '四条命令，约三分钟'],
      ['让 Agent 安装', '一句提示词交给编码 Agent'],
      ['参考', '全部环境变量'],
    ],
  },
];

function dataUrl(file, type) {
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lucideBody(name) {
  const source = fs.readFileSync(path.join(LUCIDE_DIR, `${name}.mjs`), 'utf8');
  const alias = source.match(/export \{ default \} from '\.\/([\w-]+)\.mjs'/);
  if (alias) return lucideBody(alias[1]);
  const match = source.match(/const __iconData = (\{[\s\S]*?\n\});\n/);
  if (!match) throw new Error(`cannot read the Lucide icon ${name}`);
  const nodes = new Function(`return ${match[1]}`)().node;
  return nodes
    .map(([tag, attrs]) => {
      const serialized = Object.entries(attrs)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
      return `<${tag} ${serialized}/>`;
    })
    .join('');
}

function lucideIcon(name, className = 'ico') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${lucideBody(name)}</svg>`;
}

function providerSprite(providers) {
  const symbols = providers
    .map(([id, file]) => {
      const svg = fs.readFileSync(path.join(PROVIDER_DIR, `${file}.svg`), 'utf8');
      const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
      const fillRule = svg.match(/fill-rule="([^"]+)"/)?.[1];
      let body = svg
        .replace(/^<svg[^>]*>/, '')
        .replace(/<\/svg>\s*$/, '')
        .replace(/<title>[\s\S]*?<\/title>/, '')
        .replace(/lobe-icons-/g, `pm-${id}-`);
      if (id === 'kimi') body = body.replaceAll('fill="#fff"', 'fill="currentColor"');
      return `<symbol id="pm-${id}" viewBox="${viewBox}"${fillRule ? ` fill-rule="${fillRule}"` : ''}>${body}</symbol>`;
    })
    .join('');
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${symbols}</svg>`;
}

function cardDocument(card) {
  const wordmark = dataUrl(path.join(root, 'web', 'src', 'assets', 'brand', 'omc-wordmark-dark.svg'), 'image/svg+xml');
  const hero = dataUrl(path.join(root, 'docs', 'images', 'readme', `hero-split.${card.lang}.webp`), 'image/webp');
  const visual =
    card.visual === 'hero'
      ? `<img class="hero" src="${hero}" alt="">`
      : `<div class="paths">${card.paths
          .map(([title, body]) => `<div class="tile"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`)
          .join('')}</div>`;
  return `<!doctype html><html lang="${card.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    html, body { width: ${SITE_WIDTH}px; height: ${SITE_HEIGHT}px; overflow: hidden; }
    body {
      position: relative;
      background: #131314;
      color: #e3e3e4;
      font-family: Inter, 'Segoe UI', 'Helvetica Neue', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    }
    .copy { position: absolute; left: 72px; top: 72px; bottom: 64px; width: ${card.visual === 'hero' ? 520 : 560}px; display: flex; flex-direction: column; }
    .wordmark { height: 30px; width: auto; align-self: flex-start; }
    h1 { margin-top: auto; font-size: 54px; line-height: 1.12; font-weight: 700; letter-spacing: ${card.lang === 'zh' ? '0' : '-0.025em'}; }
    p { margin-top: 22px; font-size: 24px; line-height: 1.5; color: #a7a7ab; }
    .site { margin-top: 36px; font-size: 20px; color: #00a2fb; font-weight: 600; }
    .hero { position: absolute; left: 640px; top: 96px; width: 920px; height: auto; }
    .paths { position: absolute; right: 72px; top: 50%; transform: translateY(-50%); width: 420px; display: flex; flex-direction: column; gap: 16px; }
    .tile {
      display: flex; flex-direction: column; gap: 6px; padding: 22px 24px; border-radius: 12px; background: #1b1b1c;
      box-shadow: 0 0 0 1px rgba(227, 227, 228, 0.125), inset 0 1px 0 rgba(227, 227, 228, 0.06), 0 4px 12px -4px rgba(0, 0, 0, 0.42);
    }
    .tile strong { font-size: 24px; font-weight: 650; }
    .tile span { font-size: 19px; color: #a7a7ab; }
  </style></head><body>
    <div class="copy">
      <img class="wordmark" src="${wordmark}" alt="">
      <h1>${escapeHtml(card.title)}</h1>
      <p>${escapeHtml(card.lead)}</p>
      <div class="site">omc.junze.dev${card.visual === 'paths' ? '/docs' : ''}</div>
    </div>
    ${visual}
  </body></html>`;
}

function githubSocialPreviewDocument() {
  const sarasa400 = dataUrl(path.join(root, 'web', 'src', 'assets', 'fonts', 'sarasa', 'sarasa-mono-sc-400-000.woff2'), 'font/woff2');
  const sarasa600 = dataUrl(path.join(root, 'web', 'src', 'assets', 'fonts', 'sarasa', 'sarasa-mono-sc-600-000.woff2'), 'font/woff2');
  const wordmark = dataUrl(path.join(root, 'web', 'src', 'assets', 'brand', 'omc-wordmark-dark.svg'), 'image/svg+xml');
  const hero = dataUrl(path.join(root, 'docs', 'images', 'readme', 'hero-split.en.webp'), 'image/webp');
  const pillarsHtml = GITHUB_PILLARS.map(
    ({ icon, label }) => `<div class="pillar">${lucideIcon(icon)}<span>${escapeHtml(label)}</span></div>`,
  ).join('');
  const providersHtml = GITHUB_PROVIDERS.map(
    ([id]) => `<svg class="pmark" fill="currentColor" aria-hidden="true"><use href="#pm-${id}"/></svg>`,
  ).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Sarasa Mono SC'; src: url('${sarasa400}') format('woff2'); font-weight: 400; }
    @font-face { font-family: 'Sarasa Mono SC'; src: url('${sarasa600}') format('woff2'); font-weight: 600; }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: ${GITHUB_WIDTH}px; height: ${GITHUB_HEIGHT}px; overflow: hidden; }
    body {
      position: relative;
      background: #0b0b0d;
      color: #e6e6e7;
      font-family: 'Inter', 'Lato', 'Segoe UI', 'Liberation Sans', sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .atmosphere {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(820px 540px at 78% 18%, rgba(0, 162, 251, 0.17), transparent 64%),
        radial-gradient(540px 420px at 14% 88%, rgba(0, 162, 251, 0.06), transparent 68%);
    }
    .left {
      position: absolute;
      left: 68px;
      top: 58px;
      bottom: 56px;
      width: 452px;
      display: flex;
      flex-direction: column;
      z-index: 2;
    }
    .wordmark {
      height: 38px;
      width: auto;
      align-self: flex-start;
      display: block;
    }
    .copy-mid {
      margin-top: auto;
      margin-bottom: auto;
      padding-bottom: 14px;
    }
    h1 {
      font-size: 50px;
      line-height: 1.12;
      font-weight: 700;
      letter-spacing: -0.028em;
      background: linear-gradient(180deg, #f8f8fa 15%, #c7c8d0 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .accent-rule {
      margin-top: 28px;
      width: 44px;
      height: 2px;
      border-radius: 2px;
      background: linear-gradient(90deg, #00a2fb, rgba(0, 162, 251, 0.14));
    }
    .pillars {
      margin-top: 26px;
      display: grid;
      grid-template-columns: repeat(2, max-content);
      gap: 15px 34px;
    }
    .pillar {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: 'Sarasa Mono SC', monospace;
      font-size: 15px;
      font-weight: 600;
      color: #c8c8d0;
    }
    .pillar .ico {
      width: 17px;
      height: 17px;
      flex: 0 0 auto;
      color: #00a2fb;
      opacity: 0.92;
    }
    .foot {
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .providers {
      display: flex;
      align-items: center;
      gap: 14px;
      color: #d6d6dc;
      opacity: 0.86;
    }
    .pmark {
      width: 17px;
      height: 17px;
      display: block;
    }
    .sep {
      width: 1px;
      height: 15px;
      background: rgba(230, 230, 231, 0.16);
    }
    .url {
      font-family: 'Sarasa Mono SC', monospace;
      font-size: 15px;
      font-weight: 600;
      color: #00a2fb;
      letter-spacing: -0.01em;
    }
    .stage {
      position: absolute;
      left: 562px;
      top: 48px;
      width: 924px;
      height: 620px;
      border-radius: 20px;
      padding: 10px;
      background: linear-gradient(
        155deg,
        rgba(255, 255, 255, 0.115) 0%,
        rgba(255, 255, 255, 0.025) 45%,
        rgba(0, 162, 251, 0.07) 100%
      );
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.09),
        0 36px 90px -16px rgba(0, 0, 0, 0.85),
        0 0 84px -20px rgba(0, 162, 251, 0.22);
      overflow: hidden;
      z-index: 2;
    }
    .stage::before {
      content: '';
      position: absolute;
      left: 24px;
      right: 180px;
      top: 0;
      height: 1px;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255, 255, 255, 0.26) 28%,
        rgba(0, 162, 251, 0.34) 68%,
        transparent
      );
      pointer-events: none;
      z-index: 3;
    }
    .stage-inner {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 12px;
      overflow: hidden;
      background: #141416;
    }
    .stage-inner img {
      position: absolute;
      /* Crop the transparent margin baked into hero-split.en.webp (44/1288 left, 36/880 top). */
      left: -34px;
      top: -27px;
      width: 996px;
      height: auto;
      display: block;
    }
    .stage-fade {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 30px;
      background: linear-gradient(90deg, transparent, rgba(11, 11, 13, 0.4));
      z-index: 4;
      pointer-events: none;
    }
  </style></head><body>
    ${providerSprite(GITHUB_PROVIDERS)}
    <div class="atmosphere"></div>
    <div class="left">
      <img class="wordmark" src="${wordmark}" alt="Oh-My-CPA">
      <div class="copy-mid">
        <h1>The self-hosted<br>AI gateway console</h1>
        <div class="accent-rule"></div>
        <div class="pillars">${pillarsHtml}</div>
      </div>
      <div class="foot">
        <div class="providers">${providersHtml}</div>
        <span class="sep"></span>
        <span class="url">omc.junze.dev</span>
      </div>
    </div>
    <div class="stage">
      <div class="stage-inner"><img src="${hero}" alt=""></div>
    </div>
    <div class="stage-fade"></div>
  </body></html>`;
}

function parseOnlyArg(argv) {
  const flag = argv.find((arg) => arg.startsWith('--only='));
  if (!flag) return 'all';
  const value = flag.slice('--only='.length);
  if (value !== 'all' && value !== 'site' && value !== 'github') {
    throw new Error(`invalid --only target "${value}" (expected all, site, or github)`);
  }
  return value;
}

async function main() {
  const only = parseOnlyArg(process.argv.slice(2));
  const executablePath = (process.env.OMCPA_BROWSER || '').trim();
  const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
  try {
    if (only === 'all' || only === 'site') {
      fs.mkdirSync(outDir, { recursive: true });
      const page = await browser.newPage({ viewport: { width: SITE_WIDTH, height: SITE_HEIGHT }, deviceScaleFactor: 1 });
      for (const card of CARDS) {
        await page.setContent(cardDocument(card), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const target = path.join(outDir, card.file);
        await page.screenshot({ path: target, type: 'png' });
        console.log(`${path.relative(root, target)}  ${(fs.statSync(target).size / 1024).toFixed(0)} KiB`);
      }
      await page.close();
    }

    if (only === 'all' || only === 'github') {
      fs.mkdirSync(path.dirname(GITHUB_SOCIAL_PREVIEW), { recursive: true });
      const page = await browser.newPage({ viewport: { width: GITHUB_WIDTH, height: GITHUB_HEIGHT }, deviceScaleFactor: 1 });
      await page.setContent(githubSocialPreviewDocument(), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: GITHUB_SOCIAL_PREVIEW, type: 'png' });
      console.log(`${path.relative(root, GITHUB_SOCIAL_PREVIEW)}  ${(fs.statSync(GITHUB_SOCIAL_PREVIEW).size / 1024).toFixed(0)} KiB`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
