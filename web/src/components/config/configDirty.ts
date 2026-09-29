import type { Document } from 'yaml';
import type { ConfigFieldDefinition } from '../../types/configSchema';
import { PAYLOAD_PATH } from './payloadRules';

/**
 * Reads a field's current value out of the parsed document, unwrapping YAML AST
 * nodes, and falls back to the schema default when the key is absent.
 *
 * Callers compare the result against the same function applied to the server
 * document, so the default fallback has to be symmetric: without it, a key the
 * operator never touched would look changed merely because one side is absent.
 */
export function getFieldSemanticValue(
  doc: Document | null,
  field: ConfigFieldDefinition
): unknown {
  if (!doc) return field.defaultValue;
  const node = doc.getIn(field.yamlPath);
  if (node === undefined || node === null) {
    return field.defaultValue;
  }
  if (typeof node === 'object' && 'toJSON' in node && typeof (node as { toJSON: () => unknown }).toJSON === 'function') {
    return (node as { toJSON: () => unknown }).toJSON();
  }
  return node;
}

/**
 * Compares two field values the way the dirty check needs them compared, which
 * is deliberately looser than `===`:
 *
 * - absent, `null` and `""` are the same fact. A YAML round-trip cannot keep
 *   those three apart, so treating them as different states would keep the save
 *   bar lit for a change the operator never made.
 * - numbers compare numerically, with `NaN` equal to `NaN`, because an
 *   unparseable numeric field must not read as "dirty" on every render.
 * - switches compare as booleans ("true"/"false" strings included), while any other string
 *   beside a boolean is a distinct state.
 * - objects compare structurally.
 */
export function areValuesSemanticallyEqual(currentValue: unknown, baselineValue: unknown): boolean {
  if (currentValue === baselineValue) return true;
  // An empty list and an absent one are the same fact for every list the editor owns.
  const isEmptyList = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  if (Array.isArray(currentValue) || Array.isArray(baselineValue)) {
    if (isEmptyList(currentValue) && isEmptyList(baselineValue)) return true;
  }
  if (
    (currentValue === undefined || currentValue === null || currentValue === '') &&
    (baselineValue === undefined || baselineValue === null || baselineValue === '')
  ) {
    return true;
  }
  if (typeof currentValue === 'number' && typeof baselineValue === 'number') {
    return isNaN(currentValue) && isNaN(baselineValue) ? true : currentValue === baselineValue;
  }
  if (typeof currentValue === 'boolean' || typeof baselineValue === 'boolean') {
    // A switch stored as the string "true" is still on, and an absent one is off. Any other
    // string is a distinct state of a mixed setting (disable-image-generation's "chat"), not a
    // truthy boolean, so it only equals the same string.
    const asBoolean = (value: unknown): boolean | undefined => {
      if (typeof value === 'boolean') return value;
      if (value === undefined || value === null || value === '') return false;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    };
    const current = asBoolean(currentValue);
    const baseline = asBoolean(baselineValue);
    if (current === undefined || baseline === undefined) return String(currentValue) === String(baselineValue);
    return current === baseline;
  }
  if (typeof currentValue === 'object' && typeof baselineValue === 'object') {
    return JSON.stringify(currentValue) === JSON.stringify(baselineValue);
  }
  return false;
}

/**
 * Writes one field into `currentDoc` while keeping `serverDoc` as the baseline.
 *
 * The invariant this exists for: returning a field to its baseline value must
 * leave the document byte-identical to the server's, not merely semantically
 * equal. Two rules follow. A field that existed on the server is restored from
 * the server's own node, so scalar style and comments survive. A field the
 * server omitted is deleted again, and a parent map that the deletion empties is
 * removed too — otherwise the editor would write `headers: {}` into config the
 * operator never configured, and the next save would push that noise upstream.
 */
export function updateFieldWithBaseline(
  currentDoc: Document,
  serverDoc: Document | null,
  field: ConfigFieldDefinition,
  newValue: unknown
): void {
  const serverBaselineValue = serverDoc
    ? getFieldSemanticValue(serverDoc, field)
    : field.defaultValue;

  if (areValuesSemanticallyEqual(newValue, serverBaselineValue)) {
    restorePathFromServer(currentDoc, serverDoc, field.yamlPath);
    return;
  }

  // A cleared value still has to be representable in YAML: an empty string would
  // be written back verbatim, so each field type gets the "off" value it can
  // actually serialise.
  if (newValue === undefined || newValue === null || newValue === '' || (Array.isArray(newValue) && newValue.length === 0)) {
    if (field.type === 'switch') {
      currentDoc.setIn(field.yamlPath, false);
    } else if (field.type === 'number') {
      currentDoc.setIn(field.yamlPath, field.defaultValue ?? 0);
    } else {
      currentDoc.deleteIn(field.yamlPath);
      pruneEmptyAncestors(currentDoc, serverDoc, field.yamlPath);
    }
  } else {
    currentDoc.setIn(field.yamlPath, newValue);
  }
}

/**
 * Puts one path back the way the server has it: the server's own node when it had
 * one, so scalar style and comments survive, otherwise nothing at all.
 */
function restorePathFromServer(currentDoc: Document, serverDoc: Document | null, path: string[]): void {
  if (serverDoc?.hasIn(path)) {
    const originalNode = serverDoc.getIn(path, true);
    if (originalNode !== undefined) {
      currentDoc.setIn(path, originalNode);
      return;
    }
  }
  if (currentDoc.hasIn(path)) {
    currentDoc.deleteIn(path);
  }
  pruneEmptyAncestors(currentDoc, serverDoc, path);
}

/**
 * Removes the maps a deletion emptied, nearest first, as long as the server did
 * not have them: a v8 location is up to three maps deep, and the editor must not
 * leave `observability: {logs: {}}` in a document the operator never configured.
 */
function pruneEmptyAncestors(currentDoc: Document, serverDoc: Document | null, path: string[]): void {
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parentPath = path.slice(0, depth);
    if (serverDoc ? serverDoc.hasIn(parentPath) : false) return;
    const parentNode = currentDoc.getIn(parentPath);
    if (
      typeof parentNode === 'object' &&
      parentNode !== null &&
      'items' in parentNode &&
      Array.isArray((parentNode as { items: unknown[] }).items) &&
      (parentNode as { items: unknown[] }).items.length === 0
    ) {
      currentDoc.deleteIn(parentPath);
    } else {
      return;
    }
  }
}

/**
 * Reports whether the operator's document matches the server's across every
 * schema field plus the `requests.payload` subtree. The payload is compared as a whole
 * because the rule builder owns its internals and already writes it back in a
 * normalised shape; comparing it field by field would report a difference for a
 * reordering the operator cannot see.
 */
export function isConfigSemanticallyEqual(
  currentDoc: Document | null,
  serverDoc: Document | null,
  fields: ConfigFieldDefinition[],
  payloadPath: string[] = PAYLOAD_PATH
): boolean {
  if (!currentDoc || !serverDoc) return false;

  for (const field of fields) {
    const currentValue = getFieldSemanticValue(currentDoc, field);
    const baselineValue = getFieldSemanticValue(serverDoc, field);
    if (!areValuesSemanticallyEqual(currentValue, baselineValue)) {
      return false;
    }
  }

  return JSON.stringify(toPlain(currentDoc.getIn(payloadPath))) === JSON.stringify(toPlain(serverDoc.getIn(payloadPath)));
}

function toPlain(node: unknown): unknown {
  if (node && typeof (node as { toJSON?: () => unknown }).toJSON === 'function') {
    return (node as { toJSON: () => unknown }).toJSON();
  }
  return node ?? null;
}
