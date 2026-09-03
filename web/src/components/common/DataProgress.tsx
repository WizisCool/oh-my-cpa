import React from 'react';
import { useIsFetching } from '@tanstack/react-query';

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
 * DataProgress is the app-wide "request in flight" signal: one 2px bar pinned to
 * the top of the scrolling column.
 *
 * It exists so no view ever has to blank, dim or swap itself out to show that
 * data is loading. Being a single composited element, it costs no layout and no
 * repaint of the page beneath it.
 *
 * The 200ms delay suppresses the flash a fast request would otherwise cause:
 * a background refresh that resolves quickly never paints a bar at all.
 */
const SHOW_DELAY_MS = 200;

export const DataProgress: React.FC = () => {
  // Silent polls are in flight too, but counting them would make the bar blink
  // every few seconds — design.md keeps background refresh invisible.
  const fetching = useIsFetching({ predicate: (query) => query.meta?.silent !== true });
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (fetching === 0) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [fetching]);

  if (!visible) return null;
  return <div className="data-progress" role="progressbar" aria-busy="true" aria-label="loading" />;
};
