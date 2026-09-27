import { Spin } from 'antd';
import clsx from 'clsx';
import { useT } from '../../i18n';

export interface PageLoadingProps {
  /** `page` stands in for a whole route; `block` for one list or panel inside a page. */
  variant?: 'page' | 'block';
  className?: string;
}

/**
 * The spinner that stands in for content that has not arrived yet.
 *
 * One component so a route's first load, a lazy chunk and a list's first read put the indicator
 * in the same place: centred in the space the content will occupy, so nothing jumps when it lands.
 */
export function PageLoading({ variant = 'page', className }: PageLoadingProps) {
  const t = useT();
  // The status region carries the name: a spinner alone is announced as an unlabelled status.
  return (
    <div
      className={clsx(variant === 'page' ? 'page-loading' : 'phone-list-loading', className)}
      role="status"
      aria-busy="true"
      aria-label={t('common.loading')}
    >
      <Spin size={variant === 'page' ? 'large' : 'medium'} />
    </div>
  );
}
