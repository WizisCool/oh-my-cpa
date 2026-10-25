import { createTheme, defaultLightTheme } from '@openuidev/react-ui';
import type { Theme } from '@openuidev/react-ui';

/**
 * OMC's look, given to OpenUI's own ThemeProvider as token overrides.
 *
 * Every value is a reference to the console's custom properties rather than a copied colour, so a
 * palette preset, a font choice or a mode switch repaints rendered interfaces with the rest of the
 * page. Tokens left out keep OpenUI's defaults: its translucent fills are drawn relative to the
 * mode, so they already sit on either ground.
 */

const BODY_FONT = defaultLightTheme.fontBody ?? '';
const CODE_FONT = defaultLightTheme.fontCode ?? '';

/**
 * OpenUI's typography shorthands (`textBodyDefault` and the rest) carry the font family inside a
 * finished `font:` value, so naming OMC's families in `fontBody` alone would leave every text style
 * in the default face. Each shorthand is rewritten with its family swapped and its size and weight
 * kept, which follows the library when it changes its scale.
 */
function consoleTypography(): Theme {
  const typography: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaultLightTheme)) {
    if (typeof value !== 'string' || !/^(font|text)[A-Z]/.test(key)) continue;
    if (CODE_FONT && value.includes(CODE_FONT)) typography[key] = value.replace(CODE_FONT, 'var(--font-mono)');
    else if (BODY_FONT && value.includes(BODY_FONT)) typography[key] = value.replace(BODY_FONT, 'var(--font-ui)');
  }
  return typography as Theme;
}

/** The colours the console names for itself; antd's tokens read the same steps (themeConfig.ts). */
const CONSOLE_COLORS: Theme = {
  background: 'var(--bg)',
  /* OpenUI's `foreground` is the surface its cards, tables and popovers stand on, not text: mapped
     to the page ground it would make every card vanish into the answer, so it takes the console's
     raised panel - the same fill OMC's own cards use, one step off the ground in either mode. */
  foreground: 'var(--surface)',
  textNeutralPrimary: 'var(--fg)',
  textNeutralSecondary: 'var(--fg-2)',
  textNeutralTertiary: 'var(--muted)',
  textNeutralLink: 'var(--accent)',
  textBrand: 'var(--accent)',
  textAccentPrimary: 'var(--accent-on)',
  textDangerPrimary: 'var(--danger)',
  textSuccessPrimary: 'var(--success)',
  textAlertPrimary: 'var(--warn)',
  interactiveAccentDefault: 'var(--accent-hover)',
  interactiveAccentHover: 'var(--accent-active)',
  interactiveAccentPressed: 'var(--accent-active)',
  interactiveDestructiveDefault: 'var(--danger)',
  borderDefault: 'var(--border-soft)',
  borderInteractive: 'var(--border)',
  borderAccent: 'var(--accent)',
  chatUserResponseText: 'var(--fg)',
};

const CONSOLE_TOKENS: Theme = { ...consoleTypography(), ...CONSOLE_COLORS };

/**
 * The theme for one palette. Charts read their colours as values - they measure a colour's
 * luminance to place labels - so the console's categorical series are passed resolved, not as
 * custom properties. OpenUI spreads a chart's series outward from the middle of its palette, so the
 * console's first series sits there and a single-series chart is drawn in it, as everywhere else.
 */
export function openUITheme(series: readonly string[]): Theme {
  const [first, second, third, fourth, fifth, ...rest] = series;
  const centred = [fifth, fourth, second, first, third, ...rest].filter((color): color is string => !!color);
  return createTheme({ ...CONSOLE_TOKENS, defaultChartPalette: centred });
}
