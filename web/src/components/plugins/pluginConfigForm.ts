import type { PluginConfigField } from '../../types/plugin';
import { pluginConfigsEqual } from './pluginConfig';

/**
 * The plugin settings form: the fields a plugin declares, edited as typed controls, and
 * composed back into the settings document CPA stores for it.
 *
 * The form edits the whole document rather than a patch. A key the plugin does not
 * declare (an older setting, a hand-written one) is carried through untouched, so
 * saving from the form can never drop something the operator did not see; the JSON
 * view shows and edits those keys. `enabled` and `priority` are the host's own keys
 * and are edited as the form's base settings rather than as plugin fields; `store` is
 * the record CPA writes when it installs a plugin from a registry, which the form shows
 * as where the plugin came from and never edits.
 */

export type PluginFieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object';

export const PLUGIN_INSTALL_RECORD_KEY = 'store';

export const PLUGIN_HOST_KEYS: readonly string[] = ['enabled', 'priority', PLUGIN_INSTALL_RECORD_KEY];

/** What the form shows of CPA's install record: the registry's description of the plugin. */
export interface PluginInstallRecord {
  name?: string;
  version?: string;
  author?: string;
  license?: string;
  description?: string;
  homepage?: string;
  repository?: string;
}

function recordText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readPluginInstallRecord(config: Record<string, unknown>): PluginInstallRecord | undefined {
  const record = config[PLUGIN_INSTALL_RECORD_KEY];
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const source = record as Record<string, unknown>;
  const repository = recordText(source.repository);
  return {
    name: recordText(source.name),
    version: recordText(source.version),
    author: recordText(source.author),
    license: recordText(source.license),
    description: recordText(source.description),
    homepage: recordText(source.homepage),
    // A registry names a repository as `owner/name` or as its address.
    repository: repository && /^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}` : repository,
  };
}

/** How a declared field is edited. An enum without values, or an unknown type, is free text. */
export function pluginFieldKind(field: PluginConfigField): PluginFieldKind {
  const type = (field.type || '').trim().toLowerCase();
  if (type === 'enum') return (field.enum_values?.length ?? 0) > 0 ? 'enum' : 'string';
  if (type === 'bool') return 'boolean';
  if (type === 'int') return 'integer';
  if (type === 'float' || type === 'double') return 'number';
  if (['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type)) return type as PluginFieldKind;
  return 'string';
}

/**
 * Field names that read as credentials. A plugin's manifest has no "secret" type, so the
 * name is the only signal; a match only masks the control, the value is stored as typed.
 */
const SECRET_FIELD_NAME = /(secret|token|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|credential)/i;

export function isSecretPluginField(field: PluginConfigField): boolean {
  return SECRET_FIELD_NAME.test(field.name);
}

export interface PluginFieldDraft {
  /**
   * False when the key is absent, so the plugin's own default applies. The form clears it
   * when a text, choice or list control is emptied; a document that stores an explicit
   * empty value keeps it set until the operator edits that field.
   */
  isSet: boolean;
  text: string;
  checked: boolean;
  /** A list of strings is edited as tags; any other array is edited as JSON text. */
  isList: boolean;
  list: string[];
}

export interface PluginConfigDraft {
  enabled: boolean;
  /** Whether the stored document spells `enabled` out; if not, it is only written once changed. */
  hasEnabledKey: boolean;
  initialEnabled: boolean;
  priority: string;
  fields: Record<string, PluginFieldDraft>;
}

export type PluginFieldError =
  | 'invalid-integer'
  | 'invalid-number'
  | 'invalid-enum'
  | 'invalid-json'
  | 'expected-array'
  | 'expected-object'
  | 'required-value';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function pluginFieldDraftFromValue(field: PluginConfigField, value: unknown, isSet: boolean): PluginFieldDraft {
  const kind = pluginFieldKind(field);
  const draft: PluginFieldDraft = { isSet, text: '', checked: false, isList: false, list: [] };
  if (kind === 'boolean') {
    draft.checked = value === true;
    return draft;
  }
  if (kind === 'array') {
    if (!isSet || isStringList(value)) {
      draft.isList = true;
      draft.list = isStringList(value) ? [...value] : [];
      return draft;
    }
    draft.text = stringifyValue(value);
    return draft;
  }
  if (kind === 'object') {
    draft.text = isSet ? stringifyValue(value) : '';
    return draft;
  }
  draft.text = isSet ? stringifyValue(value) : '';
  return draft;
}

export function buildPluginConfigDraft(
  fields: readonly PluginConfigField[],
  config: Record<string, unknown>,
  fallbackEnabled: boolean,
): PluginConfigDraft {
  const hasEnabledKey = typeof config.enabled === 'boolean';
  const enabled = hasEnabledKey ? (config.enabled as boolean) : fallbackEnabled;
  const priority = typeof config.priority === 'number' || typeof config.priority === 'string' ? String(config.priority) : '';
  const draftFields: Record<string, PluginFieldDraft> = {};
  for (const field of fields) {
    const isSet = Object.prototype.hasOwnProperty.call(config, field.name) && config[field.name] !== null;
    draftFields[field.name] = pluginFieldDraftFromValue(field, config[field.name], isSet);
  }
  return { enabled, hasEnabledKey, initialEnabled: enabled, priority, fields: draftFields };
}

/** The keys in a document that neither the host nor the plugin's manifest declares. */
export function undeclaredPluginKeys(config: Record<string, unknown>, fields: readonly PluginConfigField[]): string[] {
  const declared = new Set([...PLUGIN_HOST_KEYS, ...fields.map((field) => field.name)]);
  return Object.keys(config).filter((key) => !declared.has(key)).sort((left, right) => left.localeCompare(right));
}

/** Reads one field's draft as the value it stores, or the reason it cannot. */
export function readPluginFieldValue(
  field: PluginConfigField,
  draft: PluginFieldDraft,
): { value?: unknown; error?: PluginFieldError } {
  const kind = pluginFieldKind(field);
  if (kind === 'boolean') return { value: draft.checked };
  if (kind === 'array' && draft.isList) return { value: [...draft.list] };
  const text = draft.text.trim();
  if (kind === 'string') return { value: draft.text };
  if (!text) return { error: 'required-value' };
  if (kind === 'enum') {
    return field.enum_values?.includes(text) ? { value: text } : { error: 'invalid-enum' };
  }
  if (kind === 'integer') {
    if (!/^-?\d+$/.test(text)) return { error: 'invalid-integer' };
    const parsed = Number.parseInt(text, 10);
    return Number.isSafeInteger(parsed) ? { value: parsed } : { error: 'invalid-integer' };
  }
  if (kind === 'number') {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? { value: parsed } : { error: 'invalid-number' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'invalid-json' };
  }
  if (kind === 'array' && !Array.isArray(parsed)) return { error: 'expected-array' };
  if (kind === 'object' && !isPlainObject(parsed)) return { error: 'expected-object' };
  return { value: parsed };
}

export interface ComposedPluginConfig {
  value?: Record<string, unknown>;
  errors: Record<string, PluginFieldError>;
}

/**
 * Composes the document the form describes on top of `base`, the document it was built
 * from. Undeclared keys come from `base` untouched; an unset field removes its key.
 */
export function composePluginConfig(
  draft: PluginConfigDraft,
  fields: readonly PluginConfigField[],
  base: Record<string, unknown>,
): ComposedPluginConfig {
  const errors: Record<string, PluginFieldError> = {};
  const value: Record<string, unknown> = {};
  // Defined rather than assigned: a key spelled `__proto__` would otherwise set the
  // object's prototype instead of becoming a key, and the saved document would lose it.
  for (const key of undeclaredPluginKeys(base, fields)) {
    Object.defineProperty(value, key, { value: base[key], enumerable: true, writable: true, configurable: true });
  }

  if (Object.prototype.hasOwnProperty.call(base, PLUGIN_INSTALL_RECORD_KEY)) value[PLUGIN_INSTALL_RECORD_KEY] = base[PLUGIN_INSTALL_RECORD_KEY];

  if (draft.hasEnabledKey || draft.enabled !== draft.initialEnabled) value.enabled = draft.enabled;

  const priority = draft.priority.trim();
  if (priority) {
    if (/^-?\d+$/.test(priority) && Number.isSafeInteger(Number.parseInt(priority, 10))) {
      value.priority = Number.parseInt(priority, 10);
    } else {
      errors.priority = 'invalid-integer';
    }
  }

  for (const field of fields) {
    const fieldDraft = draft.fields[field.name];
    if (!fieldDraft || !fieldDraft.isSet) continue;
    const read = readPluginFieldValue(field, fieldDraft);
    if (read.error) {
      errors[field.name] = read.error;
      continue;
    }
    value[field.name] = read.value;
  }

  return Object.keys(errors).length > 0 ? { errors } : { value, errors };
}

/** Whether one field's draft stores something other than what the saved document holds. */
export function isPluginFieldChanged(
  field: PluginConfigField,
  draft: PluginFieldDraft,
  saved: Record<string, unknown>,
): boolean {
  const wasSet = Object.prototype.hasOwnProperty.call(saved, field.name) && saved[field.name] !== null;
  if (draft.isSet !== wasSet) return true;
  if (!draft.isSet) return false;
  const read = readPluginFieldValue(field, draft);
  if (read.error) return true;
  return !pluginConfigsEqual(read.value, saved[field.name]);
}
