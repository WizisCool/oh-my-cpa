import type { Lang } from '../../i18n/language';
import type { PluginDescriptionI18n } from '../../types/plugin';

/**
 * The description a plugin shows in a reading language: the plugin's own text in that
 * language, then its English text, then the registry's description.
 *
 * The localized texts come from the plugin's published declaration and arrive already
 * checked as plain text; they are rendered as text, never as markup. A blank entry counts
 * as absent so a declaration cannot blank out the registry's description.
 */
export function pluginDescription(
  lang: Lang,
  plugin: { description?: string; description_i18n?: PluginDescriptionI18n },
): string {
  const localized = plugin.description_i18n;
  return localized?.[lang]?.trim() || localized?.en?.trim() || plugin.description?.trim() || '';
}
