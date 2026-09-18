import React from 'react';
import { brandDrawing, brandMarkup, type BrandShape } from '../../assets/brand/markup';
import { useTheme } from '../../theme/ThemeContext';

/**
 * The two drawings the brand is available in.
 *
 * `wordmark` spells "Oh-My-CPA" and is used wherever there is width for it. It is drawn on an
 * 875x148 canvas (about 5.9:1), so the collapsed rail cannot hold it at a legible size: at 58px
 * wide the letters would be about 5px tall. `o` is that same artwork's leading O, cut from the
 * wordmark rather than drawn separately, for exactly that case.
 *
 * Neither drawing carries a background, border or shadow, which is what lets both sit directly on
 * the shell's surfaces.
 */
export type { BrandShape };

export interface BrandArtworkProps {
  shape: BrandShape;
  /** Rendered height in pixels; the width follows the artwork's own ratio. */
  height: number;
  className?: string;
  /**
   * Accessible name. Omit it where surrounding text already names the product, so the letterforms
   * are not announced twice; pass it where the drawing is the only name the surface carries.
   */
  label?: string;
}

/**
 * Draws the brand artwork inline, in the active theme's own colours.
 *
 * Inline rather than `<img src>` because the accent inside the wordmark is a theme token, and an
 * `<img>`-loaded SVG cannot see the page's custom properties - its blue would be whatever the file
 * happened to contain. That is not hypothetical: the shipped files carried a hand-picked `#00A3FD`
 * next to an accent of `#007AFF`, so the logo's blue and the rest of the console's blue were already
 * two different colours.
 *
 * The colours come from the same `palette` the theme config mirrors, and the theme comes from the
 * console's own state rather than from `prefers-color-scheme`, because that setting is an explicit
 * user choice that may contradict the operating system. The favicon is the one case that cannot work
 * this way - the browser fetches it outside the app - so it keeps a media query of its own.
 */
export const BrandArtwork: React.FC<BrandArtworkProps> = ({ shape, height, className, label }) => {
  const { theme } = useTheme();
  const colors = theme.palette;
  const { viewBox, width, height: canvasHeight } = brandDrawing(shape);
  const markup = brandMarkup(shape, { ink: colors.fg, accent: colors.accent });

  return (
    <svg
      className={className}
      viewBox={viewBox}
      height={height}
      // The width follows the artwork's own ratio, so a caller only ever picks the height and the
      // drawing never stretches.
      width={Math.round((height * width) / canvasHeight)}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      // The markup is generated from a fixed, local drawing and two palette values - never from user
      // input - so there is nothing here that could carry a script.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
};
