/**
 * What a conversation exports as, built in the browser from what the page already shows.
 *
 * Nothing here asks the server for more: an export is the transcript the operator is reading, in
 * a file, so it can never carry data the page did not display. Every function is pure so its
 * escaping rules are asserted without a browser.
 */

/** `omc-agent-20260929-153012.html`: sortable, free of characters a file system refuses. */
export function exportFileName(prefix: string, extension: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const safe = prefix.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';
  return `${safe}-${stamp}.${extension}`;
}
