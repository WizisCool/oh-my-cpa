import { isMap, isScalar, parseDocument, type Document, type YAMLMap } from 'yaml';

import type { ConfigChange } from '../../types/configManagement';
import { ALL_CONFIG_FIELDS } from '../../types/configSchema';
import { areValuesSemanticallyEqual, getFieldSemanticValue, getFieldYamlPath, updateFieldWithBaseline } from './configDirty';

const VALUE_MAP_PATHS = ALL_CONFIG_FIELDS
  .filter((field) => field.type === 'string_map')
  .flatMap((field) => [field.yamlPath, ...(field.legacyYamlPath ? [field.legacyYamlPath] : [])]);

/**
 * User-keyed maps (`string_map`) are owned as a single atomic value at their field path:
 * their keys are free-form phrases (which may contain `/` or `\`) rather than configuration
 * tree segments, and ApplyConfigChanges replaces a mapping value via `PUT /config/<path>` so
 * removed entries are dropped cleanly.
 */
function isValueMapPath(path: string[]): boolean {
  return VALUE_MAP_PATHS.some(
    (candidate) => candidate.length === path.length && candidate.every((segment, index) => segment === path[index]),
  );
}

/**
 * Turns the visual editor's draft into the settings a save sends.
 *
 * CPA v8 writes a configuration path in place, so a save names only what the
 * operator changed instead of sending the whole file back. The diff walks both
 * documents map by map and stops at the first value that is not a map: a list
 * or a scalar is replaced whole, a key the draft dropped is removed, and a map
 * the server never had is sent as one value. A secret the editor shows masked
 * travels as its sentinel and is put back by the server, so an untouched secret
 * is never part of a change unless something else in the same list changed.
 */
export function computeConfigChanges(serverDoc: Document | null, draftDoc: Document): ConfigChange[] {
  const baseline: unknown = serverDoc?.toJS() ?? null;
  const draft: unknown = draftDoc.toJS();
  const changes: ConfigChange[] = [];
  diffValue(isPlainMap(baseline) ? baseline : {}, isPlainMap(draft) ? draft : {}, [], changes);
  return changes;
}

/**
 * Carries a draft's edits over to a newer baseline: what the draft changed
 * against `draftBase` is applied to `nextBaseYaml`, and everything else comes
 * from the newer document. A whole-document draft compared with a newer
 * baseline would instead undo every change it did not see — another session's
 * edit, or the defaults CPA writes when it converts a file.
 *
 * Returns null when an edit no longer fits the newer document (a map there is
 * now a scalar), which the caller treats as a draft it cannot carry over.
 */
export function rebaseDraft(draftBase: Document | null, draft: Document, nextBaseYaml: string): string | null {
  const nextBase = parseDocument(nextBaseYaml);
  const remainingDraft = draft.clone();
  // CPA may canonicalize a historical path during the save. Carry a later
  // field edit onto its returned path, not an alias the canonical value masks.
  const migratedEdits = ALL_CONFIG_FIELDS.filter((field) => field.legacyYamlPath
    && getFieldYamlPath(draftBase, field).join('.') !== getFieldYamlPath(nextBase, field).join('.')
    && !areValuesSemanticallyEqual(getFieldSemanticValue(draftBase, field), getFieldSemanticValue(draft, field)))
    .map((field) => ({ field, value: getFieldSemanticValue(draft, field) }));
  for (const { field } of migratedEdits) {
    updateFieldWithBaseline(remainingDraft, draftBase, field, getFieldSemanticValue(draftBase, field));
  }
  const stringMapEdits = ALL_CONFIG_FIELDS
    .filter((field) => field.type === 'string_map'
      && !migratedEdits.some((entry) => entry.field.id === field.id)
      && !areValuesSemanticallyEqual(getFieldSemanticValue(draftBase, field), getFieldSemanticValue(draft, field)))
    .map((field) => ({
      field,
      baseMap: toPlainRecord(getFieldSemanticValue(draftBase, field)),
      draftMap: toPlainRecord(getFieldSemanticValue(draft, field)),
    }));
  for (const { field } of stringMapEdits) {
    updateFieldWithBaseline(remainingDraft, draftBase, field, getFieldSemanticValue(draftBase, field));
  }
  const changes = computeConfigChanges(draftBase, remainingDraft);
  if (changes.length === 0 && migratedEdits.length === 0 && stringMapEdits.length === 0) return nextBaseYaml;
  const rebased = nextBase.clone();
  try {
    for (const change of changes) {
      if (change.remove) {
        if (rebased.hasIn(change.path)) rebased.deleteIn(change.path);
      } else {
        applyRebasedValue(rebased, draftBase, change.path, change.value);
      }
    }
    for (const { field, value } of migratedEdits) {
      updateFieldWithBaseline(rebased, nextBase, field, value);
    }
    for (const { field, baseMap, draftMap } of stringMapEdits) {
      const targetPath = getFieldYamlPath(rebased, field);
      const currentNode = rebased.getIn(targetPath, true);
      if (!isAbsentNode(currentNode) && !isMap(currentNode)) return null;
      const nextMap = toPlainRecord(getFieldSemanticValue(nextBase, field));
      const merged = rebaseValueMap(baseMap, draftMap, nextMap);
      updateFieldWithBaseline(rebased, nextBase, field, merged);
    }
  } catch {
    return null;
  }
  return rebased.toString();
}

/**
 * Applies a change to the newer document. A map the draft created is merged
 * into a map that appeared there, so a refresh cannot drop siblings the draft
 * never saw. A path the baseline already held, or a value that is not a map,
 * keeps the existing whole-value replacement. Removals are handled separately.
 */
function applyRebasedValue(doc: Document, draftBase: Document | null, path: string[], value: unknown): void {
  const original = draftBase?.getIn(path, true);
  const current = doc.getIn(path, true);
  if (!isAbsentNode(original) || !isPlainMap(value) || !isMap(current) || isValueMapPath(path)) {
    doc.setIn(path, doc.createNode(value));
    return;
  }
  mergeRebasedMap(doc, current, value, path);
}

function mergeRebasedMap(doc: Document, target: YAMLMap, value: Record<string, unknown>, parentPath: string[]): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...parentPath, key];
    // YAMLMap.get's overload describes scalars even though a map value is returned intact.
    const existing: unknown = target.get(key, true);
    if (isMap(existing) && isPlainMap(child) && !isValueMapPath(childPath)) {
      mergeRebasedMap(doc, existing, child, childPath);
    } else {
      target.set(key, doc.createNode(child));
    }
  }
}

function isAbsentNode(node: unknown): boolean {
  return node === undefined || node === null || (isScalar(node) && isAbsent(node.value));
}

function diffValue(baseline: unknown, draft: unknown, path: string[], changes: ConfigChange[]): void {
  if (isPlainMap(baseline) && isPlainMap(draft) && !isValueMapPath(path)) {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(draft)]);
    for (const key of keys) {
      diffValue(baseline[key], draft[key], [...path, key], changes);
    }
    return;
  }
  if (isAbsent(draft)) {
    // A null in the draft means "not configured": CPA would store a null as the
    // type's zero value, which is a setting, not its absence.
    if (!isAbsent(baseline)) changes.push({ path, remove: true });
    return;
  }
  if (!isDeepEqual(baseline, draft)) {
    changes.push({ path, value: draft });
  }
}

/** Structural equality where map key order does not count, as it does not for CPA. */
function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => isDeepEqual(item, right[i]));
  }
  if (isPlainMap(left) && isPlainMap(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && isDeepEqual(left[key], right[key]));
  }
  return false;
}

function setOwnEntry(target: Record<string, unknown>, key: string, entryValue: unknown): void {
  Object.defineProperty(target, key, {
    value: entryValue,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (!isPlainMap(value)) return {};
  const copy: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    setOwnEntry(copy, key, entryValue);
  }
  return copy;
}

function rebaseValueMap(
  baseMap: Record<string, unknown>,
  draftMap: Record<string, unknown>,
  nextMap: Record<string, unknown>,
): Record<string, unknown> {
  const merged = toPlainRecord(nextMap);
  for (const key of Object.keys(baseMap)) {
    if (!Object.prototype.hasOwnProperty.call(draftMap, key)) {
      delete merged[key];
    }
  }
  for (const [key, entryValue] of Object.entries(draftMap)) {
    if (!Object.prototype.hasOwnProperty.call(baseMap, key) || !isDeepEqual(baseMap[key], entryValue)) {
      setOwnEntry(merged, key, entryValue);
    }
  }
  return merged;
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}
