import React from 'react';
import { SuspenseFallback } from './PageLoading';

/** Start an optional surface on first use, then retain its drafts and closing motion. */
export function DeferredMount({ isActive, children }: { isActive: boolean; children: React.ReactNode }) {
  const [hasMounted, setHasMounted] = React.useState(isActive);
  if (isActive && !hasMounted) setHasMounted(true);
  if (!isActive && !hasMounted) return null;
  return <React.Suspense fallback={<SuspenseFallback>{null}</SuspenseFallback>}>{children}</React.Suspense>;
}
