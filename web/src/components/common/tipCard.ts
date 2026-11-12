/**
 * A tooltip that says more than one thing, as data: a heading, label/value rows and quiet notes.
 *
 * Dense lists hang their hints on plain attributes (`data-tip`, `data-request-tooltip`) so a row
 * mounts no React wrapper; one delegated layer reads the hovered element. A structured hint travels
 * the same way, as JSON beside the attribute, and the layer draws it with `TooltipReadout` - the
 * one layout every tooltip with more than one fact uses. The attribute itself keeps a plain reading
 * of the card: it is what decides that the element has a hint at all.
 */
export type TipTone = 'up' | 'down' | 'warn' | 'danger' | 'muted';

export interface TipRow {
  label?: string;
  value: string;
  /** Recolours the value: a rise or fall, a degraded or failing reading, or a figure that is only context. */
  tone?: TipTone;
}

export interface TipCard {
  heading?: string;
  rows?: readonly TipRow[];
  /** Quiet sentences under the rows: how a figure was derived, or a caveat. One line each. */
  notes?: readonly (string | false | null | undefined)[];
}

/** The card's text, one fact per line: the attribute value and the reading a test can match. */
export function tipCardText(card: TipCard): string {
  return [
    card.heading,
    ...(card.rows ?? []).map((row) => (row.label ? `${row.label}: ${row.value}` : row.value)),
    ...(card.notes ?? []),
  ].filter((line): line is string => typeof line === 'string' && line !== '').join('\n');
}

function isEmpty(card: TipCard): boolean {
  return !card.heading && !card.rows?.length && !card.notes?.some(Boolean);
}

/**
 * Spreads a card onto an element for the document-level `data-tip` layer:
 * `<span {...tipCard({ heading, rows })}>`. An empty card spreads nothing, so the element has no hint.
 */
export function tipCard(card: TipCard | null | undefined): { 'data-tip'?: string; 'data-tip-card'?: string } {
  if (!card || isEmpty(card)) return {};
  return { 'data-tip': tipCardText(card), 'data-tip-card': JSON.stringify(card) };
}

/** Reads the card a delegated layer found on an element; malformed JSON reads as no card. */
export function readTipCard(raw: string | undefined): TipCard | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TipCard) : null;
  } catch {
    return null;
  }
}
