#!/usr/bin/env node
/**
 * Renders the public site's social preview cards (Open Graph and Twitter, 1200x630) into
 * `deploy/site/og/`. The PNGs are committed; run `pnpm site:social-cards` after changing the
 * copy below or the README hero screenshot. `OMCPA_BROWSER` selects a Chromium binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'site', 'og');
const WIDTH = 1200;
const HEIGHT = 630;

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
    html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
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

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const executablePath = (process.env.OMCPA_BROWSER || '').trim();
  const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    for (const card of CARDS) {
      await page.setContent(cardDocument(card), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const target = path.join(outDir, card.file);
      await page.screenshot({ path: target, type: 'png' });
      console.log(`${path.relative(root, target)}  ${(fs.statSync(target).size / 1024).toFixed(0)} KiB`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
