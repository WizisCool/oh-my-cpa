import type { ProviderItem } from '../../types/providers';

/**
 * The view models the provider console builds on top of `ProviderItem`.
 *
 * They live here rather than in the page because the drawer, the table and the
 * write paths all speak them: a form row is what the drawer edits, and the list's
 * cached shape is what a confirmed toggle writes back into.
 */

/** The cached shape of the providers list, named because a toggle writes into it. */
export interface ManagementProvidersData {
  providers: ProviderItem[];
  total: number;
}

/** One credential row in the editor's key list. */
export interface FormKeyItem {
  id: string;
  apiKey?: string;
  proxyUrl?: string;
  weight?: number;
  isChanging?: boolean;
}

/** One request header in the editor's header list. */
export interface FormHeaderItem {
  id: string;
  key: string;
  value: string;
}

/** One model entry in the editor's model list. */
export interface FormModelItem {
  id: string;
  name: string;
  alias: string;
  image?: boolean;
  thinking?: {
    levels?: string[];
  };
}
