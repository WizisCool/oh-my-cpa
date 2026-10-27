/** A vertical extent in viewport pixels. */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * What the card nav shows for one scroll position. `visible` is in card units: `2.5` is halfway down
 * the third card, so a reading can say "the bottom of this card and the top of the next".
 */
export interface OutlineReading {
  current: number;
  visible: { from: number; to: number } | null;
}

/** Where the judging line sits at the top of the page, as a share of the visible band. */
const LINE_START = 0.3;

/**
 * readOutline decides which card is current and which part of the cards is on screen.
 *
 * The current card is the one under a judging line, and the line travels with the scroll: 30% down
 * the visible band at the top of the page, the band's bottom edge at the end. A fixed line near the
 * top keeps a tall card current while the next one already fills the view, and can never reach the
 * short cards at the end; a travelling line hands over once a card holds most of the view and gives
 * every card its turn by the time the page runs out.
 *
 * `progress` is the scroller's position from 0 (top) to 1 (end). A card whose element is missing is
 * passed as `null` and treated as off screen.
 */
export function readOutline(cards: (Span | null)[], view: Span, progress: number): OutlineReading {
  const height = view.bottom - view.top;
  const line = view.top + height * (LINE_START + (1 - LINE_START) * Math.min(1, Math.max(0, progress)));
  let current = 0;
  let from: number | null = null;
  let to = 0;
  cards.forEach((card, index) => {
    if (!card) return;
    if (card.top <= line) current = index;
    const size = card.bottom - card.top;
    if (size <= 0 || card.bottom <= view.top || card.top >= view.bottom) return;
    const start = Math.max(0, (view.top - card.top) / size);
    const end = Math.min(1, (view.bottom - card.top) / size);
    from ??= index + start;
    to = index + end;
  });
  return { current, visible: from === null ? null : { from, to } };
}
