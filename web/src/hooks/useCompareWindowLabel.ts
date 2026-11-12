import React from 'react';
import { useT } from '../i18n';
import dayjs from '../utils/time';
import { formatCompareWindowBounds, type CompareWindowBounds } from '../types/insightsFormat';

/**
 * Names the window a figure is measured against, for its title.
 *
 * The title carries the instants rather than the words "the previous period", because a calendar
 * window still running is compared against only the stretch of the previous one it has reached:
 * "today" so far against yesterday up to this hour. The same sentence is the page's footnote, so a
 * reader who hovers a change and a reader who scrolls to the bottom are told the same thing.
 */
export function useCompareWindowLabel(): (compare: CompareWindowBounds) => string {
  const t = useT();
  return React.useCallback((compare: CompareWindowBounds) => {
    const bounds = formatCompareWindowBounds(compare, dayjs().year(), (ms, layout) => dayjs(ms).format(layout), (ms) => dayjs(ms).year());
    return t('insights.compare_window', bounds);
  }, [t]);
}
