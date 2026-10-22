import { afterEach, beforeEach, vi } from 'vitest';
import { finishOmcApi } from './support/omcApi';

const isBrowserEnvironment = typeof window !== 'undefined';
const cleanup = isBrowserEnvironment
  ? (await import('@testing-library/react')).cleanup
  : undefined;
const clearTestQueryClients = isBrowserEnvironment
  ? (await import('./support/render')).clearTestQueryClients
  : undefined;

// jsdom has no layout observers or media queries; antd and the console's responsive
// hooks need both to exist, and nothing here measures through them.
beforeEach(() => {
  if (!isBrowserEnvironment) return;
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  if (!window.matchMedia) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    }));
  }
});

// Vitest globals are deliberately disabled, so RTL cleanup is explicit. Queries
// and response rendezvous, not synthetic geometry or blanket error suppression,
// define readiness in this layer.
afterEach(() => {
  cleanup?.();
  clearTestQueryClients?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (isBrowserEnvironment) {
    window.localStorage.clear();
    delete window.__OMCPA_CONFIG__;
  }
  finishOmcApi();
});
