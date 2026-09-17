import React from 'react';
import {
  getThemePreset,
  type ThemeId,
  type ThemeMode,
  type ThemePreset,
} from './themeConfig';

export interface ThemeContextValue {
  themeId: ThemeId;
  theme: ThemePreset;
  themeMode: ThemeMode;
  setThemeId: (themeId: ThemeId) => void;
}

const defaultTheme = getThemePreset('omc-dark');

export const ThemeContext = React.createContext<ThemeContextValue>({
  themeId: defaultTheme.id,
  theme: defaultTheme,
  themeMode: defaultTheme.mode,
  setThemeId: () => undefined,
});

export function useThemeMode(): ThemeContextValue {
  return React.useContext(ThemeContext);
}
