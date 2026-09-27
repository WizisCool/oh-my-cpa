import type { ConfigFieldDefinition } from '../../types/configSchema';
import type { ConfigLayoutInfo, ConfigLayoutRule } from '../../types/configManagement';
import { LEGACY_PAYLOAD_PLACEMENT, type PayloadPlacement } from './payloadRules';

/**
 * Where each setting lives in the document being edited.
 *
 * The schema names every field by its legacy (CPA v7) path. CPA v8 moved most of
 * them, and in a v8 document a legacy spelling is not an error: CPA accepts the
 * save, keeps the value at the v8 location and deletes the legacy one. So an
 * editor that writes legacy paths into a v8 document loses the edit without any
 * signal. Placement therefore follows the document:
 *
 * - legacy: fields keep their legacy paths. This is every v7 document, and a v7
 *   document served by a v8 gateway, which reads it unchanged.
 * - v8 / mixed: relocated fields are written at their v8 path. The legacy
 *   spelling is still read as a fallback (CPA honours it while no v8 value
 *   exists) and is removed when the field is written, so a save never leaves
 *   two spellings for CPA to arbitrate.
 *
 * The relocation rules come from the server, which checks every save against
 * the same table.
 */

export function rewriteToV8(path: string[], rules: ConfigLayoutRule[]): { path: string[]; rule: ConfigLayoutRule | null } {
  const joined = path.join('.');
  let best: ConfigLayoutRule | null = null;
  for (const rule of rules) {
    const matches = joined === rule.legacy || joined.startsWith(`${rule.legacy}.`);
    if (matches && (!best || rule.legacy.length > best.legacy.length)) {
      best = rule;
    }
  }
  if (!best) return { path: [...path], rule: null };
  return { path: (best.current + joined.slice(best.legacy.length)).split('.'), rule: best };
}

function placesAtV8(layout: ConfigLayoutInfo | undefined): layout is ConfigLayoutInfo {
  return Boolean(layout && (layout.layout === 'v8' || layout.layout === 'mixed') && layout.rules?.length);
}

export function resolveConfigField(field: ConfigFieldDefinition, layout: ConfigLayoutInfo | undefined): ConfigFieldDefinition {
  if (!placesAtV8(layout)) return field;
  const { path, rule } = rewriteToV8(field.yamlPath, layout.rules);
  if (!rule) return field;
  return {
    ...field,
    yamlPath: path,
    legacyYamlPath: field.yamlPath,
    legacyKind: rule.legacy_kind,
  };
}

export function resolveConfigFields(fields: ConfigFieldDefinition[], layout: ConfigLayoutInfo | undefined): ConfigFieldDefinition[] {
  return fields.map((field) => resolveConfigField(field, layout));
}

/** Where the payload rule section is read from and written to in this document. */
export function resolvePayloadPlacement(layout: ConfigLayoutInfo | undefined): PayloadPlacement {
  if (!placesAtV8(layout)) return LEGACY_PAYLOAD_PLACEMENT;
  const { path, rule } = rewriteToV8(LEGACY_PAYLOAD_PLACEMENT.path, layout.rules);
  return rule ? { path, legacyPath: LEGACY_PAYLOAD_PLACEMENT.path } : LEGACY_PAYLOAD_PLACEMENT;
}

/** Every path the payload section can occupy, for the dirty comparison. */
export function payloadComparisonPaths(placement: PayloadPlacement): string[][] {
  return placement.legacyPath ? [placement.path, placement.legacyPath] : [placement.path];
}

/** The dictionary key for the notice that explains this document's layout, if any. */
export function layoutNoticeKey(layout: ConfigLayoutInfo | undefined): string | null {
  if (!layout) return null;
  if (layout.layout === 'v8') return 'cfg.layout_v8';
  if (layout.layout === 'mixed') return 'cfg.layout_mixed';
  if (layout.management_api === 'v8') return 'cfg.layout_legacy_on_v8';
  return null;
}

/**
 * Words a save the server refused because CPA v8 would have ignored part of it.
 * Returns null for any other failure, which the caller reports as before.
 */
export function describeLayoutRefusal(
  code: string,
  data: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (code === 'config_provider_groups_replaced') return t('cfg.layout_provider_groups_replaced');
  if (code !== 'config_legacy_keys_shadowed') return null;
  const shadowed = (data as { shadowed?: ConfigLayoutRule[] } | null)?.shadowed ?? [];
  const keys = shadowed.map((rule) => `${rule.legacy} → ${rule.current}`).join(', ');
  return t('cfg.layout_shadowed', { keys });
}
