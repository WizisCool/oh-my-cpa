import React from 'react';
import { Button, Empty } from 'antd';
import { useT } from '../../i18n';
import { ParagraphPlaceholder } from '../common/Placeholder';

/** RENDER_CHUNK is how many matching rows are mounted at a time. */
const RENDER_CHUNK = 300;

interface LogListProps<T> {
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, isOpen: boolean) => React.ReactNode;
  isLoading: boolean;
  emptyText: string;
  /** Rendered above the rows, inside the scroller - a marker such as "records were lost". */
  header?: React.ReactNode;
}

/**
 * LogList is the scrolling tail both log sources render into.
 *
 * It follows the newest line until the reader scrolls away, then offers the way back
 * instead of yanking them down mid-read. Only the newest chunk is mounted: a tail of ten
 * thousand lines is searched in memory, but painting all of them would stall the page
 * on every poll.
 */
export function LogList<T>({ items, itemKey, renderItem, isLoading, emptyText, header }: LogListProps<T>) {
  const t = useT();
  const [visibleCount, setVisibleCount] = React.useState(RENDER_CHUNK);
  // `isPinned` is state, not a ref: the "back to the newest line" affordance has
  // to appear the moment the reader scrolls away, and a ref cannot re-render.
  const [isPinned, setIsPinned] = React.useState(true);
  const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  const listRef = React.useRef<HTMLDivElement>(null);

  const offset = Math.max(0, items.length - visibleCount);
  const mounted = items.slice(offset);

  React.useEffect(() => {
    const node = listRef.current;
    if (!node || !isPinned) return;
    node.scrollTop = node.scrollHeight;
  }, [mounted, isPinned]);

  const toggle = (key: string) => {
    setOpenKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div
        className="log-list"
        ref={listRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          setIsPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
        }}
      >
        {header}
        {isLoading ? (
          <ParagraphPlaceholder rows={8} className="log-state" />
        ) : mounted.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
        ) : (
          <>
            {offset > 0 && (
              <button type="button" className="log-more" onClick={() => setVisibleCount((count) => count + RENDER_CHUNK * 2)}>
                {t('logs.show_more', { n: offset })}
              </button>
            )}
            {mounted.map((item, index) => {
              const key = itemKey(item, offset + index);
              const isOpen = openKeys.has(key);
              return (
                <div
                  key={key}
                  className={`log-row${isOpen ? ' is-open' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => toggle(key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggle(key);
                    }
                  }}
                >
                  {renderItem(item, isOpen)}
                </div>
              );
            })}
          </>
        )}
      </div>
      {!isPinned && items.length > 0 && (
        <Button className="logs-jump" size="small" onClick={() => setIsPinned(true)}>
          {t('logs.jump_latest')}
        </Button>
      )}
    </>
  );
}
