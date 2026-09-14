import React from 'react';
import { Pie } from '@ant-design/charts';
import { useThemeMode } from '../theme/ThemeContext';
import { seriesColorRange, seriesDomainKey, seriesTrackColor } from './chartTheme';
import { palette } from '../theme/themeConfig';
import { formatModelTokens, type DashboardModelUsage } from '../types/dashboardModels';
import { escapeTooltipText } from './ModelTokenTrend';

/** The full, exact token count for the slice readout - the panel's own compact form is for the list. */
function fullTokens(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

export interface ModelUsageDonutProps {
  groups: DashboardModelUsage[];
  /** The window's own token total, which is what the ring's centre reports. */
  totalTokens: number;
  foldedLabel: string;
  height?: number;
}

/**
 * ModelUsageDonut draws each group's share of the window's tokens as one ring.
 *
 * A ring rather than a filled pie, because the hole is where the total goes and a total inside the
 * reading is the one number the slices have to be read against. It is not a gauge: the ring shows
 * parts of a whole, so the arcs must sum to the centre rather than to an axis.
 *
 * **The centre label is DOM, not a chart annotation.** It is one number in the console's own type
 * scale with tabular numerals, and it must read at the same weight as the KPI values above it. A
 * canvas text mark would be the only data text on the page not set in the mono stack.
 *
 * **The library's legend is disabled.** Colour has to mean the same thing here and in the trend, and
 * the ranked list beside the ring carries the numbers anyway - a legend with no values and a list
 * with values would be two renderings of the same ranking. See `ModelUsagePanels`, which owns that
 * list for both panels.
 */
export const ModelUsageDonut: React.FC<ModelUsageDonutProps> = ({
  groups,
  totalTokens,
  foldedLabel,
  height = 240,
}) => {
  const { themeMode } = useThemeMode();
  const colors = palette[themeMode];

  const domain = React.useMemo(() => groups.map(seriesDomainKey), [groups]);
  const range = React.useMemo(() => seriesColorRange(themeMode, groups), [themeMode, groups]);
  const labelOf = React.useCallback(
    (key: string) => (key === 'folded' ? foldedLabel : key.replace(/^model:/, '')),
    [foldedLabel],
  );

  // Slices are the ranked groups, and a group with no tokens is left out of the ring entirely: an
  // arc of zero angle is not a slice, and passing it in asks the library to divide by a zero total.
  const data = React.useMemo(
    () => groups
      .filter((group) => group.tokens > 0)
      .map((group) => ({ series: seriesDomainKey(group), tokens: group.tokens })),
    [groups],
  );

  // The ring is a canvas, so the accessible reading of it is text rather than a mark: one label naming
  // what the ring shows and the total it sums to. The per-group numbers are in the ranked list beside
  // it, which is real DOM.
  const centerLabel = `${totalTokens} tokens`;

  // The centre reports the response's own window total. Dropping the zero-valued slices above cannot
  // change a sum, so there is nothing to recompute and no second number that could disagree.

  return (
    <div
      className="model-ring"
      style={{ height }}
      role="img"
      aria-label={centerLabel}
    >
      {data.length > 0 && (
        <Pie
          data={data}
          angleField="tokens"
          colorField="series"
          innerRadius={0.68}
          radius={0.92}
          height={height}
          autoFit
          animate={false}
          legend={false}
          label={false}
          // The readout is rendered here for the same reasons as the trend's: the library's default item
          // name is the raw domain value, and its box is a light sans-serif panel on a dark console. The
          // share is not printed - it is in the ranked list beside the ring, derived from the same total
          // the centre reports, so the two cannot disagree.
          scale={{ color: { domain, range } }}
          // A 2px stroke in the card's own colour separates adjacent slices. Without it two neighbouring
          // hues touch directly, which is where a boundary is hardest to find.
          style={{ stroke: colors.surface, lineWidth: 2, radius: 0.92, innerRadius: 0.68 }}
          // A ring with no axes: the coordinate is theta, so an axis would be a line through the middle
          // of the drawing.
          axis={false}
          theme={{ view: { viewFill: 'transparent' } }}
          padding={0}
          // The readout is configured on the interaction - see the trend's note for why - and the
          // library's default template would print the raw domain value as the slice's name.
          interaction={{
            tooltip: {
              render: (
                _event: unknown,
                context: { items?: Array<{ color?: string; value?: number; name?: string }> },
              ) => {
                const item = context?.items?.[0];
                if (!item) return '';
                // The slice's value is its token count and its name is the raw domain key, so the label
                // is resolved from the key rather than the library's decorated one.
                const name = labelOf(item.name ?? '');
                const shape = `<span class="omc-tip-swatch" style="background:${item.color ?? 'transparent'}"></span>`;
                return `<div class="omc-tip"><div class="omc-tip-row">${shape}<span class="omc-tip-name">${escapeTooltipText(name)}</span><span class="omc-tip-value">${fullTokens(item.value ?? 0)} tokens</span></div></div>`;
              },
            },
          }}
          // The library's own background circle is off. The empty state is drawn by the panel's CSS
          // track instead, so it belongs to the same scale as the trend's plot floor and appears when
          // there is no ring to sit behind.
          background={false}
        />
      )}
      <div className="model-ring-center">
        <span className="model-ring-total">{formatModelTokens(totalTokens)}</span>
        {/* The unit is decorative punctuation beside the number; the wrapper carries the accessible
            text, so a screen reader hears "N tokens" rather than a bare figure. */}
        <span className="model-ring-unit" aria-hidden="true">tokens</span>
      </div>
      {data.length === 0 && <span className="model-ring-track" style={{ borderColor: seriesTrackColor(themeMode) }} aria-hidden="true" />}
    </div>
  );
};
