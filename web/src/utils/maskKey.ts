/** The filler a display mask uses; identical to the server's `security.MaskRun`. */
const MASK_RUN = '••••••••';

/**
 * maskKeyText renders the console's one caller-key mask shape.
 *
 * It mirrors `security.MaskSecret` in `internal/security/security.go` branch for
 * branch on purpose: the key list computes a mask from the value in hand, while
 * the request list reads the mask that was ingested with the event, and two
 * shapes for one key would make the same gateway key look like two different
 * keys depending on which page it is read on. The thresholds (20 and 12 runes),
 * the visible head and tail, and the constant filler are therefore not free
 * parameters here — they are a second implementation of a shape the server
 * already decided.
 *
 * The filler is a constant length, so a mask never carries the secret's exact
 * length. Keys long enough for edges to identify them (every key this console
 * generates is `sk-cpa-` plus 32 hex characters) all render the same 20 glyphs,
 * which is also what keeps the reveal toggle from resizing the row.
 *
 * Code points rather than UTF-16 units, matching the Go implementation's runes.
 */
export function maskKeyText(key?: string): string {
  const trimmed = (key || '').trim();
  if (!trimmed) return '';
  const runes = Array.from(trimmed);
  if (runes.length >= 20) return runes.slice(0, 8).join('') + MASK_RUN + runes.slice(-4).join('');
  if (runes.length >= 12) return runes.slice(0, 4).join('') + MASK_RUN + runes.slice(-2).join('');
  return MASK_RUN;
}