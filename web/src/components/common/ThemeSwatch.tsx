import React from 'react';
import type { ThemePalette } from '../../theme/palette';

/**
 * The palette bands a swatch paints, in the order they are drawn.
 *
 * Four channels rather than the whole palette: background, elevated surface,
 * accent and success are the steps an operator recognises a preset by, and a
 * preview that showed every token would be a legend, not a mark.
 */
const THEME_SWATCH_CHANNELS = ['bg', 'surface', 'accent', 'success'] as const;

/**
 * ThemeSwatch previews one theme preset as its palette bands.
 *
 * The colour is read from the preset itself rather than from CSS variables: the
 * swatch's whole job is to show a theme other than the active one, so it cannot
 * inherit the console's current paint. Shared by the header's theme menu and the
 * settings page's preset cards so a new preset reaches both previews at once.
 */
export const ThemeSwatch: React.FC<{ palette: ThemePalette; className?: string }> = ({
  palette,
  className,
}) => (
  <span className={className ? `theme-swatch ${className}` : 'theme-swatch'} aria-hidden="true">
    {THEME_SWATCH_CHANNELS.map((channel) => (
      <span key={channel} style={{ background: palette[channel] }} />
    ))}
  </span>
);