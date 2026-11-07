import { stringArgument } from './toolArguments';

/** The HTML document a `present_html` call carries, as far as it has streamed. */
export function htmlOf(argumentsText: string | undefined): string {
  return stringArgument(argumentsText, 'html');
}

/**
 * Whether a fenced block holds a whole document rather than a fragment to copy.
 *
 * Only a document is worth drawing: a fragment of markup, a style rule or a script has no page to
 * show, and the fence's language alone does not say which it is. A block that opens with a doctype,
 * an `html` element or a root `svg` element is one; anything else stays code.
 */
export function isHTMLDocument(code: string): boolean {
  const head = code.trimStart().slice(0, 512).toLowerCase();
  return head.startsWith('<!doctype html') || /<html[\s>]/.test(head) || head.startsWith('<svg');
}

/**
 * The policy a model-authored document is drawn under.
 *
 * The document is the model's, and the console around it holds an operator's session, so the frame
 * is given an opaque origin (`sandbox` without `allow-same-origin`) and this policy: inline styles
 * and scripts are what a single-file page needs, while every asset must be carried inside the
 * document (`data:`) and no subresource, fetch or form request may leave the frame. An answer
 * therefore cannot read the console or reach an endpoint of its own; a script can still navigate
 * the frame itself to an address it names, which the reader sees.
 */
const DOCUMENT_POLICY = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_POLICY}">`;

/**
 * The document with the policy it is drawn under, ahead of everything it could load.
 *
 * The policy has to be the first thing the parser sees: content before it - a stylesheet link, a
 * script, a comment - would be parsed or fetched before it applies, and a `<head>` inside a comment
 * would put the policy where it never applies. A doctype after content is ignored, so the prefix
 * also keeps the document in standards mode whatever its own markup declared.
 */
export function fencedDocument(document: string): string {
  return `<!doctype html>${POLICY_META}${document}`;
}
