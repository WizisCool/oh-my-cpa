import React from 'react';
import wordmarkLight from '../../assets/brand/omc-wordmark-light.svg';
import wordmarkDark from '../../assets/brand/omc-wordmark-dark.svg';
import oLight from '../../assets/brand/omc-o-light.svg';
import oDark from '../../assets/brand/omc-o-dark.svg';
import { useThemeMode } from '../../theme/ThemeContext';

/**
 * The two drawings the brand is available in.
 *
 * `wordmark` spells "Oh-My-CPA" and is used wherever there is width for it. It is drawn on
 * an 875x148 canvas (about 5.9:1), so the collapsed rail cannot hold it at a legible size:
 * at 58px wide the letters would be about 5px tall. `o` is that same artwork's leading O,
 * cut from the wordmark rather than drawn separately, for exactly that case.
 *
 * Neither drawing carries a background, border or shadow, which is what lets both sit
 * directly on the shell's surfaces.
 */
export type BrandShape = 'wordmark' | 'o';

const ARTWORK: Record<BrandShape, { light: string; dark: string }> = {
  wordmark: { light: wordmarkLight, dark: wordmarkDark },
  o: { light: oLight, dark: oDark },
};

export interface BrandArtworkProps {
  shape: BrandShape;
  /** Rendered height in pixels; the width follows the artwork's own ratio. */
  height: number;
  className?: string;
  /**
   * Accessible name. Omit it where surrounding text already names the product, so the
   * letterforms are not announced twice; pass it where the drawing is the only name the
   * surface carries.
   */
  label?: string;
}

/**
 * Picks the drawing from the app's own theme state rather than from `prefers-color-scheme`,
 * because the console's theme is an explicit user setting that may contradict the operating
 * system. The favicon has no such state available to it, so that file selects between the
 * two drawings with a media query instead.
 */
export const BrandArtwork: React.FC<BrandArtworkProps> = ({ shape, height, className, label }) => {
  const { themeMode } = useThemeMode();
  const src = ARTWORK[shape][themeMode === 'light' ? 'light' : 'dark'];
  return (
    <img className={className} src={src} alt={label ?? ''} height={height} draggable={false} />
  );
};
