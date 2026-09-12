import React from 'react';

/** The three outcomes the request console can express. 'all' is not a third
 *  verdict: it is the absence of one, so it gets the combined marker. */
export type ResultMarkerKind = 'success' | 'failed' | 'all';

/**
 * ResultMarker is the compact status indicator for filter controls.
 *
 * The list's Result column states the verdict in words inside a pill, which is
 * right for a row but too heavy for a filter segment. This shares the column's
 * *semantics* - the same success/danger tokens, the same square bullet - without
 * copying the pill, so "success" reads the same way in the filter as in the rows
 * it filters. 'all' is rendered as both bullets rather than a neutral dot,
 * because a filter set to everything is showing both outcomes, not a third one.
 */
export const ResultMarker: React.FC<{ kind: ResultMarkerKind }> = ({ kind }) => (
  <span className={`req-result-marker is-${kind}`} aria-hidden="true">
    {kind !== 'failed' && <i className="is-success" />}
    {kind !== 'success' && <i className="is-failed" />}
  </span>
);
