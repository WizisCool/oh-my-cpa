import { stringArgument } from '../toolArguments';

/**
 * The OpenUI program a call carries, read from its argument text.
 *
 * The renderer parses an unfinished program by its own streaming rules, so reading the `ui` string
 * as far as it has arrived is the only part of streaming OMC does.
 */
export function programOf(argumentsText: string | undefined): string {
  return stringArgument(argumentsText, 'ui');
}

/**
 * Whether answer text is an OpenUI program the model wrote as text instead of into the tool.
 *
 * Some models answer with the program itself - the shape the official chat demo streams - and
 * showing it as Markdown would put raw language in front of the operator. Such text is rendered by
 * the same renderer; anything else stays Markdown.
 *
 * `root` may be any statement of the program, not only the first: the official examples declare a
 * `$variable` or their rows before the card that uses them, and an answer of that shape is still a
 * program. A line that opens with `root = Component(` is not something prose contains, and the
 * answer has to open with a statement (or a fence) so that prose wrapped around a program keeps
 * reading as prose.
 */
export function isProgramText(text: string): boolean {
  const body = text.trim().replace(/^```[\w-]*\s*\n/, '').replace(/\n\s*```$/, '').trim();
  const first = body.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('//'));
  if (!first || !/^\$?[A-Za-z_]\w*[ \t]*=/.test(first)) return false;
  return /^[ \t]*root[ \t]*=[ \t]*[A-Z]\w*[ \t]*\(/m.test(body);
}
