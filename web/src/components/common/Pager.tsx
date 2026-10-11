import { Pagination } from 'antd';
import clsx from 'clsx';

export interface PagerProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  /**
   * `numbered` lists the pages; `stepped` is previous, the page out of the count, next - for a
   * phone or a narrow column, where a run of numbers would wrap.
   */
  variant?: 'numbered' | 'stepped';
  /** Adds a jump-to-page field, for a list long enough that stepping to a page is tedious. */
  hasQuickJumper?: boolean;
  className?: string;
}

/**
 * Page navigation for a list whose length is known.
 *
 * It renders nothing when everything fits on one page, so a caller does not repeat that test, and
 * it never offers a page-size menu: page size is a view preference and lives with the list's other
 * view controls. A list paged by cursor has no total and does not use this.
 */
export function Pager({ page, pageSize, total, onChange, variant = 'numbered', hasQuickJumper = false, className }: PagerProps) {
  return (
    <Pagination
      className={clsx('pager', className)}
      size="small"
      current={page}
      pageSize={pageSize}
      total={total}
      onChange={onChange}
      showSizeChanger={false}
      showLessItems
      hideOnSinglePage
      simple={variant === 'stepped' ? { readOnly: true } : false}
      showQuickJumper={hasQuickJumper && variant === 'numbered'}
    />
  );
}
