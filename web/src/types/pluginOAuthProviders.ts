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
 * The scheme is the boundary: an absolute http(s) URL or an inline `data:` image
 * renders, while a relative path would silently resolve against the console's own
 * origin and a `javascript:` value must never reach the DOM. This is deliberately
 * looser than `isSafeExternalURL`, which also guards `<a href>` targets - `data:`
 * is inert as an image source but is not a navigable destination.
 */
export function isRenderableLogoURL(raw: string | null | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  if (/^data:image\//i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * pluginOAuthProviderLogos maps each plugin-registered OAuth provider to the logo
 * that plugin publishes.
 *
 * A disabled plugin is skipped: its provider cannot hold credentials, so a logo
 * for it would only decorate a name the operator cannot use.
 */
export function pluginOAuthProviderLogos(plugins: PluginItem[] | undefined): PluginOAuthLogos {
  const logos: PluginOAuthLogos = {};
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
  return logos[(providerKey || '').trim().toLowerCase()] || undefined;
}
