import type { PluginItem } from './plugin';

export const OAUTH_PROVIDER_PATTERN = /^[a-z0-9-]+$/;

function collectDeclaredPluginOAuthProviders(plugin: PluginItem): string[] {
  return [...new Set([...(plugin.oauth_providers ?? []), plugin.oauth_provider ?? '']
    .map((id) => id.trim().toLowerCase()).filter(Boolean))];
}

/** Login portals are declared identifiers, not aliases for the owning plugin. */
export function pluginOAuthProviderIds(plugin: PluginItem): string[] {
  const declared = collectDeclaredPluginOAuthProviders(plugin);
  // Older capability-only responses used the plugin id as their sole login entry.
  const hasDeclaration = Boolean(plugin.oauth_providers?.length || plugin.oauth_provider);
  const ids = hasDeclaration ? declared : plugin.supports_oauth ? [plugin.id.trim().toLowerCase()] : [];
  return ids.filter((id) => OAUTH_PROVIDER_PATTERN.test(id));
}

/** Credential identity includes the plugin id even when it is not a login portal. */
export function pluginOAuthProviderKeys(plugin: PluginItem): string[] {
  const declared = collectDeclaredPluginOAuthProviders(plugin);
  if (!plugin.supports_oauth && !declared.length) return [];
  return [...new Set([...declared, plugin.id.trim().toLowerCase()].filter(Boolean))];
}

/**
 * The brand artwork a plugin publishes for the OAuth provider it registers.
 *
 * A plugin is the only authority on what its provider is called and what it looks
 * like, so its own logo is rendered rather than a mark guessed from the provider
 * key: the console's icon catalog can be a release behind a plugin that was
 * installed yesterday, and guessing "Codebuddy looks like <some other brand>"
 * mislabels the operator's own credential.
 *
 * The result is keyed by provider key, because that is what the credential, quota
 * and tab records carry. All declared OAuth provider keys and the plugin id
 * are registered, since a plugin whose auths are typed by its own id (rather than
 * by `oauth_provider`) still has to resolve to the same logo.
 */
export type PluginOAuthLogos = Record<string, string>;

/**
 * Whether a plugin-published logo can be rendered in an `<img>`.
 *
 * Only inline `data:image/*` artwork qualifies. A remote URL - http(s), scheme-relative
 * or rooted - is refused, and the caller falls back to the console's catalog mark: the
 * bundle's contract is that a deployment has no CDN or static-file dependency, and the
 * console's own CSP allows images from itself or inline only (`img-src 'self' data:
 * blob:`). The plugin's own mark is still what gets drawn - the Go process fetches a
 * logo the plugin publishes and inlines it, so what arrives here is already inline
 * (`internal/api/management_plugin_logos.go`).
 *
 * The scheme is the boundary: `data:` is inert as an image source, whereas a
 * `javascript:` value must never reach the DOM at all. This is deliberately narrower
 * than `isSafeExternalURL`, which guards `<a href>` destinations - a link the operator
 * chooses to follow is not a resource the page loads by itself.
 */
export function isRenderableLogoURL(raw: string | null | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  return /^data:image\//i.test(trimmed) && trimmed.includes(',');
}

/** Inline artwork remains inert inside an image, never interpreted as host markup. */
export function pluginLogoArtworks(logo?: string): { url: string; isMono: boolean }[] {
  const source = (logo ?? '').trim();
  return isRenderableLogoURL(source) ? [{ url: source, isMono: false }] : [];
}

/**
 * pluginOAuthProviderLogos maps each plugin-registered OAuth provider to the logo
 * that plugin publishes.
 *
 * A disabled plugin still contributes: switching a plugin off does not delete the
 * credentials it registered, and those credentials keep appearing on the credential,
 * quota and request-record surfaces with the provider they belong to. The mark is a
 * property of that identity, not of the plugin's current switch state, and dropping it
 * would leave exactly those rows with a placeholder - the defect this resolver exists to
 * prevent. The OAuth sign-in page is where a disabled plugin is excluded, because that is
 * where the plugin's *actions* live.
 *
 * The map has no prototype, because the keys come from plugins: a provider a plugin
 * happens to call `constructor`, `toString` or `__proto__` would otherwise read the
 * inherited member instead of the logo it published - the lookup would answer with a
 * function, and the plugin's own mark would silently be replaced by the fallback.
 */
export function pluginOAuthProviderLogos(plugins: PluginItem[] | undefined): PluginOAuthLogos {
  const logos = Object.create(null) as PluginOAuthLogos;
  for (const plugin of plugins ?? []) {
    const logo = (plugin.logo || plugin.metadata?.logo || '').trim();
    if (!isRenderableLogoURL(logo)) continue;

    for (const key of pluginOAuthProviderKeys(plugin)) {
      if (!logos[key]) {
        logos[key] = logo;
      }
    }
  }
  return logos;
}

/** The logo published for one provider key, if any. */
export function pluginOAuthLogoFor(
  logos: PluginOAuthLogos | undefined,
  providerKey: string | undefined,
): string | undefined {
  if (!logos) return undefined;
  const logo = logos[(providerKey || '').trim().toLowerCase()];
  return typeof logo === 'string' && logo ? logo : undefined;
}

/** Ownership survives a missing or unusable logo; artwork availability is not identity. */
export function pluginOwnsProvider(plugins: PluginItem[] | undefined, providerKeys: readonly (string | undefined)[]): boolean {
  const keys = new Set(providerKeys.filter(Boolean).map((key) => key!.trim().toLowerCase()));
  return (plugins ?? []).some((plugin) => pluginOAuthProviderKeys(plugin).some((key) => keys.has(key)));
}
