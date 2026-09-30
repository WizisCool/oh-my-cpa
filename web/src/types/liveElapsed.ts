/** Running labels expose 10ms steps below a second and tenths of a second thereafter. */
export function elapsedLabel(milliseconds: number): string {
  const elapsed = Math.max(0, milliseconds);
  if (elapsed < 1000) return `${Math.floor(elapsed / 10) * 10}ms`;
  return `${(Math.floor(elapsed / 100) / 10).toFixed(1)}s`;
}
