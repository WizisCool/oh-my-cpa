import React from 'react';
import type { ThemeMode } from './themeConfig';

export interface ThemeContextValue {
  themeMode: ThemeMode;
  toggleTheme: () => void;
}

export const ThemeContext = React.createContext<ThemeContextValue>({
  themeMode: 'dark',
  toggleTheme: () => undefined,
});

export function useThemeMode(): ThemeContextValue {
  return React.useContext(ThemeContext);
}
