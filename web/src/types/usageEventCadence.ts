/**
 * The auto-refresh cadence is fixed, not configurable. The console used to offer
 * 5/10/30-second intervals, which is a setting nobody can evaluate without
 * watching the clock, and the operator only ever wants one of two answers: "keep
 * this current" or "stop moving".
 */
export const EVENT_AUTO_REFRESH_MS = 10_000;

/**
 * How long a manual sync may run before the page says it is still working.
 *
 * A sync pops CPA's queue and waits for the captured records to decode, so it
 * legitimately outlasts a read; a button that only spins gives no way to tell
 * "still draining a backlog" from "stuck on a hung gateway".
 */
export const EVENT_SYNC_NOTICE_MS = 1_500;

/**
 * How long the request console's search box waits after the last keystroke
 * before committing to the URL.
 *
 * Exported rather than inlined because the browser acceptance suite has to time
 * itself against this deadline: it asserts both that a keystroke lands once the
 * debounce elapses and that a keystroke queued when a clear-all arrives never
 * lands at all. A private copy in the test would silently keep asserting against
 * the old cadence after a change here.
 */
export const EVENT_SEARCH_DEBOUNCE_MS = 350;
