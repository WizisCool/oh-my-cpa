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
import { snapshotViews } from './conversationSnapshot';
import type { ConversationSnapshot, SnapshotCall, SnapshotSegment, SnapshotStep, SnapshotTurn } from './conversationSnapshot';
import { statusTone } from './callFacts';

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
  /** A call's own outcome, in the words its row uses. */
  callStatus: (name: string, status: string) => string;
  chainFailed: (count: number) => string;
  rounds: (rounds: number, calls: number) => string;
  present: (present: string) => string;
  /** A token count the way the console writes one. */
  tokenCount: (count: number) => string;
  failure: (code: string) => string;
  date: (milliseconds: number) => string;
  duration: (milliseconds: number) => string;
  number: (value: number) => string;
}
/** `icons` is the Lucide set, passed when a panel names an icon; without it panels are drawn unadorned. */
export interface SnapshotAppearance {
  variables: Record<string, string>; fontCSS?: string; icons?: LucideIconData; uiIcons?: UIIconAssets; isDark?: boolean; format?: CanvasFormat;
  /** `slot` leaves each canvas a place for its picture instead of a running frame. */
  canvases?: 'frame' | 'slot';
}
export interface SnapshotDocumentOptions {
  snapshot: ConversationSnapshot; labels: SnapshotLabels; appearance: SnapshotAppearance; exportedAt: Date; language: string;
}
const element = React.createElement;
export function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

type IconName = 'search' | 'panel' | 'print' | 'close' | 'copy' | 'caret' | 'image' | 'steps' | 'thought' | 'check' | 'warning' | 'clock' | 'tokens' | 'interface' | 'document';
const ICON_PATHS: Record<IconName, string> = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/>',
  print: '<path d="M7 8V3h10v5M7 17H3V8h18v9h-4M7 13h10v8H7z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  caret: '<path d="m9 5 7 7-7 7"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="m3 16 5-5 5 5 3-3 5 5"/><circle cx="15.5" cy="9" r="1.5"/>',
  // The marks the conversation's own rows carry, so a saved row reads as the row it was.
  steps: '<path d="M8 5h13"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="M3 10a2 2 0 0 0 2 2h3"/><path d="M3 5v12a2 2 0 0 0 2 2h3"/>',
  thought: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  tokens: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  interface: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  document: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
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
/**
 * A model's reasoning as a disclosure: the same row and quieter ink the conversation gives it.
 * A `<details>` keeps it openable in a document whose only script is the fixed one below.
 */
function reasoningMarkup(text: string, labels: SnapshotLabels): string {
  return `<details class="reasoning"><summary class="reasoning-toggle"><span class="step-mark-slot" data-step-mark>${icon('thought', 13)}</span><span>${escapeHTML(labels.thought)}</span>${icon('caret', 10)}</summary><div class="reasoning-body"><div class="markdown">${markdown(text, labels)}</div></div></details>`;
}

const CALL_MARKS: Partial<Record<SnapshotCall['tone'], IconName>> = { success: 'check', warning: 'warning', error: 'close' };

/**
 * One capability call as the disclosure the conversation draws (ADR 0084): a row of status mark,
 * title, arguments in brief and duration, and under it what was sent and what came back.
 */
function callMarkup(call: SnapshotCall, labels: SnapshotLabels): string {
  const title = labels.capability(call.name);
  const status = labels.callStatus(call.name, call.status);
  const mark = CALL_MARKS[call.tone];
  const row = `<summary class="call-row"><span class="call-mark" data-step-mark data-tone="${call.tone}">${mark ? icon(mark, 12) : ''}</span><span class="call-title">${escapeHTML(title)}</span>`
    + (call.summary ? `<span class="call-args">${escapeHTML(call.summary)}</span>` : '')
    + '<span class="spacer"></span>'
    + (call.status === 'success' ? '' : `<span class="call-status" data-tone="${call.tone}">${escapeHTML(status)}</span>`)
    + (call.duration === undefined ? '' : `<span class="call-duration">${escapeHTML(labels.duration(call.duration))}</span>`)
    + `${icon('caret', 10)}</summary>`;
  const facts = `<div class="call-facts"><code class="call-name">${escapeHTML(call.name)}</code><span class="status"><span class="pip" data-tone="${call.tone}"></span>${escapeHTML(status)}</span>${call.startedAt === undefined ? '' : `<span>${escapeHTML(labels.date(call.startedAt))}</span>`}</div>`;
  const section = (heading: string, body: string) => `<section class="call-section"><h4>${escapeHTML(heading)}</h4>${codeBlock(body, labels, 'json')}</section>`;
  const failure = call.status === 'error' && call.code ? `<div class="call-failure"><code>${escapeHTML(call.code)}</code>${call.detail ? `<span>${escapeHTML(call.detail)}</span>` : ''}</div>` : '';
  return `<div class="call" data-status="${escapeHTML(call.status)}"><details>${row}<div class="call-detail">${facts}${section(labels.arguments, call.arguments)}${call.result ? section(labels.result, call.result) : ''}</div></details>${failure}</div>`;
}

function stepMarkup(step: SnapshotStep, labels: SnapshotLabels): string {
  return step.kind === 'thought' ? reasoningMarkup(step.text, labels) : callMarkup(step, labels);
}

/** A stretch of reasoning and calls as one timeline: a line that counts the work, and the steps on a rail under it. */
function chainMarkup(steps: readonly SnapshotStep[], labels: SnapshotLabels): string {
  const calls = steps.filter(step => step.kind === 'call');
  const failed = calls.filter(call => call.kind === 'call' && ['error', 'rejected', 'expired'].includes(call.status)).length;
  return `<details class="chain"><summary class="chain-toggle"><span class="chain-icon">${icon('steps', 13)}</span><span>${escapeHTML(labels.calls(calls.length))}</span>${failed ? `<span class="chain-failed">${escapeHTML(labels.chainFailed(failed))}</span>` : ''}${icon('caret', 10)}</summary><div class="chain-body">${steps.map(step => stepMarkup(step, labels)).join('')}</div></details>`;
}

function segmentMarkup(segment: SnapshotSegment, labels: SnapshotLabels, appearance: SnapshotAppearance, language: string): string {
  switch (segment.kind) {
    case 'text':
      return segment.text.trim() ? `<div class="markdown answer-text">${markdown(segment.text, labels)}</div>` : '';
    case 'thought':
      return reasoningMarkup(segment.text, labels);
    case 'chain':
      return chainMarkup(segment.steps, labels);
    case 'figure':
      return segment.view.kind === 'panel' ? panelMarkup(segment.view, labels, appearance.icons) : canvasMarkup(segment.view, labels, appearance, language);
    case 'call':
      return callMarkup(segment, labels);
  }
}

function renderTurn(turn: SnapshotTurn, labels: SnapshotLabels, index: number, appearance: SnapshotAppearance, language: string, layout: ConversationSnapshot['layout']): string {
  const images = turn.images.map(url => /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(url)
    ? `<img class="attachment" src="${escapeHTML(url)}" alt="${escapeHTML(labels.operator)}"/>`
    : `<span class="attachment-omitted">${icon('image', 13)}${escapeHTML(labels.imageOmitted)}</span>`).join('');
  const tone = statusTone(turn.status, turn.code);
  const status = `<span class="status"><span class="pip" data-tone="${tone}"></span>${escapeHTML(labels.status(turn.code === 'cancelled' ? 'cancelled' : turn.status))}</span>`;
  const metric = (text: string, mark?: IconName) => `<span class="metric">${mark ? icon(mark, 12) : ''}${escapeHTML(text)}</span>`;
  const metrics = [
    turn.duration === undefined ? '' : metric(labels.duration(turn.duration), 'clock'),
    turn.startedAt === undefined ? '' : metric(labels.date(turn.startedAt)),
    turn.rounds ? metric(labels.rounds(turn.rounds, turn.calls ?? 0)) : '',
    turn.usage?.total_tokens === undefined ? '' : `<span class="metric" title="${escapeHTML(labels.tokens(turn.usage.total_tokens))}">${icon('tokens', 12)}${escapeHTML(labels.tokenCount(turn.usage.total_tokens))}</span>`,
  ].join('');
  const anchor = `<a class="turn-index" href="#turn-${index + 1}">#${index + 1}</a>`;
  const present = turn.present ? `<div class="sent-files"><span class="sent-file" data-tone="accent">${icon(turn.present === 'text' ? 'document' : 'interface', 12)}${escapeHTML(labels.present(turn.present))}</span></div>` : '';
  const user = `<div class="user-row">${present}<div class="user" aria-label="${escapeHTML(labels.operator)}">${turn.user ? `<div class="user-text">${escapeHTML(turn.user)}</div>` : ''}${images ? `<div class="user-images">${images}</div>` : ''}</div></div>`;
  const failure = turn.code && turn.code !== 'cancelled' ? `<p class="failure"><span>${escapeHTML(labels.failure(turn.code))}</span><code>${escapeHTML(turn.code)}</code></p>` : '';
  // The Playground names the model above each answer and the Agent does not: its status leads the foot.
  const head = layout === 'playground' ? `<header class="message-head"><span class="message-model">${escapeHTML(turn.model || labels.answer)}</span>${status}</header>` : '';
  const foot = `<footer class="message-foot">${layout === 'playground' ? '' : status}${metrics}<span class="spacer"></span>${anchor}<span class="foot-actions">${copyButton(labels)}<button type="button" class="icon-button" data-panel="turn-details-${index}" aria-label="${escapeHTML(labels.panel)}" title="${escapeHTML(labels.panel)}">${icon('panel', 14)}</button></span></footer>`;
  return `<section class="turn" id="turn-${index + 1}">${user}<article class="answer" aria-label="${escapeHTML(labels.answer)}">${head}${turn.segments.map(segment => segmentMarkup(segment, labels, appearance, language)).join('')}${failure}${foot}</article></section>`;
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
    return `<section id="turn-details-${index}" class="panel-content" hidden><h2>${escapeHTML(turn.model || labels.answer)}</h2><p class="panel-sub"><span class="pip" data-tone="${statusTone(turn.status, turn.code)}"></span>${escapeHTML(labels.status(turn.code === 'cancelled' ? 'cancelled' : turn.status))}<span class="spacer"></span>#${index + 1}</p>${usage ? `<h3>${escapeHTML(labels.usage)}</h3>${usage}` : ''}${parameters ? `<h3>${escapeHTML(labels.parameters)}</h3>${parameters}` : ''}</section>`;
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
  return `<figure class="view panel"><div class="figure-head"><figcaption>${escapeHTML(view.title)}</figcaption></div>${(view.blocks ?? []).map(block =>
    `<section class="block">${block.title ? `<h4>${escapeHTML(block.title)}</h4>` : ''}${blockMarkup(block, labels, icons)}</section>`).join('')}</figure>`;
}

/** The document a saved canvas runs in: the one the conversation's own frame is given. */
export function snapshotCanvasDocument(view: DisplayView, appearance: SnapshotAppearance, language: string): string {
  const variables = Object.fromEntries(CANVAS_TOKENS.map(token => [token, appearance.variables[`--${token}`] ?? '']));
  return canvasDocument({ icons: appearance.uiIcons, html: view.html ?? '', rows: view.rows, variables, isFrameless: view.frame === 'none', isDark: appearance.isDark ?? true, language, format: appearance.format });
}

/** The canvases a snapshot draws, in the order their frames or slots appear in the document. */
export function snapshotCanvases(snapshot: ConversationSnapshot): DisplayView[] {
  return snapshotViews(snapshot).filter(view => view.kind !== 'panel');
}

/**
 * The canvas keeps running in the saved document, in the same sandbox. A document that is about
 * to become a picture cannot run one - a picture has no script - so there the canvas leaves a
 * slot, which the capture fills with a picture the canvas drew of itself, and a note for the
 * case where it could not.
 */
function canvasMarkup(view: DisplayView, labels: SnapshotLabels, appearance: SnapshotAppearance, language: string): string {
  const body = appearance.canvases === 'slot'
    ? '<div class="canvas-slot" data-canvas-slot></div>'
    : `<iframe class="canvas-frame" title="${escapeHTML(view.title)}" sandbox="${CANVAS_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escapeHTML(snapshotCanvasDocument(view, appearance, language))}"></iframe>`;
  return `<figure class="view"${view.frame === 'none' ? ` data-frame="none" aria-label="${escapeHTML(view.title)}"` : ''}><div class="figure-head"><figcaption>${escapeHTML(view.title)}</figcaption></div>${body}<p class="canvas-note meta">${escapeHTML(labels.canvasOmitted)}</p></figure>`;
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
  return `<!doctype html><html lang="${escapeHTML(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHTML(labels.title)} · Oh My CPA</title><style>:root{${variables}}${appearance.fontCSS ?? ''}${SNAPSHOT_CSS}</style></head><body data-copy="${escapeHTML(labels.copy)}" data-copied="${escapeHTML(labels.copied)}" data-copy-failed="${escapeHTML(labels.copyFailed)}"><div class="workspace">${heading}${search}<div class="workspace-body"><main class="transcript"><div class="transcript-column">${masthead}${omitted}${snapshot.turns.map((turn, index) => renderTurn(turn, labels, index, appearance, language, snapshot.layout)).join('')}<p class="no-matches meta" hidden>${escapeHTML(labels.noMatches)}</p>${note}</div></main>${aside}</div></div><script>${SNAPSHOT_SCRIPT}</script></body></html>`;
}
