import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest globals are deliberately disabled, so RTL cleanup is explicit. Queries
// and response rendezvous, not synthetic geometry or blanket error suppression,
// define readiness in this layer.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete window.__OMCPA_CONFIG__;
});
