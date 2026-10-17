import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '../../i18n';
import { progressTasks } from '../../utils/progressTasks';
import { mergeProgressSources, queryProgressSource } from '../../utils/progressSources';
import { ProgressBar } from './ProgressBar';

// v5 types `meta` through Register, so this declares app-wide query metadata.
// `silent` keeps a read the bar cannot classify by state from raising it (`isQueryProgressWork`).
declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      silent?: boolean;
    };
  }
}

/**
 * DataProgress is the app-wide "work in flight" signal: one 2px bar pinned under the header, whose
 * length hints at the page's reads and module downloads, while a moving marker signals waiting.
 *
 * It exists so no view ever has to blank, dim or swap itself out to show that data is loading.
 */
export const DataProgress: React.FC = () => {
  const t = useT();
  const queryClient = useQueryClient();
  const source = React.useMemo(
    () => mergeProgressSources(queryProgressSource(queryClient.getQueryCache()), progressTasks),
    [queryClient],
  );
  return <ProgressBar source={source} label={t('common.loading')} className="data-progress" />;
};
