import React from 'react';
import { Line } from '@ant-design/charts';
import dayjs from 'dayjs';
import { useThemeMode } from '../theme/ThemeContext';
import { seriesColorRange, seriesDomainKey } from './chartTheme';
import { MONO_FONT_STACK, palette } from '../theme/themeConfig';
import { formatTokens as formatTokensStyled, formatTokensFull } from '../types/tokenDisplay';
import type { DashboardModelUsage } from '../types/dashboardModels';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';

export interface ModelTokenTrendProps {
  /** Ranked groups, as the endpoint returned them. Order is the colour assignment. */
  groups: DashboardModelUsage[];
  /** The label for the folded remainder, already translated by the caller. */
  foldedLabel: string;
  /** The unit word printed beside a tooltip's value, translated by the caller. */
  tokenUnitLabel?: string;
  height?: number;
}

/**
 * ModelTokenTrend draws each group's token volume over the window as one line.
 *
 * **Why the mark is a line and not an area.** The KPI tiles above use an area because their series is
 * a fixed zero-filled grid where a quiet stretch is a *measured* zero, and an area carries that down
 * to the baseline so an empty stretch is distinguishable from an unmeasured one. Here six groups share
 * one plot, and six overlapping translucent fills stack into a mud that hides whichever model is
 * underneath - which is the reading the panel exists to provide. Lines separate; fills compound.
 *
 * **Why the legend is not the library's.** It is rendered by the panels as DOM beside the chart, for
 * two reasons. G2's legend is built from canvas-adjacent DOM with its own type scale, so it would be
 * the one place in the console not set in the mono stack; and the colour of a group has to be the same
 * in the trend's legend and in the usage list, which is only guaranteed if one list produces both. The
 * mark therefore draws no legend of its own.
 *
 * Animation is off. A mark that eases between two revisions reads as a repaint rather than as new
 * data, and the geometry swaps whenever the window or the ranking changes.
 */
export const ModelTokenTrend: React.FC<ModelTokenTrendProps> = ({ groups, foldedLabel, tokenUnitLabel = '', height = 260 }) => {
  const { themeMode } = useThemeMode();
  const { style: tokenStyle } = useTokenDisplayStyle();
  // The chart's own colours come from the palette, never from a literal.
  const colors = palette[themeMode];

  // Domain and range are passed explicitly rather than left to the library's default palette, and the
  // domain is a stable *key* per group rather than the display label or an array position. What that
  // buys is agreement, not stability: both panels colour from the same ranked response, so a model's
  // line and its ring slice cannot be two different hues. A model's colour does follow its rank, so it
  // can change when the ranking does - which the legend beside it always states.
  const domain = React.useMemo(() => groups.map(seriesDomainKey), [groups]);
  const range = React.useMemo(() => seriesColorRange(themeMode, groups), [themeMode, groups]);

  const labelOf = React.useCallback(
    (key: string) => (key === 'folded' ? foldedLabel : key.replace(/^model:/, '')),
    [foldedLabel],
  );

  // The display label per group, index-aligned with the series. G2's shared tooltip reports one entry
  // per series in series order, so this is what turns its output into names.
  const groupLabels = React.useMemo(() => groups.map((group) => labelOf(seriesDomainKey(group))), [groups, labelOf]);

  // One row per group per bucket. The trellis is built here rather than asking the library to melt
  // six series: the groups already share one bucket grid, so the long form is a flat map and the
  // colour key travels with every point.
  const data = React.useMemo(() => {
    const rows: Array<{ series: string; bucket: string; at: number; tokens: number }> = [];
    for (const group of groups) {
      const key = seriesDomainKey(group);
      for (const point of group.series) {
        rows.push({ series: key, bucket: String(point.t), at: point.t, tokens: point.tokens });
      }
    }
    return rows;
  }, [groups]);

  // The bucket axis, in order. The domain is every bucket of the window grid - taken from the
  // longest series, which is all of them, since the groups share one grid - so a bucket in which
  // every model was quiet still occupies its place on the axis instead of being collapsed out of
  // the plot.
  const buckets = React.useMemo(() => {
    let longest: string[] = [];
    for (const group of groups) {
      if (group.series.length > longest.length) longest = group.series.map((point) => String(point.t));
    }
    return longest;
  }, [groups]);

  // The label format follows the span, because the tick is the only place the window's extent is
  // stated. `MM-DD HH:mm` is right for a day or less, where the time of day is what a reader places a
  // spike by; over a longer window the time of day is noise and the date is the coordinate. It also
  // keeps the label narrow enough that the outermost tick still fits inside the card's padding: the
  // last tick sits on the plot's right edge, so half its label hangs into the gutter, and a 12-glyph
  // label overhung a 16px gutter while a 6-glyph one does not.
  const labelFormat = React.useMemo(() => {
    if (buckets.length < 2) return 'MM-DD HH:mm';
    const span = Number(buckets[buckets.length - 1]) - Number(buckets[0]);
    return span > 24 * 60 * 60 * 1000 ? 'MM-DD' : 'HH:mm';
  }, [buckets]);

  // Ticks are picked by position rather than left to the layout. A band scale gives every bucket its
  // own tick, and at the dashboard's ~48 buckets that printed the same date forty-eight times across a
  // half-width card. Four labels is what the card can carry without two of them touching, and choosing
  // them here - rather than letting an auto-hide heuristic drop arbitrary ones - is what keeps the
  // first and last bucket labelled, which are the two a reader actually places the window with.
  const tickFilter = React.useMemo(() => {
    if (buckets.length === 0) return undefined;
    const wanted = new Set<number>();
    const labels = Math.min(4, buckets.length);
    for (let index = 0; index < labels; index += 1) {
      const position = labels === 1 ? 0 : Math.round((index * (buckets.length - 1)) / (labels - 1));
      wanted.add(position);
    }
    return (_value: string, index: number) => wanted.has(index);
  }, [buckets]);

  const axis = React.useMemo(() => ({
    x: {
      // The tick values are the bucket keys, so the digits are parsed back for the label. The format
      // is the console's own rather than a locale-dependent date string.
      labelFormatter: (value: string) => dayjs(Number(value)).format(labelFormat),
      labelAutoRotate: false,
      // A canvas inherits no font and G2's themes declare no family, so without this the tick labels
      // were painted in the browser's default sans-serif - the one piece of text on the page not set in
      // the console's mono stack.
      labelFontFamily: MONO_FONT_STACK,
      labelFontSize: 10,
      // `fg2` rather than `muted`: these labels are data - the instants the window covers - and
      // `fg2` measures 8.10:1 on the dark card and 8.68:1 on the light one, clear of AA at 10px.
      labelFill: colors.fg2,
      // Two lines of the readout's own width: the labels are the widest thing on this axis and the
      // card is half the page wide, so the last one is pulled inside the frame rather than centred on
      // its bucket where half of it would hang past the padding.
      labelAlign: 'center',
      tickFilter,
      line: true,
      lineStroke: colors.border,
      tickStroke: colors.border,
    },
    y: {
      // No y-axis at all. The reading is the shape of each line against its own baseline - which
      // models rose, and when - and the numbers are in the tooltip and in the usage list beside it.
      // An axis would take the width the lines need to add a scale nothing on the card refers to, so
      // the floor is kept and the values are not.
      label: false,
      title: false,
      line: false,
      tick: false,
      grid: true,
    },
  }), [tickFilter, labelFormat, colors.fg2, colors.border]);

  if (data.length === 0) {
    return <div className="model-trend-empty" style={{ height }} aria-hidden="true" />;
  }

  return (
    <div className="model-trend" style={{ height }}>
      <Line
        data={data}
        xField="bucket"
        yField="tokens"
        colorField="series"
        height={height}
        autoFit
        animate={false}
        // A smoothed line rather than straight segments between buckets.
        //
        // G2 resolves this string to its `smooth` shape, which draws with `curveMonotoneX` - a monotone
        // cubic, not a plain Catmull-Rom spline. That distinction is why this is safe here: the series
        // are zero-filled, so most buckets sit exactly on the floor, and a non-monotone spline through
        // them would overshoot *below* the axis between points and draw a line where the data says zero.
        // A monotone curve cannot leave the range spanned by its own neighbours, so the floor stays the
        // floor. The KPI tiles above use the same shape for the same reason.
        shapeField="smooth"
        // No library legend: the legend is the app's DOM (see above), so the trend's colours stay in the
        // console's type scale and in the same assignment as the usage list.
        legend={false}
        scale={{
          // A band scale, not a linear one.
          //
          // The grid is uniform - every bucket is one bucket width from its neighbour - so both fit the
          // mark. What separates them is the edges. A linear scale on raw epoch milliseconds puts the
          // first and last bucket exactly on the plot's corners, so the axis labels under those corners
          // are cut by the card's gutter and the outermost marks are half-clipped. A band scale reserves
          // half a band at each end, which is what makes the first and last tick read inside the frame.
          x: { type: 'band', domain: buckets, paddingInner: 0, paddingOuter: 0.5 },
          y: { nice: false, domainMin: 0 },
          color: { domain, range },
        }}
        axis={axis}
        theme={{
          // Only the grid ink is set here, and the transparent fills keep the library from painting its
          // own plot background over the card. The axis labels are styled on `axis.x` above instead,
          // because that is the object the axis renderer reads for them.
          axis: {
            y: { line: false, gridStroke: colors.borderSoft },
          },
          view: {
            viewFill: 'transparent',
            plotFill: 'transparent',
            mainFill: 'transparent',
            contentFill: 'transparent',
          },
        }}
        // An explicit padding, not the library's `auto`. The automatic layout sizes the strips from the
        // axis labels' own measured bounds, and inside a fixed-height card the bottom strip came out
        // larger than the canvas, so the labels were painted past its edge and clipped to their top
        // halves. The reserved strips are: 10px of headroom, 32px below the plot for a 10px label with
        // its tick and spacing, and 40px at each side so the outermost tick's label - which is centred
        // on the plot's very edge - stays inside the card instead of being cut by the gutter.
        padding={[10, 40, 32, 40]}
        style={{ lineWidth: 1.6 }}
        state={{ active: { lineWidth: 2.4 } }}
        // The tooltip is configured on the *interaction*, not on the mark: G2 reads `render` from the
        // interaction's options, so a renderer placed in the mark's own `tooltip` spec is ignored and the
        // library's default template is used instead - which prints the raw domain value as each item's
        // name. A shared crosshair is what makes six lines readable at one instant: the readout lists
        // every series at the hovered bucket, which is how a reader compares models rather than tracing
        // one.
        interaction={{
          tooltip: {
            shared: true,
            crosshairs: true,
            render: (
              _event: unknown,
              context: { items?: Array<{ color?: string; value?: number }>; title?: string },
            ) => {
              const items = context?.items ?? [];
              if (items.length === 0) return '';
              // The bucket arrives as the group's title - a string of epoch milliseconds - not on each
              // item, so it is parsed from there. Falling back to "now" would print a time the mark is
              // not showing, which is worse than printing nothing.
              const bucketMS = Number(context?.title);
              const time = Number.isFinite(bucketMS) ? dayjs(bucketMS).format('MM-DD HH:mm') : '';
              const rows = items.map((item, index) => {
                const name = groupLabels[index] ?? '';
                const shape = `<span class="omc-tip-swatch" style="background:${item.color ?? 'transparent'}"></span>`;
                // The shared token layer's compact form: a tooltip that scans like the legend it
                // annotates, with the exact count in the accessible name below.
                // The visible value is abbreviated so the readout scans like the legend it
                // annotates; the exact count is the value's own title, because an abbreviation is
                // a rounded claim and must never be the only number on offer.
                const exact = `${formatTokensFull(item.value ?? 0)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}`;
                return `<div class="omc-tip-row">${shape}<span class="omc-tip-name">${escapeHtml(name)}</span><span class="omc-tip-value" title="${escapeHtml(exact)}">${formatTokensStyled(item.value ?? 0, tokenStyle)}${tokenUnitLabel ? ` ${tokenUnitLabel}` : ''}</span></div>`;
              });
              return `<div class="omc-tip"><div class="omc-tip-time">${time}</div>${rows.join('')}</div>`;
            },
          },
        }}
      />
    </div>
  );
};

/**
 * escapeHtml neutralizes a model name before it is interpolated into the tooltip's markup.
 *
 * Model names reach this panel from upstream payloads, so they are untrusted input, and the tooltip is
 * built as an HTML string. Without this a crafted model name could inject markup into the page.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { escapeHtml as escapeTooltipText };
