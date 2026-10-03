import React from 'react';

/** Isolate an in-place workspace without reparenting its stateful editor. */
export function useFocusedRegion(isFocused: boolean, regionRef: React.RefObject<HTMLElement | null>) {
  React.useLayoutEffect(() => {
    const region = regionRef.current;
    if (!isFocused || !region) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings: { element: HTMLElement; wasInert: boolean }[] = [];
    let branch: HTMLElement = region;
    while (branch.parentElement && branch.parentElement !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          siblings.push({ element: sibling, wasInert: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || !region.contains(document.activeElement)) return;
      const controls = [...region.querySelectorAll<HTMLElement>('button, a[href], input, textarea, [tabindex]')]
        .filter((control) => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[inert], [aria-hidden="true"]') && getComputedStyle(control).visibility !== 'hidden' && control.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first && last) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last && first) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', containFocus);
    return () => {
      document.removeEventListener('keydown', containFocus);
      for (const { element, wasInert } of siblings) element.inert = wasInert;
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    };
  }, [isFocused, regionRef]);
}
