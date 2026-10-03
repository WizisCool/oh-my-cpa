import React from 'react';
import { resolveVisibleViewport } from '../types/visibleViewport';

/** Resize and scroll both matter: iOS can pan the visual viewport to reveal a caret. */
export function useVisibleViewport(isEnabled: boolean) {
  const [viewport, setViewport] = React.useState(() => resolveVisibleViewport(document.documentElement.clientHeight || window.innerHeight));
  React.useLayoutEffect(() => {
    if (!isEnabled) return;
    const visible = window.visualViewport;
    const updateViewport = () => setViewport(resolveVisibleViewport(document.documentElement.clientHeight || window.innerHeight, visible));
    updateViewport();
    visible?.addEventListener('resize', updateViewport);
    visible?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    return () => {
      visible?.removeEventListener('resize', updateViewport);
      visible?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [isEnabled]);
  return isEnabled ? viewport : resolveVisibleViewport(document.documentElement.clientHeight || window.innerHeight);
}
