import { useIdentityDirectory } from './useIdentityDirectory';

/**
 * The collection-level brand sources: artwork preferences, plugin logos, sanitized
 * provider catalog, OAuth credentials, and persistent historical identity archive.
 *
 * Delegated to `useIdentityDirectory` so every surface in the console shares a single
 * consolidated query (`GET /api/v1/management/identity-directory`) and SSE invalidation
 * scope without drifting across separate per-page queries.
 */
export function useProviderBranding() {
  return useIdentityDirectory();
}
