import React from 'react';
import type { Transition } from 'motion/react';
import { MotionScope, m, useSpringTransition } from './index';
import { keepsSomething } from './filterMove';

/**
 * The console's one filter transition: what a search, a filter or a status tile does to a list.
 * The list narrows and widens where it stands instead of being swapped - what remains glides to the
 * place the shorter list gives it, and what starts to match fades in where it now belongs.
 *
 * It is one move, not two: the rows the filter drops go at once and the rows that stay close the gap
 * as they travel there. Holding the dropped rows for a fade before closing up read as a pause, and
 * the operator was already typing again by the end of it.
 *
 * Only a change that keeps something is drawn as a move. Typing into a search narrows a list;
 * turning a page or opening another provider replaces it, and that has nothing to tie the two states
 * together, so the new rows are simply there. A list longer than a screenful is drawn as it is too:
 * see `GLIDING_LIMIT`.
 *
 * A list adopts this by wrapping its items in `FilterTransition` with the keys it draws, and
 * rendering each item with `FilterItem` - or, when the item has a `ref` of its own, as an `m`
 * element carrying `useFilterItemMotion()`. Items must keep their React keys, since those are what
 * the glide follows.
 */

interface FilterMove {
  /** The change keeps something of the previous list, so the two states are one list narrowing. */
  isMoving: boolean;
  /** The list is short enough to be watched moving; a longer one is drawn as it is. */
  isGliding: boolean;
}

/**
 * How many items a list may draw and still be watched moving. A filter that moves more rows than a
 * frame can measure asks the operator to wait for motion that explains little: what a long catalog
 * needs is the row it was looking for, at once. The limit is about measurement work - one frame's
 * worth - rather than about taste, and it keeps every list the console draws bounded.
 */
const GLIDING_LIMIT = 80;

const FilterMoveContext = React.createContext<FilterMove>({ isMoving: false, isGliding: false });

export interface FilterTransitionProps {
  /**
   * The keys drawn now, in the order they are drawn: the list's identity across a filter, a sort
   * and a read. The caller passes the same keys it gives its items.
   */
  itemKeys: readonly string[];
  children: React.ReactNode;
}

/**
 * One list's items, drawn as the list narrowing or widening. It renders nothing of its own, so it
 * can sit inside the `tbody`, `div` or grid the items belong to.
 *
 * Layout animation is loaded with the list rather than with the shell: a page that never filters
 * pays for neither the feature nor the chunk.
 */
export function FilterTransition({ itemKeys, children }: FilterTransitionProps) {
  // The keys drawn before this render, read during it: a change that keeps a key is a move, and a
  // change that keeps none is a replacement. It starts empty, so a list's first draw has nothing to
  // be a move from; recorded after the commit so a re-render that draws nothing new is not mistaken
  // for a move.
  const drawn = React.useRef<readonly string[]>([]);
  const isGliding = itemKeys.length <= GLIDING_LIMIT;
  const isMoving = isGliding && keepsSomething(drawn.current, itemKeys);
  React.useLayoutEffect(() => {
    drawn.current = itemKeys;
  });
  const move = React.useMemo(() => ({ isMoving, isGliding }), [isMoving, isGliding]);
  return (
    <MotionScope features="layout">
      <FilterMoveContext.Provider value={move}>{children}</FilterMoveContext.Provider>
    </MotionScope>
  );
}

/** A row that starts to match arrives at its place rather than appearing in it. */
const ARRIVING = { opacity: 0 } as const;
const ARRIVED = { opacity: 1 } as const;

export interface FilterItemMotionOptions {
  /**
   * The item is being moved by a hand - a reorder drag - so its place belongs to that pointer until
   * it is let go. Two animations writing one transform leave the row between both places.
   */
  isHeld?: boolean;
}

export interface FilterItemMotion {
  layout: 'position' | false;
  initial: typeof ARRIVING | false;
  animate: typeof ARRIVED;
  transition: Transition;
}

/**
 * The Motion props of one item in a `FilterTransition`, spread on the item's `m` element before its
 * own: a row keeps its `ref`, its handlers and its data attributes, and only its arrival and its
 * place are the transition's business.
 *
 * Position is animated, size is not: a row that takes its place in a shorter list keeps its own
 * height, and a table row cannot animate its box anyway.
 */
export function useFilterItemMotion({ isHeld = false }: FilterItemMotionOptions = {}): FilterItemMotion {
  const { isMoving, isGliding } = React.useContext(FilterMoveContext);
  const answer = useSpringTransition('answer');
  return React.useMemo(() => ({
    layout: isGliding && !isHeld ? 'position' : false,
    // The first read and a page change have nothing to fade in from; a row that starts to match a
    // search does.
    initial: isMoving ? ARRIVING : false,
    animate: ARRIVED,
    transition: answer,
  }), [isGliding, isHeld, isMoving, answer]);
}

const TAGS = { div: m.div, li: m.li, tr: m.tr, article: m.article, section: m.section } as const;

/** The elements a `FilterItem` can be: the ones a list of rows or cards is made of. */
export type FilterItemTag = keyof typeof TAGS;

export interface FilterItemProps
  extends Omit<React.HTMLAttributes<HTMLElement>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd' | 'onAnimationIteration'> {
  /** The element the item is: the tag its list is built from. */
  as?: FilterItemTag;
  children?: React.ReactNode;
}

/**
 * One item of a `FilterTransition`, for a list drawn by mapping its rows: the hook cannot be called
 * inside the map, so the item is a component instead. A row with a `ref` of its own - a sortable row
 * - calls `useFilterItemMotion()` and renders its own element.
 */
export const FilterItem = React.forwardRef<HTMLElement, FilterItemProps>(function FilterItem(
  { as = 'div', children, ...rest }, ref,
) {
  const filterMotion = useFilterItemMotion();
  const Tag = TAGS[as] as unknown as React.ForwardRefExoticComponent<
    Omit<React.HTMLAttributes<HTMLElement>, 'ref'> & React.RefAttributes<HTMLElement>
  >;
  return <Tag ref={ref} {...filterMotion} {...rest}>{children}</Tag>;
});
