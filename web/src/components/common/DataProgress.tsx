import React from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useT } from '../../i18n';
import { progressTasks, type ProgressSource } from '../../utils/progressTasks';
import { mergeProgressSources } from '../../utils/progressSources';
import { ProgressBar } from './ProgressBar';

// v5 types `meta` through Register, so this declares app-wide query metadata.
// `silent` is what keeps a background poll from raising the progress bar.
declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      silent?: boolean;
    };
  }
}

/**
 * The queries the bar counts: every one fetching, except the silent polls. Counting a poll would
 * raise the bar every few seconds, and design.md keeps background refresh invisible.
 */
function queryProgressSource(queryClient: QueryClient): ProgressSource {
  const cache = queryClient.getQueryCache();
  return {
    read() {
      const ids = new Set<string>();
      for (const query of cache.getAll()) {
        if (query.state.fetchStatus === 'fetching' && query.meta?.silent !== true) ids.add(`query:${query.queryHash}`);
      }
      return ids;
    },
    subscribe: (listener) => cache.subscribe(listener),
  };
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
    () => mergeProgressSources(queryProgressSource(queryClient), progressTasks),
    [queryClient],
  );
  return <ProgressBar source={source} label={t('common.loading')} className="data-progress" />;
};
