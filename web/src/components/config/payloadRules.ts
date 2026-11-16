import type { MessageKey } from '../../i18n/catalog';
import { isMap, type Document } from 'yaml';

export const PAYLOAD_PROTOCOLS = [
  'openai',
  'gemini',
  'claude',
  'codex',
  'antigravity',
  'meta',
] as const;

export type PayloadProtocol = '' | (typeof PAYLOAD_PROTOCOLS)[number];

export function buildPayloadProtocolOptions(
  defaultLabel: string,
): { value: PayloadProtocol; label: string }[] {
  return [
    { value: '', label: defaultLabel },
    ...PAYLOAD_PROTOCOLS.map((protocol) => ({ value: protocol, label: protocol })),
  ];
}

export interface PayloadKVCondition {
  id: string;
  key: string;
  value: unknown;
}

export interface PayloadModelItem {
  id: string;
  name: string;
  protocol?: PayloadProtocol;
  fromProtocol?: string;
  headers?: PayloadKVCondition[];
  match?: PayloadKVCondition[];
  notMatch?: PayloadKVCondition[];
  exist?: string[];
  notExist?: string[];
  _extra?: Record<string, unknown>;
}

export type ParamValueType = 'string' | 'number' | 'boolean' | 'null' | 'json';

export interface TypedParamItem {
  id: string;
  path: string;
  type: ParamValueType;
  value: unknown;
}

export interface RawParamItem {
  id: string;
  path: string;
  rawJson: string;
}

export interface FilterParamItem {
  id: string;
  path: string;
}

export interface PayloadTypedRule {
  id: string;
  models: PayloadModelItem[];
  params: TypedParamItem[];
  _extra?: Record<string, unknown>;
}

export interface PayloadRawRule {
  id: string;
  models: PayloadModelItem[];
  params: RawParamItem[];
  _extra?: Record<string, unknown>;
}

export interface PayloadFilterRule {
  id: string;
  models: PayloadModelItem[];
  params: FilterParamItem[];
  _extra?: Record<string, unknown>;
}

export interface PayloadReplaceTarget {
  positions: number[];
  all: boolean;
  /** Preserves non-boolean YAML `all` values so edits never drop or coerce them. */
  invalidAll?: { value: unknown };
  /** Preserves non-numeric YAML tokens or unparseable UI tokens so validation flags them. */
  invalidPositions?: string[];
  /** Preserves an unsupported or missing YAML role so edits never silently retarget it to 'user'. */
  invalidRole?: { present: boolean; value?: unknown };
  /** Preserves a non-object YAML target until the operator updates target controls. */
  _rawTarget?: unknown;
  _extra?: Record<string, unknown>;
}

export interface UnresolvedReplacePendingEntry {
  id: string;
  ruleNumber: number;
  text: string;
}

export interface PayloadReplacementItem {
  id: string;
  from: string;
  to: string;
  /** Preserves malformed YAML entries (multiple keys or non-string destination) for validation. */
  _invalidReason?: 'multiple_keys' | 'non_string_value' | 'invalid_entry';
  _rawEntry?: unknown;
}

export interface PayloadReplaceRule {
  id: string;
  models: PayloadModelItem[];
  target: PayloadReplaceTarget;
  replacements: PayloadReplacementItem[];
  /** Preserves non-array YAML `replacements` values until the operator replaces them with a list. */
  invalidReplacements?: { value: unknown };
  _extra?: Record<string, unknown>;
}

export type PayloadCategoryKey =
  | 'default'
  | 'default-raw'
  | 'override'
  | 'override-raw'
  | 'replace'
  | 'filter';

export interface PayloadValidationIssue {
  category: PayloadCategoryKey;
  ruleId: string;
  targetId: string;
  field: 'model' | 'path' | 'value' | 'duplicate' | 'target' | 'replacement';
  messageKey: MessageKey;
}

let nextDynamicId = 1;
export function generateDynamicId(prefix = 'dyn'): string {
  return `${prefix}_${Date.now()}_${nextDynamicId++}`;
}

export function isValidJson(str: string | undefined): boolean {
  if (typeof str !== 'string') return false;
  if (!str.trim()) return false;
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

export function detectParamType(paramValue: unknown): { type: ParamValueType; value: unknown } {
  if (paramValue === null || paramValue === undefined) {
    return { type: 'null', value: null };
  }
  if (typeof paramValue === 'boolean') {
    return { type: 'boolean', value: paramValue };
  }
  if (typeof paramValue === 'number') {
    return { type: 'number', value: paramValue };
  }
  if (typeof paramValue === 'object') {
    return { type: 'json', value: JSON.stringify(paramValue, null, 2) };
  }
  return { type: 'string', value: String(paramValue) };
}

// ── Parse KV Conditions (Headers, Match, NotMatch) ───────────────────────────
function parseKvList(raw: unknown, prefix: string): PayloadKVCondition[] {
  if (!raw) return [];
  const list: PayloadKVCondition[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((entry, entryIndex) => {
      if (typeof entry === 'object' && entry !== null) {
        for (const [key, value] of Object.entries(entry)) {
          list.push({
            id: `${prefix}_${entryIndex}_${key}`,
            key,
            value,
          });
        }
      }
    });
  } else if (typeof raw === 'object' && raw !== null) {
    Object.entries(raw as Record<string, unknown>).forEach(([key, value], entryIndex) => {
      list.push({
        id: `${prefix}_${entryIndex}_${key}`,
        key,
        value,
      });
    });
  }
  return list;
}

function parseStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

export function parseModelItem(item: unknown, stableId: string): PayloadModelItem {
  if (typeof item === 'string') {
    return { id: stableId, name: item };
  }
  if (typeof item === 'object' && item !== null) {
    const raw = item as Record<string, unknown>;
    const {
      name,
      protocol,
      'from-protocol': fromProtocol,
      headers,
      match,
      'not-match': notMatch,
      exist,
      'not-exist': notExist,
      ...extra
    } = raw;

    return {
      id: stableId,
      name: String(name ?? ''),
      protocol: (protocol as PayloadProtocol) ?? '',
      fromProtocol: fromProtocol ? String(fromProtocol) : undefined,
      headers: parseKvList(headers, `${stableId}_hdr`),
      match: parseKvList(match, `${stableId}_match`),
      notMatch: parseKvList(notMatch, `${stableId}_notmatch`),
      exist: parseStringList(exist),
      notExist: parseStringList(notExist),
      _extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  }
  return { id: stableId, name: '' };
}

export function serializeModelItem(item: PayloadModelItem): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...(item._extra ?? {}),
    name: item.name,
  };
  if (item.protocol) {
    result.protocol = item.protocol;
  }
  if (item.fromProtocol) {
    result['from-protocol'] = item.fromProtocol;
  }

  // headers is an object map: { Key: "Value" }
  if (item.headers && item.headers.length > 0) {
    const headersMap: Record<string, string> = {};
    for (const h of item.headers) {
      if (h.key.trim()) {
        headersMap[h.key.trim()] = String(h.value ?? '');
      }
    }
    if (Object.keys(headersMap).length > 0) {
      result.headers = headersMap;
    }
  }

  // match and not-match are lists of single-key objects in official CPA: [ { "key": val } ]
  if (item.match && item.match.length > 0) {
    const matchArr = item.match
      .filter((m) => m.key.trim())
      .map((m) => ({ [m.key.trim()]: m.value }));
    if (matchArr.length > 0) {
      result.match = matchArr;
    }
  }

  if (item.notMatch && item.notMatch.length > 0) {
    const notMatchArr = item.notMatch
      .filter((m) => m.key.trim())
      .map((m) => ({ [m.key.trim()]: m.value }));
    if (notMatchArr.length > 0) {
      result['not-match'] = notMatchArr;
    }
  }

  if (item.exist && item.exist.length > 0) {
    const cleanExist = item.exist.filter((s) => s.trim());
    if (cleanExist.length > 0) result.exist = cleanExist;
  }
  if (item.notExist && item.notExist.length > 0) {
    const cleanNotExist = item.notExist.filter((s) => s.trim());
    if (cleanNotExist.length > 0) result['not-exist'] = cleanNotExist;
  }

  return result;
}

// ── Parse typed rules (default, override) ────────────────────────────────────
export function parseTypedRules(rawArray: unknown, category: string): PayloadTypedRule[] {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.map((ruleObj, rIdx) => {
    const ruleId = `${category}_r${rIdx}`;
    if (typeof ruleObj !== 'object' || ruleObj === null) {
      return { id: ruleId, models: [], params: [] };
    }
    const { models, params, ...extra } = ruleObj as Record<string, unknown>;

    const parsedModels: PayloadModelItem[] = Array.isArray(models)
      ? models.map((m, mIdx) => parseModelItem(m, `${ruleId}_m${mIdx}`))
      : [];

    const parsedParams: TypedParamItem[] = [];
    if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
      Object.entries(params as Record<string, unknown>).forEach(([path, rawVal], pIdx) => {
        const { type, value } = detectParamType(rawVal);

        parsedParams.push({
          id: `${ruleId}_p${pIdx}`,
          path,
          type,
          value,
        });
      });
    }

    return {
      id: ruleId,
      models: parsedModels,
      params: parsedParams,
      _extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  });
}

export function serializeTypedRules(rules: PayloadTypedRule[]): Record<string, unknown>[] {
  return rules.map((r) => {
    const paramsMap: Record<string, unknown> = {};
    for (const p of r.params) {
      if (!p.path.trim()) continue;
      if (p.type === 'number') {
        const n = Number(p.value);
        paramsMap[p.path] = isNaN(n) ? 0 : n;
      } else if (p.type === 'boolean') {
        paramsMap[p.path] = Boolean(p.value);
      } else if (p.type === 'null') {
        paramsMap[p.path] = null;
      } else if (p.type === 'json') {
        try {
          paramsMap[p.path] = JSON.parse(String(p.value));
        } catch {
          // If invalid JSON, preserve text
          paramsMap[p.path] = String(p.value);
        }
      } else {
        paramsMap[p.path] = String(p.value ?? '');
      }
    }

    return {
      ...(r._extra ?? {}),
      models: r.models.map(serializeModelItem),
      params: paramsMap,
    };
  });
}

// ── Parse raw rules (default-raw, override-raw) ──────────────────────────────
export function parseRawRules(rawArray: unknown, category: string): PayloadRawRule[] {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.map((ruleObj, rIdx) => {
    const ruleId = `${category}_r${rIdx}`;
    if (typeof ruleObj !== 'object' || ruleObj === null) {
      return { id: ruleId, models: [], params: [] };
    }
    const { models, params, ...extra } = ruleObj as Record<string, unknown>;

    const parsedModels: PayloadModelItem[] = Array.isArray(models)
      ? models.map((m, mIdx) => parseModelItem(m, `${ruleId}_m${mIdx}`))
      : [];

    const parsedParams: RawParamItem[] = [];
    if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
      Object.entries(params as Record<string, unknown>).forEach(([path, rawVal], pIdx) => {
        const rawJson = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal);

        parsedParams.push({
          id: `${ruleId}_p${pIdx}`,
          path,
          rawJson,
        });
      });
    }

    return {
      id: ruleId,
      models: parsedModels,
      params: parsedParams,
      _extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  });
}

export function serializeRawRules(rules: PayloadRawRule[]): Record<string, unknown>[] {
  return rules.map((r) => {
    const paramsMap: Record<string, string> = {};
    for (const p of r.params) {
      if (!p.path.trim()) continue;
      paramsMap[p.path] = p.rawJson;
    }
    return {
      ...(r._extra ?? {}),
      models: r.models.map(serializeModelItem),
      params: paramsMap,
    };
  });
}

// ── Parse filter rules (filter) ─────────────────────────────────────────────
export function parseFilterRules(rawArray: unknown, category: string): PayloadFilterRule[] {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.map((ruleObj, rIdx) => {
    const ruleId = `${category}_r${rIdx}`;
    if (typeof ruleObj !== 'object' || ruleObj === null) {
      return { id: ruleId, models: [], params: [] };
    }
    const { models, params, ...extra } = ruleObj as Record<string, unknown>;

    const parsedModels: PayloadModelItem[] = Array.isArray(models)
      ? models.map((m, mIdx) => parseModelItem(m, `${ruleId}_m${mIdx}`))
      : [];

    const parsedParams: FilterParamItem[] = [];
    if (Array.isArray(params)) {
      params.forEach((p, pIdx) => {
        if (typeof p === 'string' && p.trim()) {
          parsedParams.push({ id: `${ruleId}_p${pIdx}`, path: p });
        }
      });
    } else if (typeof params === 'object' && params !== null) {
      Object.keys(params as Record<string, unknown>).forEach((p, pIdx) => {
        parsedParams.push({ id: `${ruleId}_p${pIdx}`, path: p });
      });
    }

    return {
      id: ruleId,
      models: parsedModels,
      params: parsedParams,
      _extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  });
}

export function serializeFilterRules(rules: PayloadFilterRule[]): Record<string, unknown>[] {
  return rules.map((r) => {
    return {
      ...(r._extra ?? {}),
      models: r.models.map(serializeModelItem),
      params: r.params.map((p) => p.path).filter(Boolean),
    };
  });
}

// ── Parse & serialize replace rules (replace) ────────────────────────────────
export function parseReplaceRules(rawArray: unknown, category = 'replace'): PayloadReplaceRule[] {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.map((ruleObj, rIdx) => {
    const ruleId = `${category}_r${rIdx}`;
    if (typeof ruleObj !== 'object' || ruleObj === null || Array.isArray(ruleObj)) {
      return {
        id: ruleId,
        models: [],
        target: { positions: [], all: false, invalidRole: { present: false } },
        replacements: [],
      };
    }
    const { models, target, replacements, ...extra } = ruleObj as Record<string, unknown>;

    const parsedModels: PayloadModelItem[] = Array.isArray(models)
      ? models.map((m, mIdx) => parseModelItem(m, `${ruleId}_m${mIdx}`))
      : [];

    let parsedTarget: PayloadReplaceTarget;
    if (target === undefined) {
      parsedTarget = { positions: [], all: false, invalidRole: { present: false } };
    } else if (typeof target !== 'object' || target === null || Array.isArray(target)) {
      parsedTarget = {
        positions: [],
        all: false,
        invalidRole: { present: false },
        _rawTarget: target,
      };
    } else {
      const targetRecord = target as Record<string, unknown>;
      const hasRole = Object.prototype.hasOwnProperty.call(targetRecord, 'role');
      const {
        role: rawRole,
        positions: rawPositions,
        all: rawAll,
        ...targetExtra
      } = targetRecord;
      const invalidRole = hasRole && rawRole === 'user'
        ? undefined
        : hasRole
          ? { present: true, value: rawRole }
          : { present: false };
      const invalidAll = rawAll !== undefined && typeof rawAll !== 'boolean'
        ? { value: rawAll }
        : undefined;
      const positions: number[] = [];
      const invalidPositions: string[] = [];
      if (Array.isArray(rawPositions)) {
        for (const pos of rawPositions) {
          if (typeof pos === 'number') {
            positions.push(pos);
          } else {
            invalidPositions.push(String(pos));
          }
        }
      } else if (rawPositions !== undefined && rawPositions !== null) {
        invalidPositions.push(String(rawPositions));
      }
      parsedTarget = {
        positions,
        all: rawAll === true,
        ...(invalidAll ? { invalidAll } : {}),
        ...(invalidRole ? { invalidRole } : {}),
        ...(invalidPositions.length > 0 ? { invalidPositions } : {}),
        ...(Object.keys(targetExtra).length > 0 ? { _extra: targetExtra } : {}),
      };
    }

    const parsedReplacements: PayloadReplacementItem[] = [];
    const invalidReplacements = replacements !== undefined && !Array.isArray(replacements)
      ? { value: replacements }
      : undefined;
    if (Array.isArray(replacements)) {
      replacements.forEach((entry, repIdx) => {
        const repId = `${ruleId}_rep${repIdx}`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          parsedReplacements.push({
            id: repId,
            from: '',
            to: '',
            _invalidReason: 'invalid_entry',
            _rawEntry: entry,
          });
          return;
        }
        const entries = Object.entries(entry as Record<string, unknown>);
        if (entries.length === 0) {
          parsedReplacements.push({
            id: repId,
            from: '',
            to: '',
            _invalidReason: 'invalid_entry',
            _rawEntry: entry,
          });
          return;
        }
        if (entries.length > 1) {
          const [firstKey, firstVal] = entries[0];
          parsedReplacements.push({
            id: repId,
            from: firstKey,
            to: typeof firstVal === 'string' ? firstVal : String(firstVal ?? ''),
            _invalidReason: 'multiple_keys',
            _rawEntry: entry,
          });
          return;
        }
        const [fromKey, toVal] = entries[0];
        if (typeof toVal !== 'string') {
          parsedReplacements.push({
            id: repId,
            from: fromKey,
            to: toVal == null ? '' : String(toVal),
            _invalidReason: 'non_string_value',
            _rawEntry: entry,
          });
          return;
        }
        parsedReplacements.push({
          id: repId,
          from: fromKey,
          to: toVal,
        });
      });
    }

    return {
      id: ruleId,
      models: parsedModels,
      target: parsedTarget,
      replacements: parsedReplacements,
      ...(invalidReplacements ? { invalidReplacements } : {}),
      _extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  });
}

export function appendReplacePositionTokens(
  rawText: string,
  positions: readonly number[],
  invalidPositions: readonly string[] = [],
): { positions: number[]; invalidPositions: string[]; changed: boolean } {
  const tokens = rawText.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) {
    return {
      positions: [...positions],
      invalidPositions: [...invalidPositions],
      changed: false,
    };
  }

  const nextPositions = [...positions];
  const nextInvalid = [...invalidPositions];
  let changed = false;

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    if (/^-?\d+(?:\.\d+)?$/.test(token)) {
      const parsed = Number(token);
      if (Number.isFinite(parsed)) {
        if (!nextPositions.includes(parsed)) {
          nextPositions.push(parsed);
          changed = true;
        }
        continue;
      }
    }
    if (!nextInvalid.includes(token)) {
      nextInvalid.push(token);
      changed = true;
    }
  }

  return {
    positions: nextPositions,
    invalidPositions: nextInvalid,
    changed,
  };
}

function canonicalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForFingerprint);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      Object.defineProperty(out, key, {
        value: canonicalizeForFingerprint(record[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export function areModelItemsEqual(left: PayloadModelItem, right: PayloadModelItem): boolean {
  const stripIds = (item: PayloadModelItem) => ({
    name: item.name,
    protocol: item.protocol ?? '',
    fromProtocol: item.fromProtocol ?? '',
    headers: (item.headers ?? []).map(({ key, value }) => ({ key, value })),
    match: (item.match ?? []).map(({ key, value }) => ({ key, value })),
    notMatch: (item.notMatch ?? []).map(({ key, value }) => ({ key, value })),
    exist: item.exist ?? [],
    notExist: item.notExist ?? [],
    _extra: item._extra ?? null,
  });
  return (
    JSON.stringify(canonicalizeForFingerprint(stripIds(left)))
    === JSON.stringify(canonicalizeForFingerprint(stripIds(right)))
  );
}

function nextReservedId(prefix: string, reserved: Set<string>): string {
  let id = generateDynamicId(prefix);
  while (reserved.has(id)) {
    id = generateDynamicId(prefix);
  }
  reserved.add(id);
  return id;
}

function reconcileRuleList<T extends { id: string; models: PayloadModelItem[] }>(
  incoming: readonly T[],
  previous: readonly T[],
  rulePrefix: string,
  fingerprint: (rule: T) => string,
  mapMatchedChildren: (rule: T, prev: T | undefined, reservedModelIds: Set<string>) => Partial<T>,
): T[] {
  if (incoming.length === 0 || previous.length === 0) {
    return [...incoming];
  }

  const prevSerialized = previous.map(fingerprint);
  const nextSerialized = incoming.map(fingerprint);
  const usedPrevIndices = new Set<number>();
  const matchedPrev: Array<T | undefined> = Array(incoming.length).fill(undefined);

  // Pass 1: LCS on exact serialized rule content preserves identity & order across concurrent insertions.
  const m = incoming.length;
  const n = previous.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (nextSerialized[i] === prevSerialized[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (nextSerialized[i] === prevSerialized[j]) {
      matchedPrev[i] = previous[j];
      usedPrevIndices.add(j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  // Pass 2: match reordered identical rules; rules whose content changed concurrently do not
  // inherit an older rule's identity or pending edits.
  for (let idx = 0; idx < m; idx += 1) {
    if (matchedPrev[idx]) continue;
    const matchIdx = previous.findIndex(
      (_prev, prevIdx) => !usedPrevIndices.has(prevIdx) && prevSerialized[prevIdx] === nextSerialized[idx],
    );
    if (matchIdx !== -1) {
      usedPrevIndices.add(matchIdx);
      matchedPrev[idx] = previous[matchIdx];
    }
  }

  const reservedRuleIds = new Set(previous.map((prev) => prev.id));
  const reservedModelIds = new Set(previous.flatMap((prev) => prev.models.map((item) => item.id)));

  return incoming.map((rule, idx) => {
    const prev = matchedPrev[idx];
    const extraChildren = mapMatchedChildren(rule, prev, reservedModelIds);
    if (!prev) {
      return {
        ...rule,
        id: nextReservedId(rulePrefix, reservedRuleIds),
        models: rule.models.map((mItem) => ({ ...mItem, id: nextReservedId('m', reservedModelIds) })),
        ...extraChildren,
      };
    }
    return {
      ...rule,
      id: prev.id,
      models: rule.models.map((mItem, mIdx) => (
        prev.models[mIdx] ? { ...mItem, id: prev.models[mIdx].id } : { ...mItem, id: nextReservedId('m', reservedModelIds) }
      )),
      ...extraChildren,
    };
  });
}

export function reconcileTypedRules(
  incoming: readonly PayloadTypedRule[],
  previous: readonly PayloadTypedRule[],
): PayloadTypedRule[] {
  const reservedParamIds = new Set(previous.flatMap((prev) => prev.params.map((p) => p.id)));
  return reconcileRuleList(
    incoming,
    previous,
    'rule',
    (rule) => JSON.stringify(canonicalizeForFingerprint(serializeTypedRules([rule])[0])),
    (rule, prev) => ({
      params: rule.params.map((param, pIdx) => (
        prev?.params[pIdx]
          ? { ...param, id: prev.params[pIdx].id }
          : { ...param, id: nextReservedId('p', reservedParamIds) }
      )),
    }),
  );
}

export function reconcileRawRules(
  incoming: readonly PayloadRawRule[],
  previous: readonly PayloadRawRule[],
): PayloadRawRule[] {
  const reservedParamIds = new Set(previous.flatMap((prev) => prev.params.map((p) => p.id)));
  return reconcileRuleList(
    incoming,
    previous,
    'raw',
    (rule) => JSON.stringify(canonicalizeForFingerprint(serializeRawRules([rule])[0])),
    (rule, prev) => ({
      params: rule.params.map((param, pIdx) => (
        prev?.params[pIdx]
          ? { ...param, id: prev.params[pIdx].id }
          : { ...param, id: nextReservedId('p', reservedParamIds) }
      )),
    }),
  );
}

export function reconcileFilterRules(
  incoming: readonly PayloadFilterRule[],
  previous: readonly PayloadFilterRule[],
): PayloadFilterRule[] {
  const reservedParamIds = new Set(previous.flatMap((prev) => prev.params.map((p) => p.id)));
  return reconcileRuleList(
    incoming,
    previous,
    'filter',
    (rule) => JSON.stringify(canonicalizeForFingerprint(serializeFilterRules([rule])[0])),
    (rule, prev) => ({
      params: rule.params.map((param, pIdx) => (
        prev?.params[pIdx]
          ? { ...param, id: prev.params[pIdx].id }
          : { ...param, id: nextReservedId('fp', reservedParamIds) }
      )),
    }),
  );
}

export function reconcileReplaceRules(
  incoming: readonly PayloadReplaceRule[],
  previous: readonly PayloadReplaceRule[],
): PayloadReplaceRule[] {
  const reservedRepIds = new Set(previous.flatMap((prev) => prev.replacements.map((rep) => rep.id)));
  return reconcileRuleList(
    incoming,
    previous,
    'replace_rule',
    (rule) => JSON.stringify(canonicalizeForFingerprint(serializeReplaceRules([rule])[0])),
    (rule, prev) => ({
      replacements: rule.replacements.map((rep, repIdx) => (
        prev?.replacements[repIdx]
          ? { ...rep, id: prev.replacements[repIdx].id }
          : { ...rep, id: nextReservedId('rep', reservedRepIds) }
      )),
    }),
  );
}

export function serializeReplaceRules(rules: PayloadReplaceRule[]): Record<string, unknown>[] {
  return rules.map((r) => {
    let targetOut: unknown;
    if (r.target._rawTarget !== undefined) {
      targetOut = r.target._rawTarget;
    } else {
      const targetObj: Record<string, unknown> = {
        ...(r.target._extra ?? {}),
      };
      if (!r.target.invalidRole) {
        targetObj.role = 'user';
      } else if (r.target.invalidRole.present) {
        targetObj.role = r.target.invalidRole.value;
      }
      if (r.target.invalidAll) {
        targetObj.all = r.target.invalidAll.value;
      } else if (r.target.all) {
        targetObj.all = true;
      }
      const serializedPositions: unknown[] = [
        ...r.target.positions,
        ...(r.target.invalidPositions ?? []),
      ];
      if (serializedPositions.length > 0) {
        targetObj.positions = serializedPositions;
      }
      targetOut = targetObj;
    }

    const replacementsOut: unknown = r.invalidReplacements
      ? r.invalidReplacements.value
      : r.replacements.map((rep) => {
          if (rep._invalidReason && Object.prototype.hasOwnProperty.call(rep, '_rawEntry')) {
            return rep._rawEntry;
          }
          const entry: Record<string, string> = {};
          Object.defineProperty(entry, rep.from, {
            value: rep.to,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          return entry;
        });

    return {
      ...(r._extra ?? {}),
      models: r.models.map(serializeModelItem),
      target: targetOut,
      replacements: replacementsOut,
    };
  });
}

// ── Synchronize with Document AST ───────────────────────────────────────────

/** Where CPA v8 keeps the payload rules. */
export const PAYLOAD_PATH = ['requests', 'payload'];

export function readPayloadCategory(doc: Document | null, category: PayloadCategoryKey): unknown {
  if (!doc) return undefined;
  const payloadNode = doc.getIn([...PAYLOAD_PATH, category]);
  if (payloadNode && typeof (payloadNode as { toJSON?: () => unknown }).toJSON === 'function') {
    return (payloadNode as { toJSON: () => unknown }).toJSON();
  }
  return payloadNode;
}

export function writePayloadCategory(doc: Document, category: PayloadCategoryKey, serializedValue: unknown[]): void {
  if (serializedValue.length === 0) {
    // deleteIn throws when a map on the way is missing, so the category is only
    // removed while its section is a map.
    if (isMap(doc.getIn(PAYLOAD_PATH, true))) {
      doc.deleteIn([...PAYLOAD_PATH, category]);
    }
    // The maps go too once their last entry is gone, so a document the operator
    // never configured is not written back with an empty `payload: {}`.
    pruneEmptyMaps(doc, PAYLOAD_PATH);
    return;
  }
  // Every write below goes through `setIn`, and it throws when an intermediate
  // node is not a collection. A fresh CPA config has no payload key at all, and
  // `payload:` left empty is just as common, so each level has to be made
  // writable first. A throw here leaves the React event handler before it reaches
  // the change callback: the document is never updated, nothing reads as dirty,
  // the save bar never appears, and payload rules cannot be saved at all.
  //
  // Made with `createNode`, not `doc.set('payload', {})`. That renders as
  // `payload: {}` and reads back as an empty object, so it looks right, but it
  // stores a plain object rather than a YAMLMap - and the next write through it
  // throws.
  for (let depth = 1; depth <= PAYLOAD_PATH.length; depth += 1) {
    const levelPath = PAYLOAD_PATH.slice(0, depth);
    if (!isMap(doc.getIn(levelPath, true))) {
      doc.setIn(levelPath, doc.createNode({}));
    }
  }
  doc.setIn([...PAYLOAD_PATH, category], serializedValue);
}

/** Deletes the maps along a path that no longer hold anything, deepest first. */
function pruneEmptyMaps(doc: Document, path: string[]): void {
  for (let depth = path.length; depth > 0; depth -= 1) {
    const levelPath = path.slice(0, depth);
    const node = doc.getIn(levelPath, true);
    if (!isMap(node) || node.items.length > 0) return;
    doc.deleteIn(levelPath);
  }
}

export function validateAllPayloadRules(
  defaultRules: PayloadTypedRule[],
  defaultRawRules: PayloadRawRule[],
  overrideRules: PayloadTypedRule[],
  overrideRawRules: PayloadRawRule[],
  filterRules: PayloadFilterRule[],
  replaceRules: PayloadReplaceRule[] = []
): PayloadValidationIssue[] {
  const issues: PayloadValidationIssue[] = [];

  const checkTyped = (rules: PayloadTypedRule[], category: 'default' | 'override') => {
    rules.forEach((r) => {
      if (r.models.length === 0) {
        issues.push({
          category,
          ruleId: r.id,
          targetId: r.id,
          field: 'model',
          messageKey: 'cfg.payload_rule_need_model',
        });
      }
      r.models.forEach((m) => {
        if (!m.name.trim()) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: m.id,
            field: 'model',
            messageKey: 'cfg.payload_model_name_empty',
          });
        }
      });

      if (r.params.length === 0) {
        issues.push({
          category,
          ruleId: r.id,
          targetId: r.id,
          field: 'path',
          messageKey: 'cfg.payload_rule_need_param',
        });
      }
      const pathCounts = new Map<string, number>();
      r.params.forEach((p) => {
        const trimmed = p.path.trim();
        if (trimmed) pathCounts.set(trimmed, (pathCounts.get(trimmed) || 0) + 1);
      });

      r.params.forEach((p) => {
        const trimmed = p.path.trim();
        if (!trimmed) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: p.id,
            field: 'path',
            messageKey: 'cfg.payload_param_path_empty',
          });
        } else if ((pathCounts.get(trimmed) || 0) > 1) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: p.id,
            field: 'duplicate',
            messageKey: 'cfg.payload_param_duplicate',
          });
        }
        if (p.type === 'json' && !isValidJson(String(p.value ?? ''))) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: p.id,
            field: 'value',
            messageKey: 'cfg.payload_param_json_invalid',
          });
        }
      });
    });
  };

  const checkRaw = (rules: PayloadRawRule[], category: 'default-raw' | 'override-raw') => {
    rules.forEach((r) => {
      if (r.models.length === 0) {
        issues.push({
          category,
          ruleId: r.id,
          targetId: r.id,
          field: 'model',
          messageKey: 'cfg.payload_rule_need_model',
        });
      }
      r.models.forEach((m) => {
        if (!m.name.trim()) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: m.id,
            field: 'model',
            messageKey: 'cfg.payload_model_name_empty',
          });
        }
      });

      if (r.params.length === 0) {
        issues.push({
          category,
          ruleId: r.id,
          targetId: r.id,
          field: 'path',
          messageKey: 'cfg.payload_rule_need_param',
        });
      }
      const pathCounts = new Map<string, number>();
      r.params.forEach((p) => {
        const trimmed = p.path.trim();
        if (trimmed) pathCounts.set(trimmed, (pathCounts.get(trimmed) || 0) + 1);
      });

      r.params.forEach((p) => {
        const trimmed = p.path.trim();
        if (!trimmed) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: p.id,
            field: 'path',
            messageKey: 'cfg.payload_param_path_empty',
          });
        } else if ((pathCounts.get(trimmed) || 0) > 1) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: p.id,
            field: 'duplicate',
            messageKey: 'cfg.payload_param_duplicate',
          });
        }
        if (!isValidJson(p.rawJson)) {
          issues.push({
            category,
            ruleId: r.id,
            targetId: p.id,
            field: 'value',
            messageKey: 'cfg.payload_param_json_invalid',
          });
        }
      });
    });
  };

  const checkFilter = (rules: PayloadFilterRule[]) => {
    rules.forEach((r) => {
      if (r.models.length === 0) {
        issues.push({
          category: 'filter',
          ruleId: r.id,
          targetId: r.id,
          field: 'model',
          messageKey: 'cfg.payload_rule_need_model',
        });
      }
      r.models.forEach((m) => {
        if (!m.name.trim()) {
          issues.push({
            category: 'filter',
            ruleId: r.id,
            targetId: m.id,
            field: 'model',
            messageKey: 'cfg.payload_model_name_empty',
          });
        }
      });

      if (r.params.length === 0) {
        issues.push({
          category: 'filter',
          ruleId: r.id,
          targetId: r.id,
          field: 'path',
          messageKey: 'cfg.payload_rule_need_param',
        });
      }
      const pathCounts = new Map<string, number>();
      r.params.forEach((p) => {
        const trimmed = p.path.trim();
        if (trimmed) pathCounts.set(trimmed, (pathCounts.get(trimmed) || 0) + 1);
      });

      r.params.forEach((p) => {
        const trimmed = p.path.trim();
        if (!trimmed) {
          issues.push({
            category: 'filter',
            ruleId: r.id,
            targetId: p.id,
            field: 'path',
            messageKey: 'cfg.payload_param_path_empty',
          });
        } else if ((pathCounts.get(trimmed) || 0) > 1) {
          issues.push({
            category: 'filter',
            ruleId: r.id,
            targetId: p.id,
            field: 'duplicate',
            messageKey: 'cfg.payload_param_duplicate',
          });
        }
      });
    });
  };

  const checkReplace = (rules: PayloadReplaceRule[]) => {
    rules.forEach((r) => {
      if (r.models.length === 0) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId: `${r.id}_models`,
          field: 'model',
          messageKey: 'cfg.payload_rule_need_model',
        });
      }
      r.models.forEach((m) => {
        if (!m.name.trim()) {
          issues.push({
            category: 'replace',
            ruleId: r.id,
            targetId: m.id,
            field: 'model',
            messageKey: 'cfg.payload_model_name_empty',
          });
        }
      });

      const hasPositions = r.target.positions.length > 0 || (r.target.invalidPositions?.length ?? 0) > 0;
      const targetId = `${r.id}_target`;
      if (r.target.invalidRole) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId,
          field: 'target',
          messageKey: 'cfg.payload_replace_role_invalid',
        });
      }
      if (r.target.invalidAll) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId,
          field: 'target',
          messageKey: 'cfg.payload_replace_all_invalid',
        });
      }
      if (r.target.all && hasPositions) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId,
          field: 'target',
          messageKey: 'cfg.payload_replace_target_conflict',
        });
      } else if (!r.target.all && !r.target.invalidAll && !hasPositions) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId,
          field: 'target',
          messageKey: 'cfg.payload_replace_positions_required',
        });
      } else if (
        !r.target.all
        && (r.target.positions.some((p) => !Number.isInteger(p) || p < 1) || (r.target.invalidPositions?.length ?? 0) > 0)
      ) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId,
          field: 'target',
          messageKey: 'cfg.payload_replace_positions_invalid',
        });
      }

      if (r.invalidReplacements) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId: `${r.id}_replacements`,
          field: 'replacement',
          messageKey: 'cfg.payload_replace_list_invalid',
        });
      } else if (r.replacements.length === 0) {
        issues.push({
          category: 'replace',
          ruleId: r.id,
          targetId: `${r.id}_replacements`,
          field: 'replacement',
          messageKey: 'cfg.payload_replace_need_replacement',
        });
      }
      r.replacements.forEach((rep) => {
        if (rep._invalidReason === 'multiple_keys' || rep._invalidReason === 'invalid_entry') {
          issues.push({
            category: 'replace',
            ruleId: r.id,
            targetId: rep.id,
            field: 'replacement',
            messageKey: 'cfg.payload_replace_entry_invalid',
          });
        } else if (rep._invalidReason === 'non_string_value') {
          issues.push({
            category: 'replace',
            ruleId: r.id,
            targetId: rep.id,
            field: 'replacement',
            messageKey: 'cfg.payload_replace_dest_invalid',
          });
        } else if (rep.from.length === 0) {
          issues.push({
            category: 'replace',
            ruleId: r.id,
            targetId: rep.id,
            field: 'replacement',
            messageKey: 'cfg.payload_replace_source_empty',
          });
        }
      });
    });
  };

  checkTyped(defaultRules, 'default');
  checkRaw(defaultRawRules, 'default-raw');
  checkTyped(overrideRules, 'override');
  checkRaw(overrideRawRules, 'override-raw');
  checkReplace(replaceRules);
  checkFilter(filterRules);

  return issues;
}

export function buildUnresolvedPendingIssues(
  entries: readonly UnresolvedReplacePendingEntry[],
): PayloadValidationIssue[] {
  return entries.map((entry) => ({
    category: 'replace',
    ruleId: entry.id,
    targetId: entry.id,
    field: 'target',
    messageKey: 'cfg.payload_replace_pending_unresolved',
  }));
}

export function validatePayloadDocument(
  doc: Document | null,
  unresolvedReplacePending: readonly UnresolvedReplacePendingEntry[] = [],
): PayloadValidationIssue[] {
  if (!doc) return buildUnresolvedPendingIssues(unresolvedReplacePending);
  return [
    ...validateAllPayloadRules(
      parseTypedRules(readPayloadCategory(doc, 'default'), 'default'),
      parseRawRules(readPayloadCategory(doc, 'default-raw'), 'default-raw'),
      parseTypedRules(readPayloadCategory(doc, 'override'), 'override'),
      parseRawRules(readPayloadCategory(doc, 'override-raw'), 'override-raw'),
      parseFilterRules(readPayloadCategory(doc, 'filter'), 'filter'),
      parseReplaceRules(readPayloadCategory(doc, 'replace'), 'replace'),
    ),
    ...buildUnresolvedPendingIssues(unresolvedReplacePending),
  ];
}
