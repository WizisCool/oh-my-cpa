import React from 'react';

/** The product name every tab title starts with; it is a brand, so it is not translated. */
export const DOCUMENT_TITLE_PRODUCT = 'Oh My CPA';

/** The tab title for a page: the product, then the page in the reader's language. */
export function formatDocumentTitle(pageTitle: string): string {
  const page = pageTitle.trim();
  return page ? `${DOCUMENT_TITLE_PRODUCT} · ${page}` : DOCUMENT_TITLE_PRODUCT;
}

/**
 * Names the browser tab after the page on screen, in the current language.
 *
 * The static title in `index.html` could say only one thing in one language, so a reader with
 * several consoles open, or one who switched language, saw a tab that named neither the page
 * nor their language. `null` leaves the title to another owner: the sign-in gate renders
 * around the console, and its effect runs after the console's, so it must stand aside once
 * the console is showing rather than overwrite the page's title with its own.
 */
export function useDocumentTitle(pageTitle: string | null): void {
  React.useEffect(() => {
    if (pageTitle === null || typeof document === 'undefined') return;
    document.title = formatDocumentTitle(pageTitle);
  }, [pageTitle]);
}
