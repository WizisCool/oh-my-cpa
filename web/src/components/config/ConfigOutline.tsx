import React from 'react';

import { useT } from '../../i18n';
import { isMotionReduced } from '../../utils/motionPreference';
import { groupAnchorId } from './configSectionRenderers';
import { readOutline } from './configOutline';

export interface ConfigOutlineEntry {
  id: string;
  label: string;
  /** The card's settings, or under a search the ones that matched. */
  count: number;
  /** The card holds an unsaved edit. */
  isDirty: boolean;
}

/**
 * The second level of the panel's navigation: the section rail picks a section, this rail lists its
 * cards. Each row states the card rather than its place on the page - how many settings it holds and
 * whether one is unsaved. The card being read sits under a wash that slides between rows, the rows
 * whose cards are on screen take a brighter ink than the rest, and pointing at a row lights its card,
 * so the rail and the column read as one surface.
 */
export const ConfigOutline: React.FC<{ entries: ConfigOutlineEntry[] }> = ({ entries }) => {
  const t = useT();
  const navRef = React.useRef<HTMLElement>(null);
  const [currentId, setCurrentId] = React.useState<string | undefined>(entries[0]?.id);
  // The rows whose cards are on screen, first and last; a key so an unchanged view does not render.
  const [visibleRows, setVisibleRows] = React.useState('');
  // A pressed row stays current until the reader scrolls again: a card near the end cannot always be
  // scrolled to the top, and position alone would then name a different card than the one pressed.
  const pressedId = React.useRef<string | null>(null);
  const isShown = entries.length > 1;
  // The rows' counts and change marks follow every edit; the measuring only cares which cards exist.
  const cardIds = entries.map((entry) => entry.id).join('\n');

  React.useEffect(() => {
    const ids = cardIds.split('\n');
    pressedId.current = null;
    const scroller = navRef.current?.closest('.app-content');
    if (!scroller || !isShown) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = scroller.getBoundingClientRect();
      // The sticky toolbar covers the top of the scroller, so the visible band starts below it.
      const toolbarBottom = scroller.querySelector('.config-toolbar')?.getBoundingClientRect().bottom ?? bounds.top;
      const range = scroller.scrollHeight - scroller.clientHeight;
      const reading = readOutline(
        ids.map((id) => document.getElementById(groupAnchorId(id))?.getBoundingClientRect() ?? null),
        { top: Math.max(bounds.top, toolbarBottom), bottom: bounds.bottom },
        range > 0 ? scroller.scrollTop / range : 0,
      );
      const { visible } = reading;
      setVisibleRows(visible ? `${Math.floor(visible.from)}:${Math.ceil(visible.to) - 1}` : '');
      if (!pressedId.current) setCurrentId(ids[reading.current]);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const release = () => { pressedId.current = null; };
    measure();
    const resizes = new ResizeObserver(schedule);
    resizes.observe(scroller);
    scroller.addEventListener('scroll', schedule, { passive: true });
    for (const type of ['wheel', 'touchstart', 'keydown'] as const) window.addEventListener(type, release, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(frame);
      resizes.disconnect();
      scroller.removeEventListener('scroll', schedule);
      for (const type of ['wheel', 'touchstart', 'keydown'] as const) window.removeEventListener(type, release, { capture: true });
    };
  }, [cardIds, isShown]);

  // Pointing at a row lights its card. Set on the card itself, so the card needs no knowledge of the rail.
  const markTarget = (id: string, isMarked: boolean) => {
    document.getElementById(groupAnchorId(id))?.toggleAttribute('data-outline-target', isMarked);
  };
  React.useEffect(() => () => {
    for (const id of cardIds.split('\n')) markTarget(id, false);
  }, [cardIds]);

  if (!isShown) return null;
  const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === currentId));
  const [firstVisible, lastVisible] = visibleRows ? visibleRows.split(':').map(Number) : [-1, -2];

  return (
    <nav ref={navRef} className="config-outline" aria-label={t('cfg.outline_aria')}>
      <div className="config-outline-track" style={{ '--outline-current': currentIndex } as React.CSSProperties}>
        <div className="config-outline-wash" aria-hidden />
        <ol className="config-outline-list">
          {entries.map((entry, index) => {
            const isCurrent = index === currentIndex;
            const isOnScreen = index >= firstVisible && index <= lastVisible;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`config-outline-link${isCurrent ? ' is-current' : isOnScreen ? ' is-on-screen' : ''}`}
                  aria-current={isCurrent ? 'location' : undefined}
                  title={entry.label}
                  onPointerEnter={() => markTarget(entry.id, true)}
                  onPointerLeave={() => markTarget(entry.id, false)}
                  onFocus={() => markTarget(entry.id, true)}
                  onBlur={() => markTarget(entry.id, false)}
                  onClick={() => {
                    const target = document.getElementById(groupAnchorId(entry.id));
                    if (!target) return;
                    pressedId.current = entry.id;
                    setCurrentId(entry.id);
                    target.scrollIntoView({ behavior: isMotionReduced() ? 'auto' : 'smooth', block: 'start' });
                  }}
                >
                  <span className="config-outline-label">{entry.label}</span>
                  {entry.isDirty && <span className="config-change-dot" role="img" aria-label={t('cfg.source_dirty')} />}
                  <span className="config-outline-count">{entry.count}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
};

