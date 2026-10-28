import React from 'react';
import { Button } from 'antd';
import { useT } from '../../i18n';
import { Notice } from '../feedback';
import { SuspenseFallback } from './PageLoading';

const MODULE_LOAD_FAILURES = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Failed to load module script/i,
  /Unable to preload CSS/i,
];

function isModuleLoadFailure(error: unknown): boolean {
  return error instanceof Error && MODULE_LOAD_FAILURES.some((pattern) => pattern.test(error.message));
}

interface OptionalSurfaceBoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

interface OptionalSurfaceBoundaryState {
  error: unknown;
  hasError: boolean;
}

/** A failed optional module belongs to its surface, not the page that opened it. */
class OptionalSurfaceBoundary extends React.Component<OptionalSurfaceBoundaryProps, OptionalSurfaceBoundaryState> {
  state: OptionalSurfaceBoundaryState = { error: undefined, hasError: false };

  static getDerivedStateFromError(error: unknown): OptionalSurfaceBoundaryState {
    return { error, hasError: true };
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    // An error boundary does not catch its own render; rethrow application errors to the route
    // boundary so its bounded diagnostics survive.
    if (!isModuleLoadFailure(this.state.error)) throw this.state.error;
    return this.props.fallback;
  }
}

function OptionalSurfaceFailure() {
  const t = useT();
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // The failure replaces a drawer or modal far below the trigger, so make its recovery visible.
    surfaceRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <div ref={surfaceRef}>
      <Notice
        tone="error"
        title={t('common.load_failed_title')}
        data-testid="optional-surface-failure"
        action={(
          <Button size="small" onClick={() => window.location.reload()}>
            {t('route_error.reload')}
          </Button>
        )}
      />
    </div>
  );
}

/** Start an optional surface on first use, then retain its drafts and closing motion. */
export function DeferredMount({ isActive, children }: { isActive: boolean; children: React.ReactNode }) {
  const [hasMounted, setHasMounted] = React.useState(isActive);
  if (isActive && !hasMounted) setHasMounted(true);
  if (!isActive && !hasMounted) return null;
  return (
    <OptionalSurfaceBoundary fallback={isActive ? <OptionalSurfaceFailure /> : null}>
      <React.Suspense fallback={<SuspenseFallback>{null}</SuspenseFallback>}>{children}</React.Suspense>
    </OptionalSurfaceBoundary>
  );
}
