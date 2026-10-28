import React from 'react';
import { useT } from '../../i18n';
import dayjs from '../../utils/time';
import type { InsightsCompareWindow } from '../../types/insights';

/**
 * Names the window a figure is measured against, for its title.
 *
 * The title carries the instants rather than the words "the previous period", because a running
 * window is compared against only the stretch of the previous one it has reached: "today" so far
 * against yesterday up to this hour. The same sentence is the page's footnote, so a reader who
 * hovers a change and a reader who scrolls to the bottom are told the same thing.
 */
export function useCompareWindowLabel(): (compare: InsightsCompareWindow) => string {
  const t = useT();
  return React.useCallback((compare: InsightsCompareWindow) => {
    const from = dayjs(compare.from);
    const to = dayjs(compare.to);
    // A window reaching back past the new year would otherwise name the same month and day at both
    // ends; the year is only worth its width when the two ends disagree on it.
    const layout = from.year() === to.year() ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm';
    return t('insights.compare_window', { from: from.format(layout), to: to.format(layout) });
  }, [t]);
}
