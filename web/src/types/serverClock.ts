/**
 * The server's clock, as this browser can read it.
 *
 * A turn and its calls are stamped by the server, and a timer that counts from such a stamp
 * against `Date.now()` is only right while the two clocks agree. A browser a minute behind its
 * server showed a recovered run's elapsed time as zero for that minute. The `Date` header every
 * response carries is the one reading of the server's clock that needs no endpoint of its own.
 *
 * The header is whole seconds, so a reading is the middle of its second and good to about half of
 * one. Clocks that agree within `AGREEMENT_MS` are treated as agreeing exactly: correcting a
 * synchronised pair by the header's own rounding would add an error where there was none.
 */
const AGREEMENT_MS = 1500;

let offsetMS = 0;

/**
 * Server time minus browser time from one response, or undefined when it carries no readable date.
 * Undefined is not zero: an unreadable header says nothing about the clocks.
 */
export function clockOffset(dateHeader: string | null, receivedAtMS: number): number | undefined {
  const serverMS = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (!Number.isFinite(serverMS)) return undefined;
  const offset = serverMS + 500 - receivedAtMS;
  return Math.abs(offset) <= AGREEMENT_MS ? 0 : offset;
}

export function observeServerClock(response: Response, receivedAtMS = Date.now()): void {
  const offset = clockOffset(response.headers.get('date'), receivedAtMS);
  // Only a readable date is a reading; the last measurement stands until another one arrives.
  if (offset !== undefined) offsetMS = offset;
}

/** A server timestamp on this browser's clock, so it can be counted from with `Date.now()`. */
export function toBrowserTime(serverMS: number): number {
  return serverMS - offsetMS;
}
