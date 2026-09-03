import type { Document } from 'yaml';
import type { ConfigFieldDefinition } from '../../types/configSchema';

/**
 * Deep semantic value extraction for a field from a Document AST.
 * Handles YAML scalar parsing, toJSON methods, and default values.
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
 * Compare two values for semantic equality.
 */
export function areValuesSemanticallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === undefined || a === null || a === '') && (b === undefined || b === null || b === '')) {
    return true;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return isNaN(a) && isNaN(b) ? true : a === b;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Update a field in currentDoc while tracking the baseline serverDoc:
 * - If the new value matches the server baseline:
 *   - If the field originally existed in serverDoc: clone the exact node from serverDoc
 *   - If the field was originally omitted in serverDoc: delete the node from currentDoc!
 *     Also clean up any parent map if it became empty and was also omitted in serverDoc.
 * - If the new value differs from baseline: set the new value.
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

  const serverOriginallyHadField = serverDoc
    ? serverDoc.hasIn(field.yamlPath)
    : false;

  const isMatchingServer = areValuesSemanticallyEqual(newValue, serverBaselineValue);

  if (isMatchingServer) {
    if (serverOriginallyHadField && serverDoc) {
      // Revert to exact node from serverDoc
      const originalNode = serverDoc.getIn(field.yamlPath, true);
      if (originalNode !== undefined) {
        currentDoc.setIn(field.yamlPath, originalNode);
        return;
      }
    } else {
      // Field was originally absent: delete it so no new explicit key is left behind!
      currentDoc.deleteIn(field.yamlPath);

      // If parent path is now empty and was also absent in serverDoc, delete parent
      if (field.yamlPath.length > 1) {
        const parentPath = field.yamlPath.slice(0, -1);
        const parentOriginallyExisted = serverDoc ? serverDoc.hasIn(parentPath) : false;
        if (!parentOriginallyExisted) {
          const parentNode = currentDoc.getIn(parentPath);
          if (
            typeof parentNode === 'object' &&
            parentNode !== null &&
            'items' in parentNode &&
            Array.isArray((parentNode as { items: unknown[] }).items) &&
            (parentNode as { items: unknown[] }).items.length === 0
          ) {
            currentDoc.deleteIn(parentPath);
          }
        }
      }
      return;
    }
  }

  // Value actually changed from server baseline:
  if (newValue === undefined || newValue === null || newValue === '') {
    if (field.type === 'switch') {
      currentDoc.setIn(field.yamlPath, false);
    } else if (field.type === 'number') {
      currentDoc.setIn(field.yamlPath, field.defaultValue ?? 0);
    } else {
      currentDoc.deleteIn(field.yamlPath);
    }
  } else {
    currentDoc.setIn(field.yamlPath, newValue);
  }
}

/**
 * Check whether currentDoc is semantically identical to serverDoc across all known fields and payload.
 */
export function isConfigSemanticallyEqual(
  currentDoc: Document | null,
  serverDoc: Document | null,
  fields: ConfigFieldDefinition[]
): boolean {
  if (!currentDoc || !serverDoc) return false;

  // 1. Check all scalar & complex schema fields
  for (const f of fields) {
    const currentVal = getFieldSemanticValue(currentDoc, f);
    const serverVal = getFieldSemanticValue(serverDoc, f);
    if (!areValuesSemanticallyEqual(currentVal, serverVal)) {
      return false;
    }
  }

  // 2. Check payload subtree
  const currentPayload = currentDoc.get('payload');
  const serverPayload = serverDoc.get('payload');
  const currentPayloadJson = currentPayload && typeof (currentPayload as { toJSON?: () => unknown }).toJSON === 'function'
    ? (currentPayload as { toJSON: () => unknown }).toJSON()
    : currentPayload;
  const serverPayloadJson = serverPayload && typeof (serverPayload as { toJSON?: () => unknown }).toJSON === 'function'
    ? (serverPayload as { toJSON: () => unknown }).toJSON()
    : serverPayload;

  if (JSON.stringify(currentPayloadJson ?? null) !== JSON.stringify(serverPayloadJson ?? null)) {
    return false;
  }

  return true;
}
