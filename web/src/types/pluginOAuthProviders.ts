import type { PluginItem } from './plugin';

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
 * and tab records carry. Both the declared OAuth provider key and the plugin id
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

/**
 * pluginOAuthProviderLogos maps each plugin-registered OAuth provider to the logo
 * that plugin publishes.
 *
 * A disabled plugin is skipped: its provider cannot hold credentials, so a logo
 * for it would only decorate a name the operator cannot use.
 *
 * The map has no prototype, because the keys come from plugins: a provider a plugin
 * happens to call `constructor`, `toString` or `__proto__` would otherwise read the
 * inherited member instead of the logo it published - the lookup would answer with a
 * function, and the plugin's own mark would silently be replaced by the fallback.
 */
export function pluginOAuthProviderLogos(plugins: PluginItem[] | undefined): PluginOAuthLogos {
  const logos = Object.create(null) as PluginOAuthLogos;
  for (const plugin of plugins ?? []) {
    if (!plugin.supports_oauth && !plugin.oauth_provider) continue;
    if (!(plugin.effective_enabled ?? plugin.enabled)) continue;

    const logo = (plugin.logo || plugin.metadata?.logo || '').trim();
    if (!isRenderableLogoURL(logo)) continue;

    for (const key of [plugin.oauth_provider, plugin.id]) {
      const normalized = (key || '').trim().toLowerCase();
      if (normalized && !logos[normalized]) {
        logos[normalized] = logo;
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
