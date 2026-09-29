export interface ChartTooltipRow {
  name?: string;
  color?: string;
  value: string;
  exact?: string;
}

export function escapeTooltipText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Shared content for G2's positioned tooltip; upstream labels are untrusted. */
export function renderChartTooltip(time: string, rows: ChartTooltipRow[]): string {
  return `<div class="omc-tip"><div class="omc-tip-time">${escapeTooltipText(time)}</div>${rows.map((row) =>
    `<div class="omc-tip-row">${row.color ? `<span class="omc-tip-swatch" style="background:${escapeTooltipText(row.color)}"></span>` : ''}${row.name ? `<span class="omc-tip-name">${escapeTooltipText(row.name)}</span>` : ''}<span class="omc-tip-value" title="${escapeTooltipText(row.exact ?? row.value)}">${escapeTooltipText(row.value)}</span></div>`
  ).join('')}</div>`;
}
