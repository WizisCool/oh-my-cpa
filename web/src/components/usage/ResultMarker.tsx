import React from 'react';

/** The two verdicts the filter controls can name. 'all' is not a third verdict:
 *  it is the absence of one, so it gets no marker at all. */
export type ResultMarkerKind = 'success' | 'failed';

/**
 * ResultMarker is the compact status indicator for the result filter controls.
 *
 * The list's Result column states the verdict in words inside a pill, which is
 * right for a row but too heavy for a filter segment. This shares the column's
 * *semantics* - the same success/danger tokens, the same square bullet - without
 * copying the pill, so "success" reads the same way in the filter as in the rows
 * it filters. Only the verdicts get one: a title with both bullets would read as
 * a third, combined outcome rather than as the absence of a filter.
 */
export const ResultMarker: React.FC<{ kind: ResultMarkerKind }> = ({ kind }) => (
  <i className={`req-result-marker is-${kind}`} aria-hidden="true" />
);
