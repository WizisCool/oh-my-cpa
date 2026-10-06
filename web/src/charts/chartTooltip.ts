export interface ChartTooltipRow {
  name?: string;
  color?: string;
  value: string;
  exact?: string;
  share?: string;
}

export function escapeTooltipText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Shared content for G2's positioned tooltip; upstream labels are untrusted. */
export function renderChartTooltip(time: string | undefined, rows: ChartTooltipRow[]): string {
  const hasNames = rows.some((row) => Boolean(row.name));
  const hasShares = rows.some((row) => row.share !== undefined);
  const heading = time === undefined ? '' : `<div class="omc-tip-time">${escapeTooltipText(time)}</div>`;
  return `<div class="omc-tip">${heading}<div class="omc-tip-rows${hasNames ? ' has-names' : ''}${hasShares ? ' has-shares' : ''}">${rows.map((row) =>
    `<div class="omc-tip-row">${row.color ? `<span class="omc-tip-swatch" aria-hidden="true" style="background:${escapeTooltipText(row.color)}"></span>` : ''}${row.name ? `<span class="omc-tip-name" title="${escapeTooltipText(row.name)}">${escapeTooltipText(row.name)}</span>` : ''}<span class="omc-tip-value" title="${escapeTooltipText(row.exact ?? row.value)}">${escapeTooltipText(row.value)}</span>${row.share === undefined ? '' : `<span class="omc-tip-share">${escapeTooltipText(row.share)}</span>`}</div>`
  ).join('')}</div></div>`;
}
