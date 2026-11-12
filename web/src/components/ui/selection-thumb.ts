import * as React from 'react';

/**
 * Draws a group's selection as one thumb that glides from the option that was on to the one that
 * is on, rather than a fill that blinks off one option and on at the next.
 *
 * The host is the group's own box, given the `omc-thumb-host` class; the thumb is its `::before`,
 * placed by the rules in `index.css` from the selected item's offset and size, which this hook
 * writes as `--thumb-x/y/w/h`. The selection is read from the DOM - the item matching `selector`,
 * whose `attribute` the primitive sets - so controlled and uncontrolled groups glide alike.
 *
 * A change of `attribute` glides. Anything else that moves the item - the host resizing, a font
 * arriving, a label changing - snaps the thumb, because the selection did not change. With nothing
 * selected the thumb is hidden and the items keep their own selected fill (`[data-thumb]` on the
 * host is what turns that fill off).
 */
export function useSelectionThumb<T extends HTMLElement>(selector: string, attribute: string, isEnabled = true) {
  const hostRef = React.useRef<T | null>(null);

  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!isEnabled) {
      host.removeAttribute('data-thumb');
      return;
    }
    placeThumb(host, selector, true);
    let resizes: ResizeObserver | undefined;
    const observeSizes = () => {
      if (typeof ResizeObserver === 'undefined') return;
      resizes?.disconnect();
      resizes = new ResizeObserver(() => placeThumb(host, selector, true));
      resizes.observe(host);
      for (const child of Array.from(host.children)) resizes.observe(child);
    };
    // Items added, removed or reordered move the selected one without its attribute changing, and
    // without a size change either: that is a snap, and the new items are watched for size.
    const mutations = new MutationObserver((records) => {
      const isStructural = records.some((record) => record.type === 'childList' && record.target === host);
      if (isStructural) observeSizes();
      placeThumb(host, selector, isStructural || !host.hasAttribute('data-thumb'));
    });
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: [attribute] });
    observeSizes();
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
    };
  }, [selector, attribute, isEnabled]);

  return hostRef;
}

function placeThumb(host: HTMLElement, selector: string, isSnap: boolean) {
  const item = host.querySelector<HTMLElement>(selector);
  if (!item || item.offsetWidth === 0) {
    host.removeAttribute('data-thumb');
    return;
  }
  const geometry: [string, string][] = [
    ['--thumb-x', `${item.offsetLeft}px`],
    ['--thumb-y', `${item.offsetTop}px`],
    ['--thumb-w', `${item.offsetWidth}px`],
    ['--thumb-h', `${item.offsetHeight}px`],
  ];
  if (host.hasAttribute('data-thumb') && geometry.every(([name, value]) => host.style.getPropertyValue(name) === value)) return;
  if (isSnap) host.setAttribute('data-thumb-snap', '');
  for (const [name, value] of geometry) host.style.setProperty(name, value);
  host.setAttribute('data-thumb', '');
  if (isSnap) {
    // Commit the new place with no transition before letting the next selection glide.
    void host.offsetWidth;
    host.removeAttribute('data-thumb-snap');
  }
}
