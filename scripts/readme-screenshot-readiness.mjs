/** Runs in Chromium: capture settled content only after transient feedback has left. */
export function hasReadmeScreenshotContent(selector) {
  const isVisible = (element) => Boolean(element && element.getClientRects().length > 0);
  const isLoading = [...document.querySelectorAll('.ant-spin-spinning, .ant-skeleton, .request-loading, [aria-busy="true"]')]
    .some(isVisible);
  // Keep waiting through exit motion: a mounted toast can still contribute screenshot pixels.
  const hasToast = Boolean(document.querySelector('.omc-toast, .ant-message-notice'));
  return isVisible(document.querySelector(selector)) && !isLoading && !hasToast;
}

/**
 * Runs in Chromium: the console font's shards beyond the core are registered (ADR 0094). They
 * arrive after load, and a capture taken before them draws demo text outside the core in a
 * fallback font.
 */
export function hasDeferredFontShards() {
  return [...document.fonts].filter((face) => face.family.replaceAll('"', '') === 'Sarasa Mono SC').length > 2;
}
