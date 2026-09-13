/**
 * Whether one tick of the request list's auto-refresh poll should run.
 *
 * Auto-refresh is a fixed 10-second wall-clock cadence with three reasons to skip
 * a tick instead of queueing one. Skipping matters more than it looks: a poll that
 * queued would fire the moment a slow query resolved, so a slow gateway would
 * produce a burst of reads against data the first one had not finished reading.
 * The rule is therefore "read this list every ten seconds if there is a reader who
 * can see it and nothing better is already doing it", not "read it ten seconds
 * after the last response", which is the cadence drift that naming the in-flight
 * flag in a React dependency list used to reintroduce.
 */

export interface PollDecisionInput {
  /** The operator's on/off switch. Off means no ticks at all, not slower ones. */
  isAutoRefresh: boolean;
  /**
   * The page's own visibility. A hidden tab is a reader who is not watching, so a
   * tick is spent on nobody. The list is still correct when the tab returns: the
   * next tick reads the window it is showing.
   */
  isVisible: boolean;
  /** A list query is already in flight. */
  isFetching: boolean;
  /**
   * A manual sync owns the next refresh. A poll landing on top of it would only
   * add a read of the data the sync is about to replace.
   */
  isSyncing: boolean;
}

export function shouldPoll({ isAutoRefresh, isVisible, isFetching, isSyncing }: PollDecisionInput): boolean {
  if (!isAutoRefresh) return false;
  if (!isVisible) return false;
  if (isFetching) return false;
  if (isSyncing) return false;
  return true;
}

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
