import React from 'react';
import { Pie } from '@ant-design/charts';
import { useThemeMode } from '../theme/ThemeContext';
import { seriesColorRange, seriesDomainKey, seriesTrackColor } from './chartTheme';
import { formatModelShare, formatModelTokens, type DashboardModelUsage } from '../types/dashboardModels';
import { formatTokens, formatTokensFull } from '../types/tokenDisplay';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import { escapeTooltipText } from './ModelTokenTrend';

export interface ModelUsageDonutProps {
  groups: DashboardModelUsage[];
  /** The window's own token total, which is what the ring's centre reports. */
  totalTokens: number;
  foldedLabel: string;
  tokenUnitLabel: string;
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
 * **The readout overlays the square frame, not the outer wrapper.** The drawing's box is the frame's,
 * and the frame is kept square by CSS at whatever width the flex row leaves it, so the readout and
 * the arcs are measured against the same box. Anchoring the readout to the outer wrapper instead
 * would tie it to a box whose height is set by the row rather than by the drawing, which is how the
 * total came to sit off the ring's centre once the frame could be narrower than that row was tall.
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
  tokenUnitLabel,
}) => {
  const { theme } = useThemeMode();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const colors = theme.palette;

  const domain = React.useMemo(() => groups.map(seriesDomainKey), [groups]);
  const range = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);
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
  const centerLabel = `${formatTokensFull(totalTokens)} ${tokenUnitLabel}`;

  // The centre reports the response's own window total. Dropping the zero-valued slices above cannot
  // change a sum, so there is nothing to recompute and no second number that could disagree.

  return (
    // No inline height: the wrapper is only the layer the frame is placed in, and the frame's own
    // square box decides the height. A height pinned here would outlive the frame being clamped
    // narrower and leave the ring sitting in the top of a box taller than itself.
    <div
      className="model-ring"
      role="img"
      aria-label={centerLabel}
    >
      {/* The square frame is what the readout centres on; see the class note on the centre box. */}
      <div className="model-ring-frame">
        {data.length > 0 && (
          <Pie
            data={data}
            angleField="tokens"
            colorField="series"
            innerRadius={0.68}
            radius={0.92}
            // No height prop: the drawing takes the box the CSS frame gives it. A fixed height here
            // outranks `autoFit` and pins the canvas to 220px tall while the frame is clamped narrower,
            // which draws an ellipse and drops the readout below the arcs' centre.
            autoFit
            animate={false}
            legend={false}
            label={false}
            // The readout is rendered here for the same reasons as the trend's: the library's own panel is
            // a light sans-serif box on a dark console. The share is printed beside the volume because a
            // slice is read as a fraction of the ring, and it is derived from the same window total the
            // centre reports, so the two readings cannot disagree.
            scale={{ color: { domain, range } }}
            // The item's own name comes from the datum, not from the library's inference: the inferred
            // item is built from the y channel, so every slice would be named after the field ("tokens")
            // instead of after its group. A function item is the one form the library evaluates per data
            // row, and it is also where the exact count is kept, so the tooltip's formatter never has to
            // re-derive which group it is printing.
            tooltip={{
              items: [(datum: { series: string; tokens: number }) => ({
                name: labelOf(datum.series),
                value: datum.tokens,
              })],
            }}
            // A 2px stroke in the card's own colour separates adjacent slices. Without it two neighbouring
            // hues touch directly, which is where a boundary is hardest to find.
            style={{ stroke: colors.surface, lineWidth: 2, radius: 0.92, innerRadius: 0.68 }}
            // A ring with no axes: the coordinate is theta, so an axis would be a line through the middle
            // of the drawing.
            axis={false}
            theme={{ view: { viewFill: 'transparent' } }}
            padding={0}
            // The readout is configured on the interaction - see the trend's note for why - because the
            // library's own template is a light sans-serif panel that does not belong on this console.
            // The value prints in the console's unit style, matching the list beside the ring.
            interaction={{
              tooltip: {
                render: (
                  _event: unknown,
                  context: { items?: Array<{ color?: string; value?: number; name?: string }> },
                ) => {
                  const item = context?.items?.[0];
                  if (!item) return '';
                  // The item is named from the datum by the mark's own tooltip spec above, so it already
                  // carries the group's label; only the value needs the console's unit style.
                  const name = item.name ?? '';
                  const shape = `<span class="omc-tip-swatch" style="background:${item.color ?? 'transparent'}"></span>`;
                  // The readout states the three things a slice is being judged on, in the order the
                  // ranked list beside the ring prints them: which group it is, how much it moved, and
                  // what share of the window that is. The share is derived from the same total the
                  // centre reports, so a slice's percentage and the ring's own reading cannot disagree.
                  const value = item.value ?? 0;
                  const exact = `${formatTokensFull(value)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}`;
                  return `<div class="omc-tip"><div class="omc-tip-row">${shape}<span class="omc-tip-name">${escapeTooltipText(name)}</span><span class="omc-tip-value" title="${escapeTooltipText(exact)}">${formatTokens(value, tokenStyle)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}</span><span class="omc-tip-share">${formatModelShare(value, totalTokens)}</span></div></div>`;
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
          <span className="model-ring-total">{formatModelTokens(totalTokens, tokenStyle)}</span>
          {/* The unit is decorative punctuation beside the number; the wrapper carries the accessible
              text, so a screen reader hears "N tokens" rather than a bare figure. */}
          <span className="model-ring-unit" aria-hidden="true">{tokenUnitLabel}</span>
        </div>
      </div>
      {data.length === 0 && <span className="model-ring-track" style={{ borderColor: seriesTrackColor(theme.palette) }} aria-hidden="true" />}
    </div>
  );
};
