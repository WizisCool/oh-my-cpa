/** `sk-ab…1234` style preview; short keys collapse to bullets only. */
export function maskKeyText(key?: string): string {
  const trimmed = (key || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••••••';
  const prefixLen = trimmed.length < 12 ? 2 : 4;
  return trimmed.slice(0, prefixLen) + '••••••••' + trimmed.slice(-4);
}
