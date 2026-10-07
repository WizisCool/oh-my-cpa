/** downloadBlob hands a generated file to the browser's own download flow. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Whether this browser can put an image on the clipboard at all. */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
}

export async function copyImage(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}
