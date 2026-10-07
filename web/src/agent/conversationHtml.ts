import { SNAPSHOT_CSS } from './conversationStyles';
import { SNAPSHOT_SCRIPT } from './conversationControls';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { brandDrawing, brandMarkup } from '../assets/brand/markup';
import { lucideMarkup, lucideNodes, parseIconReference } from './agentIcons';
import type { LucideIconData } from './agentIcons';
import { CANVAS_SANDBOX, CANVAS_TOKENS, canvasDocument } from './canvasDocument';
import type { DisplayView, ViewBlock } from './types';
import type { ConversationSnapshot, SnapshotTurn } from './conversationSnapshot';
import { chartSeries } from '../pages/agent/state';

export interface SnapshotLabels {
  title: string; operator: string; answer: string; model: string; exportedAt: string;
  thought: string; parameters: string; arguments: string; result: string; data: string;
  copy: string; copied: string; copyFailed: string; search: string; expand: string; collapse: string;
  print: string; imageOmitted: string; privacy: string; panel: string; close: string; chart: string; usage: string;
  noMatches: string; canvasOmitted: string;
  step: (status: string) => string;
  calls: (count: number) => string;
  turns: (count: number) => string;
  tokens: (count: number) => string;
  omitted: (count: number) => string;
  status: (status: string) => string;
  capability: (name: string) => string;
  failure: (code: string) => string;
  date: (milliseconds: number) => string;
  /** A time-bucketed chart's category, short enough to sit under a tick. */
  axisTime: (milliseconds: number) => string;
  duration: (milliseconds: number) => string;
  number: (value: number) => string;
}
/** `icons` is the Lucide set, passed when a panel names an icon; without it panels are drawn unadorned. */
export interface SnapshotAppearance { variables: Record<string, string>; fontCSS?: string; icons?: LucideIconData; isDark?: boolean }
export interface SnapshotDocumentOptions {
  snapshot: ConversationSnapshot; labels: SnapshotLabels; appearance: SnapshotAppearance; exportedAt: Date; language: string;
}
const element = React.createElement;
export function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

type IconName = 'search' | 'panel' | 'print' | 'close' | 'copy' | 'caret' | 'image';
const ICON_PATHS: Record<IconName, string> = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/>',
  print: '<path d="M7 8V3h10v5M7 17H3V8h18v9h-4M7 13h10v8H7z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  caret: '<path d="m9 5 7 7-7 7"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="m3 16 5-5 5 5 3-3 5 5"/><circle cx="15.5" cy="9" r="1.5"/>',
};
function icon(name: IconName, size = 16): string {
  return `<svg${name === 'caret' ? ' class="caret"' : ''} xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}
function copyButton(labels: SnapshotLabels): string {
  return `<button type="button" class="text-button" data-copy>${icon('copy', 13)}<span data-copy-label>${escapeHTML(labels.copy)}</span></button>`;
}
function codeFrame(language: string, body: string, labels: SnapshotLabels): string {
  return `<div class="code-frame"${language ? ` data-lang="${escapeHTML(language)}"` : ''}><div class="code-head"><span class="code-lang">${escapeHTML(language)}</span>${copyButton(labels)}</div>${body}</div>`;
}

/** External images stay explicit navigation; model-authored HTML never becomes markup. */
function markdown(content: string, labels: SnapshotLabels): string {
  return renderToStaticMarkup(element(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: {
      pre: ({ children }) => {
        const className = React.isValidElement<{ className?: string }>(children) ? children.props.className ?? '' : '';
        const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? '';
        return element('div', { className: 'code-frame', 'data-lang': language || undefined },
          element('div', { className: 'code-head', dangerouslySetInnerHTML: { __html: `<span class="code-lang">${escapeHTML(language)}</span>${copyButton(labels)}` } }),
          element('pre', null, children));
      },
      table: ({ children }) => element('div', { className: 'table-scroll' }, element('table', null, children)),
      img: ({ src, alt }) => element('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, alt || src),
      a: ({ href, children }) => element('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children),
    }, children: content,
  }));
}
function codeBlock(text: string, labels: SnapshotLabels, language = ''): string {
  return codeFrame(language, `<pre><code>${escapeHTML(text)}</code></pre>`, labels);
}
function disclosure(title: string, body: string, className: string): string {
  return `<details class="fold ${className}"><summary>${icon('caret', 10)}<span>${escapeHTML(title)}</span></summary><div class="fold-body">${body}</div></details>`;
}
function dataTable(view: DisplayView): string {
  return `<div class="table-scroll"><table><caption>${escapeHTML(view.title)}</caption><thead><tr>${view.columns.map((column, index) =>
    `<th scope="col"><button type="button" data-sort="${index}">${escapeHTML(column)}</button></th>`).join('')}</tr></thead><tbody>${view.rows.map(row =>
    `<tr>${view.columns.map(column => `<td>${escapeHTML(String(row[column] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const SERIES_COUNT = 6;
const seriesColor = (index: number) => `var(--series-${index % SERIES_COUNT + 1}, var(--accent))`;
const round = (value: number) => Math.round(value * 100) / 100;
function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** Round tick values that bracket the data and always include zero, so bars grow from a real baseline. */
export function chartTicks(minValue: number, maxValue: number): number[] {
  const low = Math.min(0, minValue);
  const high = Math.max(0, maxValue);
  const rough = (high - low || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].find(factor => factor * magnitude >= rough)! * magnitude;
  const ticks: number[] = [];
  for (let index = Math.floor(low / step); index <= Math.ceil(high / step); index++) ticks.push(Number((index * step).toPrecision(12)));
  return ticks;
}

/** Portable vector marks use the same frozen series as ChartView; the full data remains beside them. */
function chartMarkup(view: DisplayView, labels: SnapshotLabels): string {
  const { points, isTime } = chartSeries(view);
  if (!points.length || !view.chart) return '';
  const type = view.chart.type;
  const seriesNames = [...new Set(points.map(point => point.series))];
  const categories = [...new Set(points.map(point => point.x))];
  const category = (x: string) => isTime ? labels.axisTime(Number(x)) : x;
  const tip = (point: { x: string; series: string; value: number }) =>
    `<title>${escapeHTML([category(point.x), point.series].filter(Boolean).join(' · '))}: ${escapeHTML(labels.number(point.value))}</title>`;
  const open = (width: number, height: number) => `<svg class="chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${round(height)}" role="img" aria-label="${escapeHTML(view.title)}">`;
  const legend = (items: string[]) => `<div class="legend">${items.join('')}</div>`;
  const swatch = (index: number) => `<i style="background:${seriesColor(index)}"></i>`;

  if (type === 'pie') {
    const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
    let accumulated = 0;
    const slices = total <= 0 ? '' : points.map((point, index) => {
      const fraction = Math.max(0, point.value) / total;
      // A hairline of page shows between slices: the gap is taken from each slice's own arc.
      const arc = Math.max(0, fraction - (points.length > 1 ? 0.004 : 0));
      const slice = `<circle cx="90" cy="90" r="64" fill="none" stroke="${seriesColor(index)}" stroke-width="32" pathLength="1" stroke-dasharray="${round(arc * 1e4) / 1e4} 1" stroke-dashoffset="${-round(accumulated * 1e4) / 1e4}" transform="rotate(-90 90 90)">${tip(point)}</circle>`;
      accumulated += fraction;
      return slice;
    }).join('');
    const rows = points.map((point, index) => `<span>${swatch(index)}<b>${escapeHTML([point.x, point.series].filter(Boolean).join(' · '))}</b><em>${escapeHTML(labels.number(point.value))}</em><small>${total > 0 ? `${round(Math.max(0, point.value) / total * 100).toFixed(1)}%` : ''}</small></span>`);
    return `<div class="chart-pie">${open(180, 180)}<circle cx="90" cy="90" r="64" fill="none" stroke="var(--border)" stroke-width="32"/>${slices}</svg>${legend(rows)}</div>`;
  }

  // A stacked mark starts where the series before it at the same category ended.
  const isStacked = !!view.chart.stacked && type !== 'line' && seriesNames.length > 1;
  const floors = new Map<object, number>();
  if (isStacked) {
    const totals = new Map<string, number>();
    for (const name of seriesNames) for (const point of points) {
      if (point.series !== name) continue;
      floors.set(point, totals.get(point.x) ?? 0);
      totals.set(point.x, (totals.get(point.x) ?? 0) + point.value);
    }
  }
  const from = (point: object) => floors.get(point) ?? 0;
  const to = (point: { value: number }) => from(point) + point.value;
  const ticks = chartTicks(Math.min(...points.map(to), ...(isStacked ? [0] : [])), Math.max(...points.map(to)));
  const low = ticks[0];
  const span = ticks.at(-1)! - low || 1;
  const seriesLegend = seriesNames.length > 1 ? legend(seriesNames.map((name, index) => `<span>${swatch(index)}${escapeHTML(name)}</span>`)) : '';

  if (type === 'bar') {
    const LEFT = 148, RIGHT = 748, TOP = 6, BAND = Math.max(24, seriesNames.length * 14 + 10);
    const bottom = TOP + categories.length * BAND;
    const position = (value: number) => LEFT + (value - low) / span * (RIGHT - LEFT);
    const thickness = (BAND - 10) / (isStacked ? 1 : seriesNames.length);
    let marks = ticks.map(tick => `<path class="${tick === 0 ? 'zero' : 'grid'}" d="M${round(position(tick))} ${TOP}V${bottom}"/><text x="${round(position(tick))}" y="${bottom + 16}" text-anchor="middle">${escapeHTML(labels.number(tick))}</text>`).join('');
    marks += categories.map((x, index) => `<text x="${LEFT - 10}" y="${TOP + index * BAND + BAND / 2 + 4}" text-anchor="end">${escapeHTML(clip(category(x), 20))}</text>`).join('');
    marks += points.map(point => {
      const top = TOP + categories.indexOf(point.x) * BAND + 5 + (isStacked ? 0 : seriesNames.indexOf(point.series) * thickness);
      return `<rect x="${round(Math.min(position(from(point)), position(to(point))))}" y="${round(top)}" width="${round(Math.abs(position(to(point)) - position(from(point))))}" height="${round(Math.max(2, thickness - 2))}" rx="1" fill="${seriesColor(seriesNames.indexOf(point.series))}">${tip(point)}</rect>`;
    }).join('');
    return `${open(760, bottom + 24)}${marks}</svg>${seriesLegend}`;
  }

  const LEFT = 44, RIGHT = 752, TOP = 10, BOTTOM = 232;
  const vertical = (value: number) => BOTTOM - (value - low) / span * (BOTTOM - TOP);
  const band = (RIGHT - LEFT) / categories.length;
  const horizontal = (x: string) => LEFT + (categories.indexOf(x) + 0.5) * band;
  let marks = ticks.map(tick => `<path class="${tick === 0 ? 'zero' : 'grid'}" d="M${LEFT} ${round(vertical(tick))}H${RIGHT}"/><text x="${LEFT - 8}" y="${round(vertical(tick)) + 4}" text-anchor="end">${escapeHTML(labels.number(tick))}</text>`).join('');
  // Labels are thinned to what the width can seat instead of being rotated or overlapped.
  const labelStride = Math.max(1, Math.ceil(categories.length / 8));
  const labelLength = Math.max(6, Math.floor(band * labelStride / 6.4) - 1);
  marks += categories.map((x, index) => index % labelStride ? '' : `<text x="${round(horizontal(x))}" y="${BOTTOM + 18}" text-anchor="middle">${escapeHTML(clip(category(x), labelLength))}</text>`).join('');
  marks += seriesNames.map((name, seriesIndex) => {
    const seriesPoints = points.filter(point => point.series === name);
    const color = seriesColor(seriesIndex);
    if (type === 'column') {
      const width = Math.min(40, band * 0.72 / (isStacked ? 1 : seriesNames.length));
      const offset = isStacked ? -0.5 : seriesIndex - seriesNames.length / 2;
      return seriesPoints.map(point => `<rect x="${round(horizontal(point.x) + offset * width + 1)}" y="${round(Math.min(vertical(from(point)), vertical(to(point))))}" width="${round(Math.max(1, width - 2))}" height="${round(Math.abs(vertical(from(point)) - vertical(to(point))))}" rx="1" fill="${color}">${tip(point)}</rect>`).join('');
    }
    const path = seriesPoints.map((point, index) => `${index ? 'L' : 'M'}${round(horizontal(point.x))} ${round(vertical(to(point)))}`).join('');
    const floor = [...seriesPoints].reverse().map(point => `L${round(horizontal(point.x))} ${round(vertical(from(point)))}`).join('');
    const area = type === 'area' ? `<path d="${path}${floor}Z" fill="${color}" opacity="${isStacked ? 0.32 : 0.14}"/>` : '';
    const radius = seriesPoints.length > 32 ? 0 : 2.5;
    return `${area}<path d="${path}" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" fill="none"/>` + seriesPoints.map(point =>
      `<circle cx="${round(horizontal(point.x))}" cy="${round(vertical(to(point)))}" r="${radius || 6}" fill="${radius ? color : 'transparent'}">${tip(point)}</circle>`).join('');
  }).join('');
  return `${open(760, BOTTOM + 26)}${marks}</svg>${seriesLegend}`;
}

const tone = (status?: string) => status === 'success' ? 'success' : status === 'error' ? 'danger' : 'muted';

function renderTurn(turn: SnapshotTurn, labels: SnapshotLabels, index: number, appearance: SnapshotAppearance, language: string): string {
  const images = turn.images.map(url => /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(url)
    ? `<img class="attachment" src="${escapeHTML(url)}" alt="${escapeHTML(labels.operator)}"/>`
    : `<span class="attachment-omitted">${icon('image', 13)}${escapeHTML(labels.imageOmitted)}</span>`).join('');
  const status = labels.status(turn.code === 'cancelled' ? 'cancelled' : turn.status);
  const metrics = [turn.startedAt === undefined ? '' : labels.date(turn.startedAt), turn.duration === undefined ? '' : labels.duration(turn.duration),
    turn.usage?.total_tokens === undefined ? '' : labels.tokens(turn.usage.total_tokens)].filter(Boolean);
  const segments: string[] = [];
  let chain: string[] = [];
  let callCount = 0;
  const flushChain = () => {
    if (chain.length) segments.push(callCount ? disclosure(labels.calls(callCount), chain.join(''), 'chain') : chain.join(''));
    chain = []; callCount = 0;
  };
  for (const [blockIndex, block] of turn.blocks.entries()) {
    if (block.kind === 'thought') chain.push(disclosure(labels.thought, `<div class="markdown">${markdown(block.text, labels)}</div>`, 'thought'));
    else if (block.kind === 'call') {
      callCount++;
      const name = block.name ?? '';
      const title = labels.capability(name);
      chain.push(`<button type="button" class="call-row" data-panel="call-${index}-${blockIndex}"><span class="call-mark"><span class="pip" data-tone="${tone(block.status)}"></span></span><span class="call-title">${escapeHTML(title)}</span>${title === name ? '' : `<code class="call-name">${escapeHTML(name)}</code>`}<span class="spacer"></span><span class="call-status" data-tone="${tone(block.status)}">${escapeHTML(labels.status(block.status ?? ''))}</span></button>`);
    } else if (block.text.trim()) {
      flushChain();
      segments.push(`<div class="markdown">${markdown(block.text, labels)}</div>`);
    }
  }
  flushChain();
  const views = turn.views.map((view, viewIndex) => {
    if (view.kind === 'panel') return panelMarkup(view, labels, appearance.icons);
    if (view.kind === 'canvas') return canvasMarkup(view, labels, appearance, language);
    if (view.kind !== 'chart') return `<figure><div class="figure-head"><figcaption>${escapeHTML(view.title)}</figcaption></div>${dataTable(view)}</figure>`;
    const id = `${index}-${viewIndex}`;
    return `<figure><div class="figure-head"><figcaption>${escapeHTML(view.title)}</figcaption><div class="figure-tabs"><button type="button" data-view="chart-${id}" aria-pressed="true">${escapeHTML(labels.chart)}</button><button type="button" data-view="data-${id}" aria-pressed="false">${escapeHTML(labels.data)}</button></div></div><div id="chart-${id}" class="figure-content">${chartMarkup(view, labels)}</div><div id="data-${id}" class="figure-content" hidden>${dataTable(view)}</div></figure>`;
  }).join('');
  const user = `<div class="user-row"><div class="user" aria-label="${escapeHTML(labels.operator)}">${turn.user ? `<div class="user-text">${escapeHTML(turn.user)}</div>` : ''}${images ? `<div class="user-images">${images}</div>` : ''}</div></div>`;
  const failure = turn.code && turn.code !== 'cancelled' ? `<p class="failure"><span>${escapeHTML(labels.failure(turn.code))}</span><code>${escapeHTML(turn.code)}</code></p>` : '';
  return `<section class="turn" id="turn-${index + 1}">${user}<article class="answer" aria-label="${escapeHTML(labels.answer)}"><header class="message-head"><span class="message-model">${escapeHTML(turn.model || labels.answer)}</span><span class="status"><span class="pip" data-tone="${tone(turn.status)}"></span>${escapeHTML(status)}</span><span class="spacer"></span><a class="turn-index" href="#turn-${index + 1}">#${index + 1}</a></header>${segments.join('')}${views}${failure}<footer class="message-foot">${metrics.map(value => `<span>${escapeHTML(value)}</span>`).join('')}<span class="spacer"></span><span class="foot-actions">${copyButton(labels)}<button type="button" class="icon-button" data-panel="turn-details-${index}" aria-label="${escapeHTML(labels.panel)}" title="${escapeHTML(labels.panel)}">${icon('panel', 14)}</button></span></footer></article></section>`;
}

/** Scalars read as a ledger; prose and nested values keep their own block so nothing is truncated. */
function facts(record: Record<string, unknown>, labels: SnapshotLabels): string {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined && value !== '' && value !== null);
  const isShort = (value: unknown) => typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 32 && !value.includes('\n'));
  const short = entries.filter(([, value]) => isShort(value));
  const long = entries.filter(([, value]) => !isShort(value));
  return (short.length ? `<dl class="facts">${short.map(([key, value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(typeof value === 'number' ? labels.number(value) : String(value))}</dd>`).join('')}</dl>` : '')
    + long.map(([key, value]) => typeof value === 'string' ? codeBlock(value, labels, key) : codeBlock(JSON.stringify(value, null, 2), labels, key)).join('');
}

function renderPanels(snapshot: ConversationSnapshot, labels: SnapshotLabels): string {
  return snapshot.turns.map((turn, index) => {
    const parameters = facts(turn.parameters ?? {}, labels);
    const usage = facts(turn.usage ?? {}, labels);
    return `<section id="turn-details-${index}" class="panel-content" hidden><h2>${escapeHTML(turn.model || labels.answer)}</h2><p class="panel-sub"><span class="pip" data-tone="${tone(turn.status)}"></span>${escapeHTML(labels.status(turn.code === 'cancelled' ? 'cancelled' : turn.status))}<span class="spacer"></span>#${index + 1}</p>${usage ? `<h3>${escapeHTML(labels.usage)}</h3>${usage}` : ''}${parameters ? `<h3>${escapeHTML(labels.parameters)}</h3>${parameters}` : ''}</section>` + turn.blocks.map((block, blockIndex) => block.kind !== 'call' ? '' :
      `<section id="call-${index}-${blockIndex}" class="panel-content" hidden><h2>${escapeHTML(labels.capability(block.name ?? ''))}</h2><p class="panel-sub"><span class="pip" data-tone="${tone(block.status)}"></span>${escapeHTML(labels.status(block.status ?? ''))}<span class="spacer"></span><code>${escapeHTML(block.name ?? '')}</code></p>${block.arguments ? `<h3>${escapeHTML(labels.arguments)}</h3>${codeBlock(block.arguments, labels, 'json')}` : ''}${block.result ? `<h3>${escapeHTML(labels.result)}</h3>${codeBlock(block.result, labels, 'json')}` : ''}</section>`).join('');
  }).join('');
}

/** A named icon as inline markup; maker marks are files the document cannot carry, so they are left out. */
function viewIcon(reference: string | undefined, icons: LucideIconData | undefined, size: number): string {
  const parsed = parseIconReference(reference);
  const nodes = parsed?.kind === 'lucide' && icons ? lucideNodes(icons, parsed.name) : undefined;
  return nodes ? lucideMarkup(nodes, size) : '';
}

function blockMarkup(block: ViewBlock, labels: SnapshotLabels, icons: LucideIconData | undefined): string {
  const items = block.items ?? [];
  const text = (value: string | undefined) => escapeHTML(value ?? '');
  switch (block.type) {
    case 'stats':
      return `<dl class="stats">${items.map(item => `<div class="stat" data-tone="${text(item.tone ?? 'neutral')}"><dt>${viewIcon(item.icon, icons, 13)}<span>${text(item.label)}</span></dt><dd><span>${text(item.value)}</span>${item.delta ? `<span class="stat-delta">${text(item.delta)}</span>` : ''}</dd></div>`).join('')}</dl>`;
    case 'fields':
      return `<dl class="fields">${items.map(item => `<div><dt>${text(item.label)}</dt><dd>${text(item.value)}</dd></div>`).join('')}</dl>`;
    case 'callout':
      return `<p class="callout" data-tone="${text(block.tone ?? 'info')}">${text(block.text)}</p>`;
    case 'steps':
      return `<ol class="steps">${items.map(item => `<li data-status="${text(item.status ?? 'pending')}"><span class="step-mark" role="img" aria-label="${escapeHTML(labels.step(item.status ?? 'pending'))}"></span><span class="step-label">${text(item.label)}</span>${item.text ? `<span class="step-text">${text(item.text)}</span>` : ''}</li>`).join('')}</ol>`;
    case 'meters':
      return `<div class="meters">${items.map(item => {
        const percent = Math.round(Math.min(1, Math.max(0, item.share ?? 0)) * 100);
        return `<div class="meter" data-tone="${text(item.tone ?? 'neutral')}"><span class="meter-label">${text(item.label)}</span><span class="meter-value">${text(item.value || `${percent}%`)}</span><span class="meter-track"><span style="width:${percent}%"></span></span></div>`;
      }).join('')}</div>`;
    case 'links':
      // A saved document has no console to open, so a link is kept as the name of the page it led to.
      return `<ul class="view-links">${items.map(item => `<li>${viewIcon(item.icon ?? 'arrow-up-right', icons, 13)}<span>${text(item.label)}</span></li>`).join('')}</ul>`;
    default:
      return '';
  }
}

function panelMarkup(view: DisplayView, labels: SnapshotLabels, icons: LucideIconData | undefined): string {
  return `<figure class="panel"><div class="figure-head"><figcaption>${escapeHTML(view.title)}</figcaption></div>${(view.blocks ?? []).map(block =>
    `<section class="block">${block.title ? `<h4>${escapeHTML(block.title)}</h4>` : ''}${blockMarkup(block, labels, icons)}</section>`).join('')}</figure>`;
}

/** The canvas keeps running in the saved document, in the same sandbox; a picture gets a note instead. */
function canvasMarkup(view: DisplayView, labels: SnapshotLabels, appearance: SnapshotAppearance, language: string): string {
  const variables = Object.fromEntries(CANVAS_TOKENS.map(token => [token, appearance.variables[`--${token}`] ?? '']));
  const frameDocument = canvasDocument({ html: view.html ?? '', rows: view.rows, variables, isDark: appearance.isDark ?? true, language });
  return `<figure><div class="figure-head"><figcaption>${escapeHTML(view.title)}</figcaption></div><iframe class="canvas-frame" title="${escapeHTML(view.title)}" sandbox="${CANVAS_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escapeHTML(frameDocument)}"></iframe><p class="canvas-note meta">${escapeHTML(labels.canvasOmitted)}</p></figure>`;
}

export function conversationHTML({ snapshot, labels, appearance, exportedAt, language }: SnapshotDocumentOptions): string {
  // Resolved token values are data too: constrain them before putting them in the stylesheet.
  const safeVariables = Object.fromEntries(Object.entries(appearance.variables).filter(([key, value]) => /^--[a-z0-9-]+$/.test(key) && /^[#a-z0-9.,()%\s-]+$/i.test(value)));
  const variables = Object.entries(safeVariables).map(([key, value]) => `${key}:${value}`).join(';');
  const brand = `<svg class="brand" xmlns="http://www.w3.org/2000/svg" viewBox="${brandDrawing('wordmark').viewBox}" role="img" aria-label="Oh My CPA">${brandMarkup('wordmark', { ink: safeVariables['--fg'] ?? '#f4f4f6', accent: safeVariables['--accent'] ?? '#00b8db' })}</svg>`;
  const iconButton = (attribute: string, label: string, name: IconName) => `<button type="button" class="icon-button" ${attribute} aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}">${icon(name)}</button>`;
  const heading = `<header class="workspace-head">${brand}<span class="head-rule"></span><h1>${escapeHTML(labels.title)}</h1><div class="actions">${iconButton('data-toggle-search', labels.search, 'search')}${iconButton('data-toggle-panel aria-expanded="false"', labels.panel, 'panel')}${iconButton('data-print', labels.print, 'print')}</div></header>`;
  const model = snapshot.turns.at(-1)?.model;
  const totalTokens = snapshot.turns.reduce((sum, turn) => sum + (turn.usage?.total_tokens ?? 0), 0);
  const masthead = `<header class="masthead">${model ? `<span class="masthead-model" title="${escapeHTML(labels.model)}">${escapeHTML(model)}</span>` : ''}<span>${escapeHTML(labels.turns(snapshot.turns.length))}</span>${totalTokens ? `<span>${escapeHTML(labels.tokens(totalTokens))}</span>` : ''}<span class="masthead-date">${escapeHTML(labels.exportedAt)} ${escapeHTML(labels.date(exportedAt.getTime()))}</span></header>`;
  const omitted = snapshot.omitted ? `<p class="omitted meta">${escapeHTML(labels.omitted(snapshot.omitted))}</p>` : '';
  const note = `<footer class="snapshot-foot"><p>${escapeHTML(labels.privacy)}</p></footer>`;
  const search = `<div class="search-bar" hidden>${icon('search', 14)}<input type="search" data-search aria-label="${escapeHTML(labels.search)}" placeholder="${escapeHTML(labels.search)}"><span class="search-count" data-search-count aria-live="polite"></span></div>`;
  const aside = `<aside class="aside" hidden aria-label="${escapeHTML(labels.panel)}"><header class="aside-head"><span>${escapeHTML(labels.panel)}</span>${iconButton('data-close', labels.close, 'close')}</header><section id="snapshot-info" class="panel-content"><h2>${escapeHTML(labels.title)}</h2><p class="meta">${escapeHTML(labels.privacy)}</p><div class="panel-controls"><button type="button" class="text-button" data-expand>${escapeHTML(labels.expand)}</button><button type="button" class="text-button" data-collapse>${escapeHTML(labels.collapse)}</button></div></section>${renderPanels(snapshot, labels)}</aside>`;
  return `<!doctype html><html lang="${escapeHTML(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHTML(labels.title)} · Oh My CPA</title><style>:root{${variables}}${appearance.fontCSS ?? ''}${SNAPSHOT_CSS}</style></head><body data-copy="${escapeHTML(labels.copy)}" data-copied="${escapeHTML(labels.copied)}" data-copy-failed="${escapeHTML(labels.copyFailed)}"><div class="workspace">${heading}${search}<div class="workspace-body"><main class="transcript"><div class="transcript-column">${masthead}${omitted}${snapshot.turns.map((turn, index) => renderTurn(turn, labels, index, appearance, language)).join('')}<p class="no-matches meta" hidden>${escapeHTML(labels.noMatches)}</p>${note}</div></main>${aside}</div></div><script>${SNAPSHOT_SCRIPT}</script></body></html>`;
}
