import { afterEach, vi } from 'vitest';

const cleanup = typeof window !== 'undefined'
  ? (await import('@testing-library/react')).cleanup
  : undefined;

// Vitest globals are deliberately disabled, so RTL cleanup is explicit. Queries
// and response rendezvous, not synthetic geometry or blanket error suppression,
// define readiness in this layer.
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (typeof window !== 'undefined') {
    window.localStorage.clear();
    delete window.__OMCPA_CONFIG__;
  }
});
