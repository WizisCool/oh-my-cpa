import { isMap, type Document } from 'yaml';

export type PayloadProtocol = '' | 'openai' | 'gemini' | 'claude' | 'codex' | 'antigravity';

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

export type PayloadCategoryKey =
  | 'default'
  | 'default-raw'
  | 'override'
  | 'override-raw'
  | 'filter';

export interface PayloadValidationIssue {
  category: PayloadCategoryKey;
  ruleId: string;
  targetId: string;
  field: 'model' | 'path' | 'value' | 'duplicate';
  messageKey: string;
}

let nextDynamicId = 1;
export function generateDynamicId(prefix = 'dyn'): string {
  return `${prefix}_${Date.now()}_${nextDynamicId++}`;
}

export function isValidJson(str: string): boolean {
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

// ── Synchronize with Document AST ───────────────────────────────────────────
export function readPayloadCategory(doc: Document | null, category: PayloadCategoryKey): unknown {
  if (!doc) return undefined;
  const payloadNode = doc.getIn(['payload', category]);
  if (payloadNode && typeof (payloadNode as { toJSON?: () => unknown }).toJSON === 'function') {
    return (payloadNode as { toJSON: () => unknown }).toJSON();
  }
  return payloadNode;
}

export function writePayloadCategory(
  doc: Document,
  category: PayloadCategoryKey,
  serializedValue: unknown[]
): void {
  // Every write below goes through `setIn`/`deleteIn`, and both throw when an
  // intermediate node is not a collection. A fresh CPA config has no `payload` key at
  // all, and `payload:` left empty is just as common, so the map has to be made
  // writable first. A throw here leaves the React event handler before it reaches the
  // change callback: the document is never updated, nothing reads as dirty, the save
  // bar never appears, and payload rules cannot be saved at all.
  //
  // Made with `createNode`, not `doc.set('payload', {})`. That renders as
  // `payload: {}` and reads back as an empty object, so it looks right, but it stores
  // a plain object rather than a YAMLMap - and the next write through it throws.
  if (!isMap(doc.get('payload', true))) {
    if (serializedValue.length === 0) return;
    doc.set('payload', doc.createNode({}));
  }

  if (serializedValue.length === 0) {
    doc.deleteIn(['payload', category]);
    const payloadNode = doc.get('payload', true);
    // The map goes too once its last category is gone, so a document the operator
    // never configured is not written back with an empty `payload: {}`.
    if (isMap(payloadNode) && payloadNode.items.length === 0) {
      doc.delete('payload');
    }
  } else {
    doc.setIn(['payload', category], serializedValue);
  }
}

export function validateAllPayloadRules(
  defaultRules: PayloadTypedRule[],
  defaultRawRules: PayloadRawRule[],
  overrideRules: PayloadTypedRule[],
  overrideRawRules: PayloadRawRule[],
  filterRules: PayloadFilterRule[]
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

  checkTyped(defaultRules, 'default');
  checkRaw(defaultRawRules, 'default-raw');
  checkTyped(overrideRules, 'override');
  checkRaw(overrideRawRules, 'override-raw');
  checkFilter(filterRules);

  return issues;
}
