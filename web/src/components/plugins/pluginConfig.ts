export type PluginConfigParseError = 'object-required' | 'invalid-json' | 'duplicate-key';

export interface PluginConfigParseResult {
  value?: Record<string, unknown>;
  error?: PluginConfigParseError;
  /** The repeated member name, present only for `duplicate-key`. */
  key?: string;
}

/**
 * parsePluginConfig validates the JSON the config editor submits.
 *
 * Duplicate members are rejected rather than parsed: `JSON.parse` keeps the last
 * value of `{"level":"info","level":"debug"}` and reports nothing, so the object
 * that would be saved is not the text the operator reviewed and the preview beside
 * it cannot show the difference.
 */
export function parsePluginConfig(text: string): PluginConfigParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'object-required' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'object-required' };
  }
  const duplicate = findDuplicateObjectKey(trimmed);
  if (duplicate !== undefined) return { error: 'duplicate-key', key: duplicate };
  return { value: parsed as Record<string, unknown> };
}

/**
 * findDuplicateObjectKey reports the first member name that appears twice inside one
 * object, or `undefined` when every object names each member once.
 *
 * It walks the text rather than the parsed value, because the parser has already
 * discarded the evidence. It runs only after `JSON.parse` accepted the whole
 * document, so the tokenizer can assume well-formed JSON and only has to get
 * string boundaries right. Member names are decoded through the parser so two
 * names that differ only in escaping still compare equal.
 */
export function findDuplicateObjectKey(text: string): string | undefined {
  let index = 0;

  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };

  const readString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== '"') {
      index += text[index] === '\\' ? 2 : 1;
    }
    index += 1;
    return JSON.parse(text.slice(start, index)) as string;
  };

  const readValue = (): string | undefined => {
    skipWhitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      const seen = new Set<string>();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return undefined;
      }
      for (;;) {
        skipWhitespace();
        const name = readString();
        if (seen.has(name)) return name;
        seen.add(name);
        skipWhitespace();
        index += 1; // ':'
        const nested = readValue();
        if (nested !== undefined) return nested;
        skipWhitespace();
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        index += 1; // '}'
        return undefined;
      }
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return undefined;
      }
      for (;;) {
        const nested = readValue();
        if (nested !== undefined) return nested;
        skipWhitespace();
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        index += 1; // ']'
        return undefined;
      }
    }
    if (character === '"') {
      readString();
      return undefined;
    }
    while (index < text.length && !',}]'.includes(text[index])) index += 1;
    return undefined;
  };

  return readValue();
}

export function pluginConfigSummary(value: Record<string, unknown>): Array<{ key: string; type: string }> {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => ({
      key,
      type: describeValue(entry),
    }));
}

export function pluginConfigsEqual(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value === null) return 'null';
  return typeof value;
}
