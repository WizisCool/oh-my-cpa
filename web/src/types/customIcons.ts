export interface CustomIcon {
  id: string;
  name: string;
  mime_type: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  reference_count: number;
}
export const CUSTOM_ICONS_QUERY_KEY = ['custom-icons'] as const;
export const MAX_CUSTOM_ICON_BYTES = 512 * 1024;
export function customIconID(reference?: string): string | undefined {
  const matched = /^custom:([a-f0-9]{32})$/.exec(reference ?? '');
  return matched?.[1];
}
export function filterCustomIcons(
  icons: CustomIcon[],
  search: string,
): CustomIcon[] {
  const query = search.trim().toLocaleLowerCase();
  return icons.filter((icon) => icon.name.toLocaleLowerCase().includes(query));
}
export function shouldCloseIconPicker(result: boolean | void): boolean {
  return result !== false;
}

/** Plugin identity stays authoritative even while its artwork is unavailable. */
export function resolveProviderArtwork(
  iconId: string | undefined,
  fallbackIconId: string | undefined,
  hasPluginLogo: boolean,
  isPluginOwned: boolean,
  isOwnershipUnknown: boolean,
): string | undefined {
  return customIconID(iconId) &&
    (hasPluginLogo || isPluginOwned || isOwnershipUnknown)
    ? fallbackIconId
    : iconId;
}

export function clearCustomIconAssignments(
  assignments: Record<string, string>,
  id: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(assignments).filter(
      ([, reference]) => reference !== `custom:${id}`,
    ),
  );
}

export function canSaveCustomIcon(input: {
  name: string;
  originalName?: string;
  isNew: boolean;
  hasReplacement: boolean;
  hasValidatedPreview: boolean;
  isBusy: boolean;
}): boolean {
  const name = input.name.trim();
  if (input.isBusy || !name || Array.from(name).length > 80) return false;
  if ((input.isNew || input.hasReplacement) && !input.hasValidatedPreview)
    return false;
  return input.isNew || input.hasReplacement || name !== input.originalName;
}
