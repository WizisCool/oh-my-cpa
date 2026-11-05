import { pluginDisplayName, type PluginItem } from './plugin';
import { getCredentialProviderMetadata } from './providerMetadata';

export const OAUTH_PROVIDER_PATTERN = /^[a-z0-9-]+$/;

/**
 * The OAuth providers OMC signs in to itself. A plugin cannot replace their login cards or
 * rename them. The sign-in registry in `pages/oauthProviderLogic.ts` defines each one; this
 * leaf copy lets every surface name providers without loading that page module.
 */
export const BUILTIN_OAUTH_IDS: ReadonlySet<string> = new Set(['kimi', 'kimi-ai', 'codex', 'anthropic', 'antigravity', 'xai', 'devin', 'meta']);

function collectDeclaredPluginOAuthProviders(plugin: PluginItem): string[] {
  return [...new Set([...(plugin.oauth_providers ?? []), plugin.oauth_provider ?? '']
    .map((id) => id.trim().toLowerCase()).filter(Boolean))];
}

/**
 * The display text a plugin publishes for each login portal it declares, keyed by
 * provider key.
 *
 * A multi-portal plugin fronts several brands with one credential shape, and the bare
 * identifier is a machine key, not a label: `zcode-bigmodel` is where a card is sent,
 * not what the operator calls the portal. CPA v8.0.51+ publishes that per portal, and
 * the key is the normalized identifier because that is what a card or a credential row
 * is built for.
 *
 * Only a usable name or a renderable logo is kept, so "this portal declares nothing" and
 * "this portal's artwork cannot be rendered" both leave the entry absent and the caller
 * on the plugin-wide fallback. An entry naming a portal the plugin did not declare as an
 * identifier is discarded: nothing is drawn per entry, so it would have nowhere to appear.
 */
export interface PluginOAuthProviderEntryText {
  name?: string;
  logo?: string;
}

export type PluginOAuthProviderEntries = Record<string, PluginOAuthProviderEntryText>;

export function pluginOAuthProviderEntryTexts(plugins: PluginItem[] | undefined): PluginOAuthProviderEntries {
  const entries = Object.create(null) as PluginOAuthProviderEntries;
  for (const plugin of plugins ?? []) {
    const declared = new Set(pluginOAuthProviderIds(plugin));
    for (const entry of plugin.oauth_provider_entries ?? []) {
      const key = (entry.identifier ?? '').trim().toLowerCase();
      if (!declared.has(key) || entries[key]) continue;
      const name = (entry.name ?? '').trim();
      const logo = (entry.logo ?? '').trim();
      const isLogoUsable = isRenderableLogoURL(logo);
      if (!name && !isLogoUsable) continue;
      entries[key] = {
        ...(name ? { name } : {}),
        ...(isLogoUsable ? { logo } : {}),
      };
    }
  }
  return entries;
}

/** Login portals are declared identifiers, not aliases for the owning plugin. */
export function pluginOAuthProviderIds(plugin: PluginItem): string[] {
  const declared = collectDeclaredPluginOAuthProviders(plugin);
  // Older capability-only responses used the plugin id as their sole login entry.
  const hasDeclaration = Boolean(plugin.oauth_providers?.length || plugin.oauth_provider);
  const ids = hasDeclaration ? declared : plugin.supports_oauth ? [plugin.id.trim().toLowerCase()] : [];
  return ids.filter((id) => OAUTH_PROVIDER_PATTERN.test(id));
}

/** Credential identity includes the plugin id and quota provider, not just login portals. */
export function pluginOAuthProviderKeys(plugin: PluginItem): string[] {
  const declared = collectDeclaredPluginOAuthProviders(plugin);
  if (!plugin.supports_oauth && !declared.length) return [];
  return [...new Set([...declared, plugin.id.trim().toLowerCase(), (plugin.quota_provider ?? '').trim().toLowerCase()].filter(Boolean))];
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
 * Publisher-owned HTTP(S) artwork loads in the browser, independently of the OMC
 * server's network. Inline images remain supported. Relative paths are not publisher
 * URLs: resolving them against the console origin would request the wrong resource.
 * Artwork is rendered only as an isolated image, never as host markup.
 */
export function isRenderableLogoURL(raw: string | null | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  if (/^data:image\//i.test(trimmed) && trimmed.includes(',')) return true;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Artwork remains isolated inside an image, never interpreted as host markup. */
export function pluginLogoArtworks(logo?: string): { url: string; isMono: boolean }[] {
  const source = (logo ?? '').trim();
  return isRenderableLogoURL(source) ? [{ url: source, isMono: false }] : [];
}

/**
 * pluginOAuthProviderLogos maps each plugin-registered OAuth provider to the logo
 * that plugin publishes for it.
 *
 * A plugin may publish one mark for itself and, since CPA v8.0.51, a mark per login
 * portal it declares. The portal's own mark is the more specific answer and wins for
 * its key; the plugin-wide logo fills the plugin id and every other key it registers.
 * One map serves every surface - the login card, the credential and quota rows, the
 * request records - because they all name the same identity by provider key, and two
 * marks for one credential would read as two credentials.
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
    const pluginLogo = (plugin.logo || plugin.metadata?.logo || '').trim();
    const fallback = isRenderableLogoURL(pluginLogo) ? pluginLogo : '';
    const entries = pluginOAuthProviderEntryTexts([plugin]);

    for (const key of pluginOAuthProviderKeys(plugin)) {
      const logo = entries[key]?.logo || fallback;
      if (logo && !logos[key]) {
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

/** The title a plugin's login card gives each portal it declares. */
export function pluginPortalTitles(plugin: PluginItem, providerIds: readonly string[]): (providerId: string) => string {
  const entries = pluginOAuthProviderEntryTexts([plugin]);
  const name = pluginDisplayName(plugin);
  return (providerId) => {
    const entryName = entries[providerId]?.name;
    return entryName && entryName !== name
      ? entryName
      : providerIds.length > 1 ? `${name} · ${providerId}` : name;
  };
}

/**
 * pluginOAuthProviderTitles names the credentials of every plugin-registered provider with
 * the title its login card carries, keyed by the canonical provider key `providerDisplayName`
 * looks up.
 *
 * Unlike the login cards, a disabled plugin still contributes: switching it off keeps the
 * credentials it registered, and they keep its name, as they keep its logo. When an enabled
 * plugin declares the same provider, its title wins, as its login card does. A built-in
 * provider keeps its own name, matching the login cards a plugin cannot replace.
 */
export function pluginOAuthProviderTitles(plugins: PluginItem[] | undefined): Map<string, string> {
  const titles = new Map<string, string>();
  const isEnabled = (plugin: PluginItem) => Boolean(plugin.effective_enabled ?? plugin.enabled);
  const ordered = [...(plugins ?? [])].sort((a, b) => Number(isEnabled(b)) - Number(isEnabled(a)));
  for (const plugin of ordered) {
    if (!plugin.supports_oauth) continue;
    const providerIds = pluginOAuthProviderIds(plugin);
    const portalTitle = pluginPortalTitles(plugin, providerIds);
    for (const providerId of providerIds) {
      const key = getCredentialProviderMetadata(providerId).id;
      if (BUILTIN_OAUTH_IDS.has(providerId) || BUILTIN_OAUTH_IDS.has(key) || titles.has(key)) continue;
      titles.set(key, portalTitle(providerId));
    }
  }
  return titles;
}
