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
import type { CanvasFormat } from './canvasDocument';
import type { UIIconAssets } from './uiAssets';
import type { DisplayView, ViewBlock } from './types';
import type { ConversationSnapshot, SnapshotTurn } from './conversationSnapshot';

export interface SnapshotLabels {
  title: string; operator: string; answer: string; model: string; exportedAt: string;
  thought: string; parameters: string; arguments: string; result: string;
  copy: string; copied: string; copyFailed: string; search: string; expand: string; collapse: string;
  print: string; imageOmitted: string; privacy: string; panel: string; close: string; usage: string;
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
  duration: (milliseconds: number) => string;
  number: (value: number) => string;
}
/** `icons` is the Lucide set, passed when a panel names an icon; without it panels are drawn unadorned. */
export interface SnapshotAppearance { variables: Record<string, string>; fontCSS?: string; icons?: LucideIconData; uiIcons?: UIIconAssets; isDark?: boolean; format?: CanvasFormat }
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
  const views = turn.views.map(view => {
    if (view.kind === 'panel') return panelMarkup(view, labels, appearance.icons);
    return canvasMarkup(view, labels, appearance, language);
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
  const frameDocument = canvasDocument({ icons: appearance.uiIcons, html: view.html ?? '', rows: view.rows, variables, isFrameless: view.frame === 'none', isDark: appearance.isDark ?? true, language, format: appearance.format });
  return `<figure${view.frame === 'none' ? ` data-frame="none" aria-label="${escapeHTML(view.title)}"` : ''}><div class="figure-head"><figcaption>${escapeHTML(view.title)}</figcaption></div><iframe class="canvas-frame" title="${escapeHTML(view.title)}" sandbox="${CANVAS_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escapeHTML(frameDocument)}"></iframe><p class="canvas-note meta">${escapeHTML(labels.canvasOmitted)}</p></figure>`;
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
