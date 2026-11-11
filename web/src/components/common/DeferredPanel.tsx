import React from 'react';
import clsx from 'clsx';
import { useFrameBudgetMount, type MountPriority } from '../../performance/frameScheduler';

export interface DeferredPanelProps {
  /** Frame-budget priority tier (`p0` hero -> `p1` primary chart -> `p2` secondary panel). */
  priority?: MountPriority;
  /** Minimum height reserved while waiting for its frame slice so layout never shifts on mount. */
  minHeight?: number | string;
  /** Placeholder rendered inside the reserved box until the panel's slice executes. */
  fallback?: React.ReactNode;
  /** Bypass deferral when true (e.g. during interactive board arrangement). */
  immediate?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Container primitive that defers mounting heavy below-the-fold or secondary panels into the
 * console's frame-budget scheduler while holding stable placeholder geometry (Zero-CLS).
 */
export const DeferredPanel: React.FC<DeferredPanelProps> = ({
  priority = 'p2',
  minHeight,
  fallback = null,
  immediate = false,
  className,
  style,
  children,
}) => {
  const isMounted = useFrameBudgetMount(priority, { immediate });
  if (isMounted) return <>{children}</>;
  const mergedStyle: React.CSSProperties | undefined = minHeight !== undefined || style
    ? { ...(minHeight !== undefined ? { minHeight } : {}), ...style }
    : undefined;
  if (!className && !mergedStyle) return <>{fallback}</>;
  return (
    <div className={clsx(className)} style={mergedStyle} aria-busy="true">
      {fallback}
    </div>
  );
};
