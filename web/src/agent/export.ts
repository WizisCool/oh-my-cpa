import type { DisplayView } from './types';

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

/** `omc-agent-20260929-153012.html`: sortable, free of characters a file system refuses. */
export function exportFileName(prefix: string, extension: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const safe = prefix.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';
  return `${safe}-${stamp}.${extension}`;
}
