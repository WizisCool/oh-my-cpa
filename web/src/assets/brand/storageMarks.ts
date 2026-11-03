/**
 * The published marks of the cloud services backups can be sent to, copied from the SVG Logos
 * collection and Simple Icons (both CC0) into the bundle.
 *
 * Resolved through `new URL(..., import.meta.url)` rather than as a page path: the console is
 * served under a configured base path, and a path assembled at render would break there. The
 * marks are only for services that publish one - protocol services use the icon set's glyph.
 */
const STORAGE_MARKS = {
  onedrive: new URL('./storage/onedrive.svg', import.meta.url).href,
  drive: new URL('./storage/drive.svg', import.meta.url).href,
  s3: new URL('./storage/s3.svg', import.meta.url).href,
} as const;

export type StorageMark = keyof typeof STORAGE_MARKS;

export function storageMarkURL(mark: StorageMark): string {
  return STORAGE_MARKS[mark];
}
