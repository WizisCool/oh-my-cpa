import type { ThemePalette } from '../theme/themeConfig';

export type ChartTone = 'accent' | 'success' | 'warn' | 'danger' | 'neutral';

export function sparkColor(colors: ThemePalette, tone: ChartTone): string {
  switch (tone) {
    case 'success':
      return colors.success;
    case 'warn':
      return colors.warn;
    case 'danger':
      return colors.danger;
    case 'neutral':
      return colors.muted;
    case 'accent':
    default:
      return colors.accent;
  }
}

/**
 * Categorical series identities, in the order a legend reads them.
 *
 * A *series* is a category, not a verdict, which is what makes this the one palette in the app whose
 * hues are decoration. Everything else here resolves to a semantic token, where green means healthy and
 * red means failed; a model's colour cannot mean anything, because the model list is whatever the
 * deployment happens to serve. Borrowing the status hues for it would be worse than decoration - a green
 * line labelled "model B" beside a green pip that means "healthy" makes both unreadable - so the series
 * families are their own. See the measured bounds in docs/design.md and
 * docs/adr/0006-categorical-series-palette.md.
 *
 * A slot is a *rank*, not a model. Colour is assigned from the ranked list both dashboard panels share,
 * which is what guarantees a group's line and its ring slice are the same hue; it also means a group's
 * colour follows its rank, so it can change when the ranking does. The family is fixed per slot across
 * themes, so only the lightness step moves when the operator switches theme.
 */
export const SERIES_SLOTS = 6;

/**
 * seriesColor resolves one slot to a palette value.
 *
 * The index is taken modulo the slot count rather than clamped, so a seventh series folds back to
 * the first identity instead of vanishing or painting black. Nothing in the app currently asks for
 * more than six - the ranking keeps at most five named models plus a remainder - but a colour
 * function that silently returns `undefined` past its end is a chart drawn in the wrong colour, and
 * that is worse than one drawn in a repeated colour.
 */
export function seriesColor(palette: ThemePalette, index: number): string {
  const slots = palette.series;
  const slot = ((Math.trunc(index) % SERIES_SLOTS) + SERIES_SLOTS) % SERIES_SLOTS;
  return slots[slot] ?? slots[0] ?? palette.accent;
}

/** The trend's plot floor and the usage ring's unfilled track. */
export function seriesTrackColor(palette: ThemePalette): string {
  return palette.seriesTrack;
}

/**
 * seriesDomain maps legend entries to their slot.
 *
 * The domain is a *key*, never the displayed label or the array position. Position is what a chart
 * library would use by default, and it is wrong here twice over: the ranking is by volume, so a
 * model's position moves between polls and its colour would move with it, and the folded remainder
 * is always last, so it would keep one colour while the models above it reshuffled. Grouping by the
 * folded discriminator rather than by the model name also keeps a real model whose name happens to
 * equal the remainder's label from taking the remainder's colour.
 */
export function seriesDomainKey(entry: { folded: boolean; model: string }): string {
  return entry.folded ? 'folded' : `model:${entry.model}`;
}

/**
 * seriesColorRange builds the range that pairs with `seriesDomainKey`'s domain.
 *
 * The range is generated from the domain's own order rather than handed to the library as a list of
 * colours to cycle, so slot assignment is decided here - in one place, testable without a browser -
 * instead of being a library's internal ordering that could change under us.
 */
export function seriesColorRange(palette: ThemePalette, entries: Array<{ folded: boolean; model: string }>): string[] {
  return entries.map((_, index) => seriesColor(palette, index));
}
