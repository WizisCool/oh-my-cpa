/**
 * A string argument of a tool call, read from its JSON text.
 *
 * While the model is still writing, the text is a JSON prefix that cannot be parsed as a document,
 * so the named string is read as far as it has arrived: cut back to its last whole character (an
 * escape may have been split by the stream) and decoded on its own. This is the only part of
 * streaming OMC does; the renderer parses the finished value.
 */
export function stringArgument(argumentsText: string | undefined, key: string): string {
  const text = argumentsText ?? '';
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (typeof value?.[key] === 'string') return value[key] as string;
  } catch {
    // Still streaming: read the prefix below.
  }
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
  if (!match) return '';
  // A `\uXXXX` escape is six characters, so at most five have to go before the rest decodes.
  for (let cut = 0; cut <= 5 && cut <= match[1].length; cut++) {
    try {
      const value: unknown = JSON.parse(`"${match[1].slice(0, match[1].length - cut)}"`);
      if (typeof value === 'string') return value;
    } catch {
      // Still inside an escape: drop one more character.
    }
  }
  return '';
}
