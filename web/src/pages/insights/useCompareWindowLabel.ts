import React from 'react';
import { useT } from '../../i18n';
import dayjs from '../../utils/time';
import type { InsightsCompareWindow } from '../../types/insights';

/**
 * Names the window a figure is measured against, for its title.
 *
 * The title carries the instants rather than the words "the previous period", because a calendar
 * window still running is compared against only the stretch of the previous one it has reached:
 * "today" so far against yesterday up to this hour. The same sentence is the page's footnote, so a
 * reader who hovers a change and a reader who scrolls to the bottom are told the same thing.
 */
export function useCompareWindowLabel(): (compare: InsightsCompareWindow) => string {
  const t = useT();
  return React.useCallback((compare: InsightsCompareWindow) => {
    const from = dayjs(compare.from);
    const to = dayjs(compare.to);
    // The year is only worth its width inside the current one, and then only when both ends agree on
    // it: a comparison reaching into an earlier year would otherwise read as this year's dates.
    const layout = from.year() === to.year() && from.year() === dayjs().year() ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm';
    return t('insights.compare_window', { from: from.format(layout), to: to.format(layout) });
  }, [t]);
}
