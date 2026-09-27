/**
 * Hands a fetched file to the browser as a download.
 *
 * The object URL is released on a delay rather than straight after `click()`: the click only
 * schedules the download, and revoking the URL in the same task cancels it in Firefox and Safari
 * - the save silently never happens. The anchor is attached for the same reason: a detached
 * anchor's click is ignored by some engines.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
