/**
 * The credential providers the console pins to the front of its provider filters.
 *
 * The list is ordering and prominence, not an allowlist: the credential page and
 * the quota page both append every provider their own data actually contains, so
 * a provider missing here is still selectable - it just sorts after these. That
 * is what keeps a newly added CPA provider usable before the console's copy is
 * updated to name it.
 *
 * It lives here rather than in either page because the two filters must agree:
 * an operator looking for the same credentials on both pages should see the same
 * tabs in the same order.
 */
export const PRIMARY_CREDENTIAL_PROVIDERS = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
];

/**
 * providerFilterTabs builds a filter's tab list: "all", then the pinned
 * providers, then any further provider the data contains in alphabetical order.
 */
export function providerFilterTabs(observed: string[]): string[] {
  const extras = observed.filter((provider) => provider && !PRIMARY_CREDENTIAL_PROVIDERS.includes(provider));
  return ['all', ...PRIMARY_CREDENTIAL_PROVIDERS, ...Array.from(new Set(extras)).sort()];
}
