import { useSortableList } from '../../hooks/useSortableList';

export const OAUTH_SECTION_ORDER_PREFERENCE = 'omc_oauth_section_order';

const SECTION_LIST = 'sections';
const providerKey = (provider: string) => provider;

/**
 * The OAuth list's provider sections in the order the operator dragged them into.
 *
 * The list is every provider the workspace has, not the page on screen, so a drag arranges the
 * providers themselves: the pages are then cut in that order, and a section split across two pages
 * continues in the same place on both. A provider the document does not name follows the named ones
 * in the console's fixed section order, so a provider whose first credential arrives later needs no
 * rewrite. Presentation only: which credential serves a request is CPA's priority and routing.
 */
export function useOAuthSectionOrder(providers: readonly string[]) {
  return useSortableList(OAUTH_SECTION_ORDER_PREFERENCE, SECTION_LIST, providers, providerKey);
}
