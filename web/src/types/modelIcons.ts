/**
 * Shared console preference for per-model icon overrides, keyed by the advertised call name.
 *
 * The fallback and parser live at module scope because `usePreference` and the query
 * `select` callers need reference-stable values across renders (see providerIcons.ts).
 */
export const MODEL_ICONS_PREFERENCE = 'model_icons';

export const EMPTY_MODEL_ICONS: Record<string, string> = {};

export function parseModelIcons(raw: unknown): Record<string, string> {
  return typeof raw === 'object' && raw && !Array.isArray(raw) ? (raw as Record<string, string>) : EMPTY_MODEL_ICONS;
}

export const selectModelIcons = (preferences: Record<string, unknown>) => parseModelIcons(preferences[MODEL_ICONS_PREFERENCE]);

/**
 * The icon an operator chose for a model, or undefined to keep the resolved maker mark.
 *
 * A surface that shows an alias reads the alias's own choice first and then the upstream
 * name it routes to, matching how `modelMarkIconId` falls back for maker resolution.
 */
export function resolveModelIconOverride(icons: Record<string, string>, model: string, fallbackModel = ''): string | undefined {
  const primary = model.trim();
  const fallback = fallbackModel.trim();
  const own = (key: string) => key && Object.prototype.hasOwnProperty.call(icons, key) ? icons[key] : undefined;
  return own(primary) || own(fallback) || undefined;
}

/** The document after one model's override is set, or removed when `icon` is empty. */
export function withModelIcon(icons: Record<string, string>, model: string, icon: string): Record<string, string> {
  const next = { ...icons };
  if (icon) next[model] = icon;
  else delete next[model];
  return next;
}
