import { palette, type ThemeMode } from '../theme/themeConfig';

export type ChartTone = 'accent' | 'success' | 'warn' | 'danger' | 'neutral';

export function sparkColor(mode: ThemeMode, tone: ChartTone): string {
  const colors = palette[mode];
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
