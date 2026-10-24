/**
 * The OpenUI program a call carries, read from its argument text.
 *
 * While the model is still writing, the text is a JSON prefix that cannot be parsed as a document,
 * so the `ui` string is read as far as it has arrived: cut back to its last whole character (an
 * escape may have been split by the stream) and decoded on its own. The official renderer parses
 * an unfinished program by its own streaming rules, so this is the only part of streaming OMC does.
 */
export function programOf(argumentsText: string | undefined): string {
  const text = argumentsText ?? '';
  try {
    const value = JSON.parse(text) as { ui?: unknown };
    if (typeof value?.ui === 'string') return value.ui;
  } catch {
    // Still streaming: read the prefix below.
  }
  const match = /"ui"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
  if (!match) return '';
  // A `\uXXXX` escape is six characters, so at most five have to go before the rest decodes.
  for (let cut = 0; cut <= 5 && cut <= match[1].length; cut++) {
    try {
      const program: unknown = JSON.parse(`"${match[1].slice(0, match[1].length - cut)}"`);
      if (typeof program === 'string') return program;
    } catch {
      // Still inside an escape: drop one more character.
    }
  }
  return '';
}

/**
 * Whether answer text is an OpenUI program the model wrote as text instead of into the tool.
 *
 * Some models answer with the program itself - the shape the official chat demo streams - and
 * showing it as Markdown would put raw language in front of the operator. Such text is rendered by
 * the same renderer; anything else stays Markdown.
 */
export function isProgramText(text: string): boolean {
  return /^\s*(?:```[\w-]*\s*\n)?\s*root\s*=\s*[A-Z]\w*\(/.test(text);
}
