import { completedDisplayViews } from './types';
import type { Conversation, DisplayView, Trace, Turn, TurnPart } from './types';

/**
 * What a conversation exports as, built in the browser from what the page already shows.
 *
 * Nothing here asks the server for more: an export is the transcript the operator is reading, in
 * a file, so it can never carry data the page did not display. Every function is pure so its
 * escaping rules are asserted without a browser.
 */

type Cell = string | number | boolean | null | undefined;

/**
 * One CSV cell. Quoted when it holds a separator, a quote or a line break (RFC 4180), and a text
 * cell that a spreadsheet would read as a formula is prefixed with an apostrophe: capability results
 * carry strings other people chose - key aliases, provider notes - and a CSV opened in a spreadsheet
 * must not execute them.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCSV(columns: readonly string[], rows: readonly Record<string, Cell>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map(column => csvCell(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function viewToCSV(view: Pick<DisplayView, 'columns' | 'rows'>): string {
  return rowsToCSV(view.columns, view.rows);
}

function markdownCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A table as GitHub-flavoured Markdown, with pipes and line breaks inside cells neutralised. */
export function rowsToMarkdown(columns: readonly string[], rows: readonly Record<string, Cell>[]): string {
  const head = `| ${columns.map(markdownCell).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${columns.map(column => markdownCell(row[column])).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

export function viewToMarkdown(view: Pick<DisplayView, 'title' | 'columns' | 'rows'>): string {
  return `**${markdownCell(view.title)}**\n\n${rowsToMarkdown(view.columns, view.rows)}`;
}

/**
 * The answer's export: its text first, then the figures only a successful turn publishes, then any
 * failure. Display calls stay in the call list as work; the figures repeat the rows they froze.
 */
/** A `database_query` result - columns and positional rows - as the table shape the exports use. */
export function queryResultTable(data: unknown): Pick<DisplayView, 'columns' | 'rows'> | undefined {
  const value = data as { columns?: unknown; rows?: unknown } | undefined;
  if (!Array.isArray(value?.columns) || !Array.isArray(value.rows)) return undefined;
  const columns = value.columns.map(String);
  const rows = value.rows.flatMap(row => (Array.isArray(row)
    ? [Object.fromEntries(columns.map((column, index) => [column, (row[index] ?? null) as DisplayView['rows'][number][string]]))]
    : []));
  return { columns, rows };
}

/** `omc-agent-20260929-153012.md`: sortable, free of characters a file system refuses. */
export function exportFileName(prefix: string, extension: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const safe = prefix.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';
  return `${safe}-${stamp}.${extension}`;
}

/** The words an export is written in, supplied in the console's language by the caller. */
export interface ExportLabels {
  title: string;
  model: string;
  exportedAt: string;
  operator: string;
  answer: string;
  calls: string;
  status: (status: string) => string;
  capability: (name: string) => string;
  duration: (milliseconds: number) => string;
  failure: (code: string) => string;
}

function traceLine(trace: Trace, labels: ExportLabels): string {
  const fields = [`\`${trace.name}\``, labels.capability(trace.name), labels.status(trace.result.status)];
  if (trace.started_at_ms && trace.ended_at_ms) fields.push(labels.duration(trace.ended_at_ms - trace.started_at_ms));
  const args = trace.arguments?.trim();
  const line = `- ${fields.filter(Boolean).join(' · ')}`;
  return args && args !== '{}' ? `${line}\n  \`${args.replace(/`/g, "'")}\`` : line;
}

/**
 * One answer as Markdown: its text, each chart or table as the data it froze, and its capability
 * calls as a short list. Reasoning is left out - it is the model's working, not its answer.
 */
export function turnAnswerMarkdown(turn: Pick<Turn, 'reply' | 'parts' | 'traces' | 'code' | 'status'>, labels: ExportLabels): string {
  const traces = new Map(turn.traces.map(trace => [trace.id, trace]));
  const parts: TurnPart[] = turn.parts?.length
    ? turn.parts
    : [...turn.traces.map(trace => ({ type: 'tool' as const, trace_id: trace.id })), ...(turn.reply ? [{ type: 'text' as const, content: turn.reply }] : [])];
  const blocks: string[] = [];
  let calls: string[] = [];
  const flushCalls = () => {
    if (calls.length) blocks.push(`${labels.calls}\n\n${calls.join('\n')}`);
    calls = [];
  };
  for (const part of parts) {
    if (part.type === 'text' && part.content?.trim()) {
      flushCalls();
      blocks.push(part.content.trim());
    } else if (part.type === 'tool' && part.trace_id) {
      const trace = traces.get(part.trace_id);
      if (!trace) continue;
      calls.push(traceLine(trace, labels));
    }
  }
  flushCalls();
  blocks.push(...completedDisplayViews(turn).map(trace => viewToMarkdown(trace.view!)));
  if (turn.code && turn.code !== 'cancelled') blocks.push(`> ${labels.failure(turn.code)} (\`${turn.code}\`)`);
  return blocks.join('\n\n');
}

/** The whole Agent conversation as a Markdown report. */
export function conversationMarkdown(conversation: Conversation, labels: ExportLabels, exportedAt: Date): string {
  const head = [`# ${labels.title}`, '', `- ${labels.model}: \`${conversation.model || '-'}\``, `- ${labels.exportedAt}: ${exportedAt.toISOString()}`];
  const turns = conversation.turns.map(turn => [
    `## ${labels.operator}`,
    '',
    turn.user,
    '',
    `## ${labels.answer} · ${labels.status(turn.status)}`,
    '',
    turnAnswerMarkdown(turn, labels),
  ].join('\n'));
  return `${[head.join('\n'), ...turns].join('\n\n---\n\n')}\n`;
}

/** A Playground turn reduced to what its export needs. */
export interface PlaygroundExportTurn {
  user: string;
  imageCount: number;
  reply: string;
  model: string;
  status: string;
  parameters: Record<string, unknown>;
}

export interface PlaygroundExportLabels {
  title: string;
  exportedAt: string;
  operator: string;
  answer: string;
  model: string;
  parameters: string;
  images: (count: number) => string;
  status: (status: string) => string;
}

/** The Playground conversation as Markdown, each answer with the model and parameters it ran with. */
export function playgroundMarkdown(turns: readonly PlaygroundExportTurn[], labels: PlaygroundExportLabels, exportedAt: Date): string {
  const head = `# ${labels.title}\n\n- ${labels.exportedAt}: ${exportedAt.toISOString()}`;
  const body = turns.map(turn => {
    const parameters = Object.entries(turn.parameters).filter(([, value]) => value !== undefined && value !== '');
    return [
      `## ${labels.operator}`,
      '',
      turn.user || '-',
      ...(turn.imageCount ? ['', `_${labels.images(turn.imageCount)}_`] : []),
      '',
      `## ${labels.answer} · ${labels.status(turn.status)}`,
      '',
      `- ${labels.model}: \`${turn.model}\``,
      ...(parameters.length ? [`- ${labels.parameters}: ${parameters.map(([key, value]) => `\`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\``).join(', ')}`] : []),
      '',
      turn.reply.trim() || '-',
    ].join('\n');
  });
  return `${[head, ...body].join('\n\n---\n\n')}\n`;
}
