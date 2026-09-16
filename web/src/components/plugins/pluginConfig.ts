export interface PluginConfigParseResult {
  value?: Record<string, unknown>;
  error?: string;
}

export function parsePluginConfig(text: string): PluginConfigParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'object-required' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'object-required' };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: 'invalid-json' };
  }
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
