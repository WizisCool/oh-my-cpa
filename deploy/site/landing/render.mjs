/**
 * Renders the public landing page for each language as static HTML.
 *
 * `scripts/build-site.mjs` imports this module, writes one document per entry in
 * `LANDING_PAGES`, and copies the rest of this directory (styles, script) beside them.
 * Every story on the page is rendered in its finished state, so crawlers, readers without
 * JavaScript and reduced-motion readers get the complete content; `site.js` replays the
 * stories when they come into view.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { brandDrawing, brandMarkup } from '../../../web/src/assets/brand/markup.ts';
import { CPA_URL, GITHUB_URL, SITE_ORIGIN } from '../site-meta.mjs';
import {
  COMPOSE_COMMANDS,
  COPY,
  COST_MODELS,
  LANDING_PAGES,
  OAUTH_ROWS,
  RECEIPT_LINES,
  REQUEST_ROWS,
  standaloneCommands,
} from './copy.mjs';

export { LANDING_PAGES, SITE_ORIGIN };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const webRequire = createRequire(path.join(ROOT, 'web', 'package.json'));
const LUCIDE_DIR = path.join(path.dirname(webRequire.resolve('lucide-react/package.json')), 'dist', 'esm', 'icons');
const PROVIDER_DIR = path.join(path.dirname(webRequire.resolve('@lobehub/icons-static-svg/package.json')), 'icons');

// Provider marks the page draws, keyed by the id the markup refers to.
const PROVIDER_FILES = {
  claude: 'claude-color',
  codex: 'codex-color',
  gemini: 'gemini-color',
  antigravity: 'antigravity-color',
  vertex: 'vertexai-color',
  kimi: 'kimi-color',
  deepseek: 'deepseek-color',
  openrouter: 'openrouter',
  opencode: 'opencode',
  openai: 'openai',
};

const lucideCache = new Map();

/** Reads a Lucide icon's drawing from the package the console uses, so both stay in step. */
function lucideBody(name) {
  if (!lucideCache.has(name)) {
    const source = fs.readFileSync(path.join(LUCIDE_DIR, `${name}.mjs`), 'utf8');
    // Renamed icons keep their old name as a module that re-exports the new one.
    const alias = source.match(/export \{ default \} from '\.\/([\w-]+)\.mjs'/);
    if (alias) {
      lucideCache.set(name, lucideBody(alias[1]));
      return lucideCache.get(name);
    }
    const match = source.match(/const __iconData = (\{[\s\S]*?\n\});\n/);
    if (!match) throw new Error(`cannot read the Lucide icon ${name}`);
    const nodes = new Function(`return ${match[1]}`)().node;
    const body = nodes
      .map(([tag, attributes]) => {
        const attrs = Object.entries(attributes)
          .filter(([key]) => key !== 'key')
          .map(([key, value]) => `${key}="${value}"`)
          .join(' ');
        return `<${tag} ${attrs}/>`;
      })
      .join('');
    lucideCache.set(name, body);
  }
  return lucideCache.get(name);
}

function icon(name, className = 'icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${lucideBody(name)}</svg>`;
}

function providerSymbol(id, file) {
  const svg = fs.readFileSync(path.join(PROVIDER_DIR, `${file}.svg`), 'utf8');
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
  const fillRule = svg.match(/fill-rule="([^"]+)"/)?.[1];
  let body = svg
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/lobe-icons-/g, `pm-${id}-`);
  if (id === 'kimi') {
    body = body.replaceAll('fill="#fff"', 'fill="currentColor"');
  }
  return `<symbol id="pm-${id}" viewBox="${viewBox}"${fillRule ? ` fill-rule="${fillRule}"` : ''}>${body}</symbol>`;
}

const SPRITE = `<svg class="sprite" width="0" height="0" aria-hidden="true">${Object.entries(PROVIDER_FILES)
  .map(([id, file]) => providerSymbol(id, file))
  .join('')}</svg>`;

/** A provider mark; `app` stands for a client of your own and draws a code glyph. */
function pmark(id, className = 'pmark') {
  if (id === 'app') return icon('code-xml', `${className} is-glyph`);
  return `<svg class="${className}" fill="currentColor" aria-hidden="true"><use href="#pm-${id}"/></svg>`;
}

/** The brand drawings with their two colours bound to classes, so the page theme drives them. */
function brand(shape, className) {
  const { viewBox } = brandDrawing(shape);
  const body = brandMarkup(shape, { ink: '__ink__', accent: '__accent__' })
    .replace(/ id="[^"]*"/g, '')
    .replace(/fill="__ink__"/g, 'class="b-ink"')
    .replace(/fill="__accent__"/g, 'class="b-accent"');
  return `<svg class="${className}" viewBox="${viewBox}" aria-hidden="true">${body}</svg>`;
}

const GITHUB_MARK =
  '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>';

const MACOS_CURSOR =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5.5 2.5v16.4l3.9-3.9 2.6 5.6c.2.5.8.7 1.3.5l1.4-.7c.5-.2.7-.8.5-1.3l-2.6-5.5h5.3L5.5 2.5Z" fill="#111113" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ hero console */

function consoleWindow(text) {
  const c = text.console;
  const activeLabel = c.crumb[1];
  const nav = c.nav
    .map(
      ([group, items]) =>
        `<div class="c-group"><span class="c-group-label">${escapeHtml(group)}</span>${items
          .map(([glyph, label]) => `<span class="c-nav${label === activeLabel ? ' is-active' : ''}">${icon(glyph)}${escapeHtml(label)}</span>`)
          .join('')}</div>`,
    )
    .join('');
  const readTools = c.readTools
    .map(
      (tool, index) =>
        `<div class="c-tool" data-at="${900 + index * 450}" data-done="${1500 + index * 450}"><span class="c-tool-state">${icon('loader-circle', 'icon is-spin')}${icon('check', 'icon is-done')}</span>${escapeHtml(tool)}</div>`,
    )
    .join('');
  const compareRows = c.compare.rows
    .map(
      ([id, name, reqs, rate, width, tone]) =>
        `<div class="c-cmp-row${tone === 'warn' ? ' is-warn' : ''}">
          <span class="c-cmp-name">${pmark(id)}${escapeHtml(name)}</span>
          <span class="c-cmp-num">${escapeHtml(reqs)}</span>
          <span class="c-cmp-rate"><span class="c-bar" style="--fill: ${width}%"><i></i></span><b>${escapeHtml(rate)}</b></span>
        </div>`,
    )
    .join('');
  return `<figure class="hero-figure">
        <div class="window console" aria-hidden="true">
          <div class="console-body">
            <div class="c-side">
              <div class="c-brand">${brand('wordmark', 'c-wordmark')}</div>
              <div class="c-nav-scroll">${nav}</div>
            </div>
            <div class="c-panel" data-story data-length="15500">
              <div class="c-head">
                <span class="c-head-left">${icon('panel-left')}<span class="c-crumb">${escapeHtml(c.crumb[0])}${icon('chevron-right')}<b>${escapeHtml(c.crumb[1])}</b></span></span>
              </div>
              <div class="c-thread" data-thread>
                <div class="c-msg is-user" data-at="0" data-initial>${escapeHtml(c.u1)}</div>
                <div class="c-thinking" data-at="300" data-gone="900" data-transient><span class="dots"><i></i><i></i><i></i></span>${escapeHtml(c.thinking)}</div>
                <div class="c-tools">${readTools}</div>
                <div class="c-msg is-agent" data-at="2300">
                  <p>${c.a1}</p>
                  <div class="c-compare">
                    <div class="c-cmp-head"><span>${escapeHtml(c.compare.cols[0])}</span><span class="c-cmp-num">${escapeHtml(c.compare.cols[1])}</span><span class="c-cmp-num">${escapeHtml(c.compare.cols[2])}</span></div>
                    ${compareRows}
                  </div>
                </div>
                <div class="c-msg is-user" data-at="5400" data-compose="1400">${escapeHtml(c.u2)}</div>
                <div class="c-tool" data-at="5800" data-done="6400"><span class="c-tool-state">${icon('loader-circle', 'icon is-spin')}${icon('check', 'icon is-done')}</span>${escapeHtml(c.planTool)}</div>
                <div class="c-msg is-agent" data-at="6800"><p>${escapeHtml(c.a2)}</p></div>
                <div class="c-approval is-approved" data-at="7500" data-cursor-at="8700" data-approve-at="9600">
                  <div class="c-approval-head"><span class="pip"></span><span class="c-approval-title-wait">${escapeHtml(c.approval.title)}</span><span class="c-approval-title-done">${escapeHtml(c.approval.approved)}</span></div>
                  <div class="c-route">
                    <span class="c-route-title">${pmark('codex')}${escapeHtml(c.approval.route)}</span>
                    <span class="c-route-row is-up"><b>1</b>team-3${icon('arrow-up')}</span>
                    <span class="c-route-row"><b>2</b>team-2${icon('arrow-down')}</span>
                  </div>
                  <div class="c-approval-actions"><span class="c-btn is-primary" data-approve-btn>${escapeHtml(c.approval.approve)}</span><span class="c-btn">${escapeHtml(c.approval.diff)}</span></div>
                </div>
                <div class="c-msg is-agent" data-at="10100"><p>${c.a3}</p></div>
              </div>
              <div class="c-composer">
                <span class="c-input" data-composer data-placeholder="${escapeHtml(c.placeholder)}">${escapeHtml(c.placeholder)}</span>
                <span class="c-composer-row">${icon('plus')}<span class="c-chip">${icon('plug')}${escapeHtml(c.mode)}</span><span class="c-model" data-model-pill>${pmark('claude')}<span data-model-name>Claude Opus 5.5</span></span><span class="c-send">${icon('arrow-up')}</span></span>
              </div>
              <div class="c-cursor" data-cursor>${MACOS_CURSOR}</div>
            </div>
          </div>
        </div>
        <figcaption class="sr-only">${escapeHtml(c.caption)}</figcaption>
      </figure>`;
}

/* ------------------------------------------------------------------ routing map */

const MAP = { width: 1000, height: 420, gateway: { x: 500, y: 206 }, clientX: 262, credentialX: 738 };

function routingMap(text) {
  const m = text.map;
  const clientYs = [104, 172, 240, 308];
  const credentialYs = [74, 140, 206, 272, 338];
  const g = MAP.gateway;
  const lanes = [];
  const clients = m.clients
    .map(([id, label, count, targets], index) => {
      const y = clientYs[index];
      lanes.push(`<path class="lane" data-lane="c${index}" d="M${MAP.clientX + 24} ${y} C ${MAP.clientX + 120} ${y}, ${g.x - 140} ${g.y}, ${g.x - 42} ${g.y}"/>`);
      return `<g class="node is-client" data-node="c${index}" data-targets="${targets}" transform="translate(${MAP.clientX} ${y})">
            <rect class="tile" x="-22" y="-22" width="44" height="44" rx="10"/>
            <g transform="translate(-11 -11)"><svg width="22" height="22" class="node-mark" fill="currentColor"><use href="#pm-${id}"/></svg></g>
            <text class="node-label is-mono" x="-36" y="-2" text-anchor="end">${escapeHtml(label)}</text>
            <text class="node-sub" x="-36" y="15" text-anchor="end">${escapeHtml(count)} ${escapeHtml(m.reqUnit)}</text>
          </g>`;
    })
    .join('');
  const credentials = m.credentials
    .map(([id, name, detail], index) => {
      const y = credentialYs[index];
      lanes.push(`<path class="lane" data-lane="k${index}" d="M${g.x + 42} ${g.y} C ${g.x + 140} ${g.y}, ${MAP.credentialX - 120} ${y}, ${MAP.credentialX - 24} ${y}"/>`);
      return `<g class="node is-credential" data-node="k${index}" transform="translate(${MAP.credentialX} ${y})">
            <rect class="tile" x="-22" y="-22" width="44" height="44" rx="10"/>
            <g transform="translate(-11 -11)"><svg width="22" height="22" class="node-mark" fill="currentColor"><use href="#pm-${id}"/></svg></g>
            <text class="node-label" x="36" y="-2">${escapeHtml(name)}</text>
            <text class="node-sub is-mono" x="36" y="15">${escapeHtml(detail)}</text>
            <circle class="node-alert" cx="30" cy="-18" r="3"/>
          </g>`;
    })
    .join('');
  const { viewBox: markBox } = brandDrawing('mark');
  const markBody = brandMarkup('mark', { ink: '__ink__', accent: '__accent__' })
    .replace(/ id="[^"]*"/g, '')
    .replace(/fill="__ink__"/g, 'class="b-ink"')
    .replace(/fill="__accent__"/g, 'class="b-accent"');
  return `<div class="map-card" data-map>
          <svg class="map" viewBox="0 0 ${MAP.width} ${MAP.height}" role="img" aria-label="${escapeHtml(m.caption)}">
            <text class="map-col-head" x="${MAP.clientX + 22}" y="30" text-anchor="end">${escapeHtml(m.modelsHead)}</text>
            <text class="map-col-head" x="${MAP.credentialX - 22}" y="30" text-anchor="start">${escapeHtml(m.credentialsHead)}</text>
            <g class="lanes">${lanes.join('')}</g>
            <g class="pulses" data-pulses></g>
            <g class="node is-gateway" transform="translate(${g.x} ${g.y})">
              <circle class="orbit" r="72"/>
              <circle class="orbit is-far" r="104"/>
              <circle class="gateway-glow" r="58"/>
              <rect class="tile is-gateway-tile" x="-42" y="-42" width="84" height="84" rx="12"/>
              <rect class="gateway-ring" x="-42" y="-42" width="84" height="84" rx="12" data-gateway-ring/>
              <svg class="gateway-mark" x="-17" y="-17" width="34" height="34" viewBox="${markBox}" aria-hidden="true">${markBody}</svg>
              <text class="node-label" y="70" text-anchor="middle">${escapeHtml(m.gateway)}</text>
            </g>
            <g class="clients">${clients}</g>
            <g class="credentials">${credentials}</g>
          </svg>
          <dl class="map-stats">
            <div><dt>${escapeHtml(m.stats[0])}</dt><dd data-stat="requests">1,284</dd></div>
            <div><dt>${escapeHtml(m.stats[1])}</dt><dd data-stat="success">99.2%</dd></div>
            <div><dt>${escapeHtml(m.stats[2])}</dt><dd data-stat="cost">$18.42</dd></div>
          </dl>
        </div>`;
}

/**
 * The hero mark, filled in the brand's own colours. Two quiet touches give it some material
 * without changing the logo: each shape shades a few percent darker towards its foot, and a
 * fine light line runs along its upper edges (a stroke clipped to the shape, so only its
 * inner half shows). Everything is vector, with no filters, so it stays sharp. The outlines
 * trace themselves in, then each shape pours full from the bottom up.
 */
function outlineMark() {
  const { viewBox } = brandDrawing('mark');
  const shapes = brandMarkup('mark', { ink: '__ink__', accent: '__accent__' }).replace(/ id="[^"]*"/g, '');
  const ring = shapes.match(/<path fill="__ink__"[^>]*\/>/)[0];
  const reading = shapes.match(/<path fill="__accent__"[^>]*\/>/)[0];
  const as = (path, attributes) => path.replace(/fill="__(ink|accent)__"/, attributes);
  const shade = (id, name) =>
    `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="hm-${name}-top"/><stop offset="1" class="hm-${name}-foot"/></linearGradient>`;
  return `<svg class="hero-mark" viewBox="${viewBox}" aria-hidden="true">
            <defs>
              ${shade('hm-ink', 'ink')}
              ${shade('hm-accent', 'accent')}
              <linearGradient id="hm-edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="hm-edge-top"/><stop offset="0.3" class="hm-edge-foot"/></linearGradient>
              <clipPath id="hm-ring">${as(ring, '')}</clipPath>
              <clipPath id="hm-reading">${as(reading, '')}</clipPath>
            </defs>
            <g class="m-fill is-ring">${as(ring, 'fill="url(#hm-ink)"')}${as(ring, 'class="m-edge" clip-path="url(#hm-ring)" fill="none" stroke="url(#hm-edge)"')}</g>
            <g class="m-fill is-reading">${as(reading, 'fill="url(#hm-accent)"')}${as(reading, 'class="m-edge" clip-path="url(#hm-reading)" fill="none" stroke="url(#hm-edge)"')}</g>
            ${as(ring, 'class="m-line is-ring" pathLength="1"')}
            ${as(reading, 'class="m-line is-reading" pathLength="1"')}
          </svg>`;
}

const WORDMARK_ORDER = {
  'letter-O': 0,
  'letter-h': 1,
  'hyphen-1': 2,
  'letter-M': 3,
  'letter-y': 4,
  'hyphen-2': 5,
  'letter-C': 6,
  'letter-P': 7,
  'letter-A': 8,
};

/**
 * The hero wordmark: each glyph keeps its natural fill and enters in a tight typographic
 * cascade alongside the mark, without tracing or paint-filling.
 */
function heroWordmark() {
  const { viewBox } = brandDrawing('wordmark');
  const raw = brandMarkup('wordmark', { ink: '__ink__', accent: '__accent__' });
  const body = raw
    .replace(/fill="__ink__"/g, 'class="b-ink"')
    .replace(/fill="__accent__"/g, 'class="b-accent"')
    .replace(/<path id="([^"]+)" /g, (_, id) => `<path class="w-glyph" style="--i: ${WORDMARK_ORDER[id] ?? 0}" `)
    .replace(/ id="[^"]*"/g, '');
  return `<svg class="hero-wordmark" viewBox="${viewBox}" aria-hidden="true">${body}</svg>`;
}

/** The closing mark: the logo's outlines alone, traced in once the section comes into view. */
function closingMark() {
  const { viewBox } = brandDrawing('mark');
  const shapes = brandMarkup('mark', { ink: '__ink__', accent: '__accent__' }).replace(/ id="[^"]*"/g, '');
  const lines = shapes.match(/<path [^>]*\/>/g).map((path) =>
    path.replace(/fill="__(ink|accent)__"/, (_, role) => `class="c-line is-${role}" pathLength="1"`),
  );
  return `<svg class="closing-mark" viewBox="${viewBox}" aria-hidden="true">${lines.join('')}</svg>`;
}

/* ------------------------------------------------------------------ feature cards */

function requestRows() {
  return REQUEST_ROWS.slice(0, 6)
    .map(
      ([provider, model, account, tokens, cost, status], index) =>
        `<li class="r-row${status === 'fail' ? ' is-fail' : ''}"><span class="r-time">09:4${7 - Math.floor(index / 2)}:${String(52 - index * 7).padStart(2, '0')}</span><span class="r-model">${pmark(provider)}${model}</span><span class="r-account">${account}</span><span class="r-num">${tokens}</span><span class="r-num">${cost}</span><span class="r-pip"></span></li>`,
    )
    .join('');
}

function featureCards(text) {
  const f = text.features;
  const c = f.cards;
  const pool = JSON.stringify(REQUEST_ROWS).replace(/"/g, '&quot;');
  const costBar = COST_MODELS.map(([, , , share], index) => `<i style="--share: ${share}; --i: ${index}"></i>`).join('') + '<i class="is-rest" style="--share: 8; --i: 5"></i>';
  const costRows = COST_MODELS.slice(0, 4)
    .map(([provider, model, cost, share], index) => `<li style="--i: ${index}"><span class="swatch s${index + 1}"></span>${pmark(provider)}<span class="m-name">${model}</span><span class="m-cost">$${cost.toFixed(2)}</span><span class="m-share">${share}%</span></li>`)
    .join('');
  const oauthRows = OAUTH_ROWS.map(
    ([provider, name, windows, state], index) => `<li class="o-row${state === 'warm' ? ' is-warm' : ''}" style="--i: ${index}">
              <span class="o-id">${pmark(provider)}<b>${name}</b></span>
              ${windows
                .map((value, w) => `<span class="o-track"><span class="o-window">${escapeHtml(f.windows[w])}</span><span class="c-bar${value < 15 ? ' is-low' : ''}" style="--fill: ${value}%"><i></i></span><span class="o-value">${value}%</span></span>`)
                .join('')}
              ${state === 'warm' ? `<span class="o-state"><span class="o-warming">${icon('loader-circle', 'icon is-spin')}${escapeHtml(f.warming)}</span><span class="o-ready">${icon('check', 'icon')}${escapeHtml(f.ready)}</span></span>` : ''}
            </li>`,
  ).join('');
  const receipt = f.receipt;
  const receiptSummary = receipt.summary
    .map(([label, value, tone], index) => `<div class="rc-row${tone ? ` is-${tone}` : ''}" style="--i: ${index + 2}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
  const receiptLines = RECEIPT_LINES.map(
    ([provider, model, qty, amount], index) =>
      `<div class="rc-line" style="--i: ${index + 5}"><span class="rc-line-name">${pmark(provider)}<span>${escapeHtml(model)}</span></span><span>${escapeHtml(qty)}</span><span>${escapeHtml(amount)}</span></div>`,
  ).join('');
  return `<div class="feature-grid">
          <article class="feature" data-reveal>
            <h3>${escapeHtml(c.requests.title)}</h3>
            <p>${escapeHtml(c.requests.body)}</p>
            <div class="mini mini-requests" aria-hidden="true">
              <div class="r-head"><span>${escapeHtml(f.columns.time)}</span><span>${escapeHtml(f.columns.model)}</span><span>${escapeHtml(f.columns.account)}</span><span class="r-num">${escapeHtml(f.columns.tokens)}</span><span class="r-num">${escapeHtml(f.columns.cost)}</span><span></span></div>
              <ul class="r-list" data-requests="${pool}">${requestRows()}</ul>
            </div>
          </article>
          <article class="feature" data-reveal>
            <h3>${escapeHtml(c.cost.title)}</h3>
            <p>${escapeHtml(c.cost.body)}</p>
            <div class="mini mini-cost" aria-hidden="true">
              <div class="cost-total"><span class="cost-label">${escapeHtml(f.costTotal)}</span><span class="cost-value" data-count="168.04" data-prefix="$">$168.04</span></div>
              <div class="cost-bar">${costBar}</div>
              <ul class="cost-rows">${costRows}</ul>
            </div>
          </article>
          <article class="feature" data-reveal>
            <h3>${escapeHtml(c.oauth.title)}</h3>
            <p>${escapeHtml(c.oauth.body)}</p>
            <div class="mini mini-oauth" aria-hidden="true"><ul>${oauthRows}</ul></div>
          </article>
          <article class="feature" data-reveal>
            <h3>${escapeHtml(c.receipt.title)}</h3>
            <p>${escapeHtml(c.receipt.body)}</p>
            <div class="mini mini-receipt" aria-hidden="true">
              <div class="rc-paper">
                <div class="rc-head" style="--i: 0">${brand('wordmark', 'rc-logo')}<div class="rc-title">${escapeHtml(receipt.title)}</div><div class="rc-tag">${escapeHtml(receipt.tagline)}</div></div>
                <hr class="rc-rule">
                <div class="rc-total" style="--i: 1"><span class="rc-total-label">${escapeHtml(receipt.totalLabel)}</span><span class="rc-total-val" data-count="18.42" data-prefix="$">${escapeHtml(receipt.total)}</span></div>
                <hr class="rc-rule">
                <dl class="rc-rows">${receiptSummary}</dl>
                <hr class="rc-rule">
                <div class="rc-items">
                  <div class="rc-line rc-items-head">${receipt.itemsHead.map((cell) => `<span>${escapeHtml(cell)}</span>`).join('')}</div>
                  ${receiptLines}
                </div>
              </div>
            </div>
          </article>
        </div>`;
}

/* ------------------------------------------------------------------ install */

const SHELL_TOKEN_RE =
  /(<<'EOF'|&&|>>|>|\$\(|\)|\bEOF\b)|(https?:\/\/[^\s'"]+)|('[^']*')|(\b(?:CPA_MANAGEMENT_KEY|OMCPA_[A-Z0-9_]+)\b)|(\b(?:mkdir|cd|curl|printf|cat|chmod|docker|openssl)\b)|((?:^|\s)(?:-[a-zA-Z0-9-]+))|(\b(?:compose\.yml|config\.yaml|oh-my-cpa)\b|\.env)|(\b\d+\b)/g;

function span(cls, text) {
  return cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
}

function highlightShell(command) {
  let out = '';
  let last = 0;
  for (const m of command.matchAll(SHELL_TOKEN_RE)) {
    if (m.index > last) out += escapeHtml(command.slice(last, m.index));
    const [full, op, url, str, envVar, cmd, flag, filePath, num] = m;
    if (op) out += span('tok-op', op);
    else if (url) out += span('tok-url', url);
    else if (str) {
      for (const part of str.split(/(CPA_MANAGEMENT_KEY|OMCPA_[A-Z0-9_]+)/)) {
        if (!part) continue;
        out += /^(?:CPA_MANAGEMENT_KEY|OMCPA_[A-Z0-9_]+)$/.test(part) ? span('tok-var', part) : span('tok-str', part);
      }
    } else if (envVar) out += span('tok-var', envVar);
    else if (cmd) out += span('tok-cmd', cmd);
    else if (flag) {
      const lead = flag.match(/^\s*/)[0];
      out += escapeHtml(lead) + span('tok-flag', flag.slice(lead.length));
    } else if (filePath) out += span('tok-path', filePath);
    else if (num) out += span('tok-num', num);
    else out += escapeHtml(full);
    last = m.index + full.length;
  }
  if (last < command.length) out += escapeHtml(command.slice(last));
  return out;
}

function highlightProseLine(html) {
  return html
    .replace(/https?:\/\/[^\s<]+/g, (url) => span('tok-url', url))
    .replace(/\bdocker compose up -d\b/g, `${span('tok-cmd', 'docker')} compose up ${span('tok-flag', '-d')}`)
    .replace(/(~\/oh-my-cpa|\bcompose\.yml\b|\bconfig\.yaml\b|\.env)/g, (p) => span('tok-path', p))
    .replace(/(?<!:)\b(8080|8317)\b/g, (n) => span('tok-num', n));
}

function terminalScreen(tab, text, index) {
  const t = text.install;
  let lines;
  let copyText;
  if (tab.id === 'agent') {
    copyText = t.agentPrompt;
    lines = [
      `<p class="t-line is-prompt" data-type><span class="t-sigil">&gt;</span><span class="t-text">${highlightProseLine(escapeHtml(t.agentPrompt))}</span></p>`,
      ...t.agentSteps.map(
        ([kind, line]) =>
          `<p class="t-line is-${kind}" data-out><span class="t-sigil">${kind === 'ask' ? '?' : kind === 'done' ? '✓' : '●'}</span><span class="t-text">${highlightProseLine(line)}</span></p>`,
      ),
    ];
  } else {
    const commands = tab.id === 'compose' ? COMPOSE_COMMANDS : standaloneCommands(t.keyPlaceholder);
    const containers = tab.id === 'compose' ? ['cli-proxy-api', 'oh-my-cpa', 'oh-my-cpa-updater'] : ['oh-my-cpa', 'oh-my-cpa-updater'];
    copyText = commands.join('\n');
    lines = [
      ...commands.map((command) => `<p class="t-line" data-type><span class="t-sigil">$</span><span class="t-text">${highlightShell(command)}</span></p>`),
      ...containers.map(
        (name) => `<p class="t-line is-out" data-out><span class="t-sigil">✔</span><span class="t-text"><span class="tok-muted">Container</span> <span class="tok-path">${escapeHtml(name.padEnd(18, ' '))}</span> <span class="t-ok">Started</span></span></p>`,
      ),
      `<p class="t-line is-done" data-out><span class="t-sigil">✓</span><span class="t-text">${highlightProseLine(escapeHtml(t.ready))}</span></p>`,
    ];
  }
  const id = `code-${tab.id}`;
  return `<div class="t-screen" id="term-${tab.id}"${index === 0 ? '' : ' hidden'} data-screen>
              <span class="copy" data-copied="${escapeHtml(t.copied)}" data-failed="${escapeHtml(t.copyFailed)}">
                <button class="tool copy-button" type="button" command="--copy" commandfor="${id}" aria-label="${escapeHtml(`${t.copy} ${tab.label}`)}" title="${escapeHtml(t.copy)}">${icon('copy', 'icon icon-copy')}${icon('check', 'icon icon-check')}</button>
                <span class="copy-tip" role="status"></span>
              </span>
              <pre class="sr-only" id="${id}">${escapeHtml(copyText)}</pre>
              <div class="t-lines" aria-hidden="true">${lines.join('')}</div>
            </div>`;
}

function installSection(text, docs) {
  const t = text.install;
  const tabs = t.tabs
    .map(
      (tab, index) =>
        `<button class="chip" type="button" role="tab" id="tab-${tab.id}" aria-controls="panel-${tab.id} term-${tab.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(tab.label)}</button>`,
    )
    .join('');
  const panels = t.tabs
    .map(
      (tab, index) => `<div class="install-panel" role="tabpanel" id="panel-${tab.id}" aria-labelledby="tab-${tab.id}"${index === 0 ? '' : ' hidden="until-found"'}>
              <p><strong>${escapeHtml(tab.lead)}</strong> ${tab.body}</p>
              <a class="text-link" href="${docs(tab.link.href)}">${escapeHtml(tab.link.text)}${icon('arrow-right')}</a>
            </div>`,
    )
    .join('');
  return `<section class="section install" id="install" aria-labelledby="install-title">
        <div class="wrap install-grid">
          <div class="install-side">
            <h2 id="install-title" class="reveal">${escapeHtml(t.title)}</h2>
            <div class="chips" role="tablist" aria-label="${escapeHtml(t.title)}">${tabs}</div>
            <div class="install-panels">${panels}</div>
          </div>
          <div class="window terminal" data-terminal>
            <div class="window-bar"><span class="lights"><i></i><i></i><i></i></span><span class="window-title">${icon('square-terminal')}${escapeHtml(t.terminal)}</span></div>
            ${t.tabs.map((tab, index) => terminalScreen(tab, text, index)).join('')}
          </div>
        </div>
      </section>`;
}

/* ------------------------------------------------------------------ document */

function jsonLd(text, page, version) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Oh My CPA',
    alternateName: 'OMC',
    description: text.description,
    url: `${SITE_ORIGIN}${page.path}`,
    inLanguage: text.htmlLang,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows, FreeBSD',
    softwareVersion: version,
    license: 'https://opensource.org/licenses/MIT',
    downloadUrl: `${GITHUB_URL}/releases/latest`,
    codeRepository: GITHUB_URL,
    image: `${SITE_ORIGIN}/og/home-${page.lang}.png`,
    screenshot: `${SITE_ORIGIN}/images/hero-split.${page.lang}.webp`,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** Renders one complete landing document. `version` is the release the page describes. */
export function renderLanding(lang, { version = '' } = {}) {
  const text = COPY[lang];
  const page = LANDING_PAGES.find((entry) => entry.lang === lang);
  if (!text || !page) throw new Error(`unknown landing language ${lang}`);
  const other = LANDING_PAGES.find((entry) => entry.lang !== lang);
  const docs = (target) => `${text.docs}${target}/`;
  const canonical = `${SITE_ORIGIN}${page.path}`;
  const ogImage = `${SITE_ORIGIN}/og/home-${lang}.png`;
  const alternates = LANDING_PAGES.map((entry) => `<link rel="alternate" hreflang="${entry.hreflang}" href="${SITE_ORIGIN}${entry.path}">`).join('\n    ');

  const providers = text.beside.providers
    .map(([id, label], index) => `<li style="--i: ${index}"><span class="p-tile">${pmark(id)}</span><span class="p-name">${escapeHtml(label)}</span></li>`)
    .join('');
  const faq = text.faq
    .map(([q, a], index) => `<details class="qa"${index === 0 ? ' open' : ''}><summary>${icon('plus', 'icon qa-icon')}${escapeHtml(q)}</summary><div class="qa-body"><p>${a}</p></div></details>`)
    .join('');
  const f = text.footer;

  return `<!doctype html>
<html lang="${text.htmlLang}" data-lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <script>
      document.documentElement.classList.add('js');
      try {
        var scheme = localStorage.getItem('omc-site-theme');
        if (scheme === 'light' || scheme === 'dark') {
          document.querySelector('meta[name="color-scheme"]').content = scheme;
          document.documentElement.dataset.theme = scheme;
        }
        if (location.pathname === '/') {
          var lang = localStorage.getItem('omc-docs-locale');
          if (lang === 'zh' || (!lang && /^zh\\b/i.test(navigator.language || ''))) location.replace('/zh/' + location.search + location.hash);
        }
        if (sessionStorage.getItem('omc-site-star-dismissed') === '1') document.documentElement.classList.add('is-star-dismissed');
      } catch (error) {}
    </script>
    <title>${escapeHtml(text.title)}</title>
    <meta name="description" content="${escapeHtml(text.description)}">
    <link rel="canonical" href="${canonical}">
    ${alternates}
    <link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/">
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f7f8">
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0c0c0d">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Oh My CPA">
    <meta property="og:title" content="${escapeHtml(text.title)}">
    <meta property="og:description" content="${escapeHtml(text.description)}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:locale" content="${lang === 'zh' ? 'zh_CN' : 'en_US'}">
    <meta property="og:locale:alternate" content="${lang === 'zh' ? 'en_US' : 'zh_CN'}">
    <meta property="og:image" content="${ogImage}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeHtml(text.ogAlt)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(text.title)}">
    <meta name="twitter:description" content="${escapeHtml(text.description)}">
    <meta name="twitter:image" content="${ogImage}">
    <meta name="twitter:image:alt" content="${escapeHtml(text.ogAlt)}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400..600&display=swap">
    <link rel="stylesheet" href="/site.css">
    <script type="application/ld+json">${jsonLd(text, page, version)}</script>
  </head>
  <body>
    ${SPRITE}
    <a class="skip" href="#main">${escapeHtml(text.skip)}</a>
    <div class="star-banner" data-star-banner>
      <div class="wrap star-banner-inner">
        <a class="star-banner-link" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">
          ${icon('star', 'icon star-icon')}
          <span class="star-banner-text">${escapeHtml(text.starBanner.text)}</span>
          <span class="star-banner-cta">${escapeHtml(text.starBanner.cta)}${icon('arrow-right')}</span>
        </a>
        <button class="star-banner-close" type="button" data-dismiss-star aria-label="${escapeHtml(text.starBanner.close)}" title="${escapeHtml(text.starBanner.close)}">${icon('x')}</button>
      </div>
    </div>
    <header class="topbar">
      <nav class="topbar-inner" aria-label="Oh My CPA">
        <a class="brand" href="${page.path}" aria-label="${escapeHtml(text.nav.home)}">${brand('wordmark', 'wordmark')}</a>
        <div class="nav-links">
          <a href="${text.docs}/">${escapeHtml(text.nav.docs)}</a>
          <a class="nav-api" href="/api-reference/">${escapeHtml(text.nav.api)}</a>
          <a href="/demo/">${escapeHtml(text.nav.demo)}</a>
        </div>
        <div class="nav-tools">
          <a class="tool" href="${GITHUB_URL}" aria-label="${escapeHtml(text.nav.github)}" title="${escapeHtml(text.nav.github)}">${GITHUB_MARK}</a>
          <a class="tool" href="${other.path}" hreflang="${other.hreflang}" lang="${other.hreflang}" data-set-lang="${other.lang}" aria-label="${escapeHtml(text.nav.language)}" title="${escapeHtml(text.nav.language)}">${icon('languages')}</a>
          <button class="tool" type="button" data-theme-toggle title="${escapeHtml(text.nav.theme)}">${icon('sun', 'icon icon-sun')}${icon('moon', 'icon icon-moon')}<span class="sr-only if-light">${escapeHtml(text.nav.toDark)}</span><span class="sr-only if-dark">${escapeHtml(text.nav.toLight)}</span></button>
          <a class="button is-small is-primary nav-start" href="${docs('/start/quickstart')}">${escapeHtml(text.nav.start)}</a>
        </div>
      </nav>
    </header>

    <main id="main">
      <section class="hero">
        <div class="wrap hero-copy">
          ${version ? `<a class="release" href="${GITHUB_URL}/releases/tag/v${escapeHtml(version)}">${text.release(escapeHtml(version))}${icon('arrow-up-right')}</a>` : ''}
          <div class="hero-art">${outlineMark()}</div>
          <h1 class="hero-title"><span class="sr-only">Oh My CPA</span>${heroWordmark()}</h1>
          <p class="lead">${escapeHtml(text.hero.lead)}</p>
          <div class="actions">
            <a class="button is-primary" href="${docs('/start/quickstart')}">${escapeHtml(text.hero.primary)}</a>
            <a class="button" href="/demo/">${escapeHtml(text.hero.secondary)}</a>
            <a class="button" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">${GITHUB_MARK}<span>${escapeHtml(text.hero.github)}</span></a>
          </div>
        </div>
        <div class="wrap hero-stage">${consoleWindow(text)}</div>
      </section>

      <section class="section" aria-labelledby="beside-title">
        <div class="wrap statement">
          <h2 id="beside-title" class="reveal">${escapeHtml(text.beside.title)}</h2>
          <div class="statement-body reveal">${text.beside.body.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div>
        </div>
        <div class="wrap"><ul class="providers" aria-label="${lang === 'zh' ? '支持的提供商' : 'Supported providers'}">${providers}</ul></div>
      </section>

      <section class="section is-showcase" aria-labelledby="map-title">
        <div class="wrap">
          <header class="section-head reveal">
            <h2 id="map-title">${escapeHtml(text.map.title)}</h2>
          </header>
          ${routingMap(text)}
        </div>
      </section>

      <section class="section" aria-labelledby="features-title">
        <div class="wrap">
          <header class="section-head reveal"><h2 id="features-title">${escapeHtml(text.features.title)}</h2></header>
          ${featureCards(text)}
        </div>
      </section>

      ${installSection(text, docs)}

      <section class="section" aria-labelledby="faq-title">
        <div class="wrap faq-grid">
          <h2 id="faq-title" class="reveal">${escapeHtml(text.faqTitle)}</h2>
          <div class="faq">${faq}</div>
        </div>
      </section>

      <section class="section closing" aria-labelledby="cta-title">
        <div class="wrap closing-copy">
          <h2 id="cta-title" class="reveal">${escapeHtml(text.cta.title)}</h2>
          <p class="reveal">${escapeHtml(text.cta.lead)}</p>
          <div class="actions">
            <a class="button is-primary" href="/demo/">${escapeHtml(text.hero.secondary)}</a>
            <a class="button" href="${docs('/start/quickstart')}">${escapeHtml(text.hero.primary)}</a>
          </div>
        </div>
        ${closingMark()}
      </section>
    </main>

    <footer class="footer">
      <div class="wrap footer-inner">
        <div class="footer-brand">
          ${brand('wordmark', 'wordmark')}
          <div class="footer-meta">
            <span>${escapeHtml(f.license)}</span>
            ${version ? `<span>v${escapeHtml(version)}</span>` : ''}
          </div>
        </div>
        <nav class="footer-links" aria-label="${escapeHtml(f.navLabel)}">
          <a href="${text.docs}/">${escapeHtml(f.docs)}</a>
          <a href="/api-reference/">${escapeHtml(f.api)}</a>
          <a href="/demo/">${escapeHtml(f.demo)}</a>
          <a href="${GITHUB_URL}/releases" target="_blank" rel="noopener noreferrer">${escapeHtml(f.releases)}</a>
          <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(f.github)}</a>
          <a href="${GITHUB_URL}/issues" target="_blank" rel="noopener noreferrer">${escapeHtml(f.issues)}</a>
          <a href="${CPA_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(f.cpa)}</a>
        </nav>
      </div>
    </footer>
    <script src="/site.js" defer></script>
  </body>
</html>
`;
}
