
import { Button, Select, Tooltip } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';

import { useT } from '../../i18n';

interface RequestPaginationProps {
  /** The last successful page is on screen while a newer one is in flight. */
  stale: boolean;
  isPlaceholderData: boolean;
  /** 1-based, counted from the cursor stack the reader has walked. */
  page: number;
  count: number;
  limit: number;
  isFetching: boolean;
  isError: boolean;
  hasMore: boolean;
  hasNextCursor: boolean;
  hasPrev: boolean;
  onPageSizeChange: (limit: number) => void;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * The request list's footer: which page is on screen, how big a page is, and the
 * two cursor steps.
 *
 * Paging is by cursor rather than by offset, so "previous" is the reader walking
 * back down the stack they already walked up: the control states come from that
 * stack, not from a total count the list never asks the server for.
 */
export function RequestPagination({
  stale,
  isPlaceholderData,
  page,
  count,
  limit,
  isFetching,
  isError,
  hasMore,
  hasNextCursor,
  hasPrev,
  onPageSizeChange,
  onPrev,
  onNext,
}: RequestPaginationProps) {
  const t = useT();

  return (

        <footer className="request-pagination">
          <span aria-live="polite">
            {stale
              ? t('events.previous_results')
              : t('events.page_loaded', { page, n: count })}
            {isPlaceholderData && ` · ${t('events.updating')}`}
          </span>
          <div className="request-actions">
            <Select
              aria-label={t('events.page_size')}
              value={limit}
              onChange={onPageSizeChange}
              options={Array.from(new Set([100, 250, 500, limit]))
                .sort((a, b) => a - b)
                .map((value) => ({ value, label: t('events.per_page', { n: value }) }))}
            />
            <Tooltip title={t('events.prev_page')}>
              <Button
                aria-label={t('events.prev_page')}
                icon={<LeftOutlined />}
                disabled={!hasPrev || isFetching}
                onClick={onPrev}
              />
            </Tooltip>
            <Tooltip title={t('events.next_page')}>
              <Button
                aria-label={t('events.next_page')}
                icon={<RightOutlined />}
                disabled={!hasMore || !hasNextCursor || isFetching || isError}
                onClick={onNext}
              />
            </Tooltip>
          </div>
        </footer>
  );
}
