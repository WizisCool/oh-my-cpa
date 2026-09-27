import { isSeq, type Document } from 'yaml';
import type { ConfigFieldDefinition } from '../../types/configSchema';

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
  let node = doc.getIn(field.yamlPath);
  if ((node === undefined || node === null) && field.legacyYamlPath) {
    // CPA v8 honours a legacy spelling while its v8 location is empty, so that
    // is the value the gateway is running with.
    node = readLegacyNode(doc, field);
  }
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
 * - switches compare as booleans, since a YAML string `"true"` is still an
 *   enabled switch.
 * - objects compare structurally.
 */
export function areValuesSemanticallyEqual(currentValue: unknown, baselineValue: unknown): boolean {
  if (currentValue === baselineValue) return true;
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
    return Boolean(currentValue) === Boolean(baselineValue);
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
    if (field.legacyYamlPath) {
      restorePathFromServer(currentDoc, serverDoc, field.legacyYamlPath);
    }
    return;
  }

  // A cleared value still has to be representable in YAML: an empty string would
  // be written back verbatim, so each field type gets the "off" value it can
  // actually serialise.
  if (newValue === undefined || newValue === null || newValue === '') {
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
  // The legacy spelling goes with every write to the v8 location. Left behind,
  // CPA v8 would ignore it and delete it on its next save anyway; removing it
  // here keeps the document saying one thing.
  if (field.legacyYamlPath && readLegacyNode(currentDoc, field) !== undefined) {
    currentDoc.deleteIn(field.legacyYamlPath);
    pruneEmptyAncestors(currentDoc, serverDoc, field.legacyYamlPath);
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

/** Reads the legacy spelling, applying its shape condition (a list for api-keys). */
function readLegacyNode(doc: Document, field: ConfigFieldDefinition): unknown {
  if (!field.legacyYamlPath) return undefined;
  const node = doc.getIn(field.legacyYamlPath);
  // A parsed list is a YAMLSeq; one written by setIn in this session is a plain array.
  if (field.legacyKind === 'sequence' && !isSeq(node) && !Array.isArray(node)) return undefined;
  return node ?? undefined;
}

/**
 * Reports whether the operator's document matches the server's across every
 * schema field plus the `payload` subtree. The payload is compared as a whole
 * because the rule builder owns its internals and already writes it back in a
 * normalised shape; comparing it field by field would report a difference for a
 * reordering the operator cannot see.
 */
export function isConfigSemanticallyEqual(
  currentDoc: Document | null,
  serverDoc: Document | null,
  fields: ConfigFieldDefinition[],
  payloadPaths: string[][] = [['payload']]
): boolean {
  if (!currentDoc || !serverDoc) return false;

  for (const field of fields) {
    const currentValue = getFieldSemanticValue(currentDoc, field);
    const baselineValue = getFieldSemanticValue(serverDoc, field);
    if (!areValuesSemanticallyEqual(currentValue, baselineValue)) {
      return false;
    }
  }

  for (const payloadPath of payloadPaths) {
    if (JSON.stringify(toPlain(currentDoc.getIn(payloadPath))) !== JSON.stringify(toPlain(serverDoc.getIn(payloadPath)))) {
      return false;
    }
  }

  return true;
}

function toPlain(node: unknown): unknown {
  if (node && typeof (node as { toJSON?: () => unknown }).toJSON === 'function') {
    return (node as { toJSON: () => unknown }).toJSON();
  }
  return node ?? null;
}
