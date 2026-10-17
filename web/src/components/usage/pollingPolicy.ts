/**
 * Whether the list is showing a view the reader has not seen the data for yet.
 *
 * The reader's *identity* is compared (the committed filters plus the page), not
 * the resolved window. A poll advances the sliding window every ten seconds, which
 * reads as placeholder data and used to flip this every few seconds - so the
 * updating label and the stale-data note blinked continuously while nothing the
 * reader had chosen had changed.
 */
export function isViewChange(fetchedIdentity: string, queryIdentity: string): boolean {
  return fetchedIdentity !== queryIdentity;
}

/**
 * Whether the displayed page should carry the stale-data warning.
 *
 * Either the reader has moved to a different view and the rows on screen still
 * belong to the previous one, or the query failed and what is on screen is the last
 * successful page rather than an answer to the current request.
 */
export function isListStale({
  isViewChange: isViewChanged,
  isError,
  hasLastPage,
}: {
  isViewChange: boolean;
  isError: boolean;
  hasLastPage: boolean;
}): boolean {
  return isViewChanged || (isError && hasLastPage);
}

/**
 * The number of records that have arrived while the reader is holding a page.
 *
 * Only meaningful while rows are held: at the live edge the arriving records are
 * simply part of the list. The count comes from the server, anchored on the newest
 * row id the reader is holding, because diffing the loaded rows would under-report
 * - the list is ordered by request time, so a request that started earlier and
 * finished later lands below the first page instead of at the top of it.
 */
export function pendingArrivalCount(heldItemsLength: number, arrivedCount: number | undefined): number {
  if (heldItemsLength === 0) return 0;
  return arrivedCount ?? 0;
}
