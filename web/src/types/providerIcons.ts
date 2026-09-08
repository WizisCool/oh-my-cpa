/**
 * Shared console preference for per-provider icon overrides.
 *
 * usePreference requires reference-stable values across renders (its result is
 * wired into effect deps and React.memo props), so the fallback and parser
 * must live at module scope instead of inline object literals and arrow
 * closures at call sites.
 */
export const PROVIDER_ICONS_PREFERENCE = 'provider_icons';

export const EMPTY_PROVIDER_ICONS: Record<string, string> = {};

export function parseProviderIcons(raw: unknown): Record<string, string> {
  return typeof raw === 'object' && raw ? (raw as Record<string, string>) : EMPTY_PROVIDER_ICONS;
}
