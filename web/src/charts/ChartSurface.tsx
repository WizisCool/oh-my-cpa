import React from 'react';
import clsx from 'clsx';
import { ChartMount } from './ChartMount';
import type { MountPriority } from '../performance/frameScheduler';

export interface ChartSurfaceProps {
  height?: number | string;
  minHeight?: number | string;
  aspectRatio?: string;
  priority?: MountPriority;
  /** Render children immediately without frame-queue deferral when already warm or non-heavy. */
  immediate?: boolean;
  isLoading?: boolean;
  isEmpty?: boolean;
  loadingFallback?: React.ReactNode;
  emptyFallback?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Standardized Zero-CLS host shell for SVG/Canvas visualizations.
 *
 * Holds identical outer box geometry (`height`, `minHeight`, `aspectRatio`) across loading
 * skeletons, empty states, and scheduled chart initialization so lazy chunk arrival and staged
 * mounting never trigger layout shifts.
 */
export const ChartSurface: React.FC<ChartSurfaceProps> = ({
  height,
  minHeight,
  aspectRatio,
  priority = 'p1',
  immediate = false,
  isLoading = false,
  isEmpty = false,
  loadingFallback,
  emptyFallback = null,
  className,
  style,
  children,
}) => {
  const boxStyle: React.CSSProperties = {
    ...(height !== undefined ? { height } : {}),
    ...(minHeight !== undefined ? { minHeight } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...style,
  };

  return (
    <div className={clsx('omc-echart-slot', className)} style={boxStyle}>
      {isLoading ? (
        loadingFallback ?? <div className="chart-placeholder" style={{ height: height ?? minHeight ?? '100%' }} aria-hidden="true" />
      ) : isEmpty ? (
        emptyFallback
      ) : immediate ? (
        children
      ) : (
        <ChartMount priority={priority}>
          {children}
        </ChartMount>
      )}
    </div>
  );
};
