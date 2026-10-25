import type { MessageVars } from './catalog';

/**
 * Fills a message's placeholders.
 *
 * Two forms, and nothing more, because they are all the console's copy needs and both are
 * readable to a translator who has never seen this codebase:
 *
 * - `{name}` is replaced by the variable's value as given.
 * - `{name, plural, one {# request} other {# requests}}` is the ICU plural form. The branch is
 *   chosen by the reading language's own plural rules (`Intl.PluralRules`), so English writes
 *   `one` and `other` while Chinese and Malay - which do not inflect for number - write the plain
 *   sentence and never need the form. `#` is the count, grouped for the reading language; any
 *   other `{placeholder}` inside a branch is filled as usual. A category the rules pick but the
 *   message omits falls back to `other`.
 *
 * A placeholder the caller did not pass stays in the text, which makes the omission visible
 * rather than silently printing an empty gap.
 */
export function formatMessage(template: string | undefined, vars: MessageVars | undefined, locale: string): string {
  if (!template) return template ?? '';
  if (!vars || !template.includes('{')) return template;
  let output = '';
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('{', index);
    if (open < 0) {
      output += template.slice(index);
      break;
    }
    output += template.slice(index, open);
    const close = matchingBrace(template, open);
    if (close < 0) {
      output += template.slice(open);
      break;
    }
    output += fillPlaceholder(template.slice(open + 1, close), template.slice(open, close + 1), vars, locale);
    index = close + 1;
  }
  return output;
}

const PLURAL_HEAD = /^\s*([A-Za-z0-9_]+)\s*,\s*plural\s*,/;
const IDENTIFIER = /^[A-Za-z0-9_]+$/;

function fillPlaceholder(body: string, raw: string, vars: MessageVars, locale: string): string {
  const plural = PLURAL_HEAD.exec(body);
  if (!plural) {
    const name = body.trim();
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : raw;
  }
  const name = plural[1];
  if (!Object.prototype.hasOwnProperty.call(vars, name)) return raw;
  const value = vars[name];
  const count = typeof value === 'number' ? value : Number(value);
  const branches = pluralBranches(body.slice(plural[0].length));
  const category = Number.isFinite(count) ? pluralRules(locale).select(count) : 'other';
  const branch = branches.get(`=${count}`) ?? branches.get(category) ?? branches.get('other');
  if (branch === undefined) return raw;
  const shown = typeof value === 'number' ? numberFormat(locale).format(value) : String(value);
  return formatMessage(branch.split('#').join(shown), vars, locale);
}

/** Every `category {text}` pair of a plural form's body. */
export function pluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let index = 0;
  while (index < body.length) {
    const open = body.indexOf('{', index);
    if (open < 0) break;
    const category = body.slice(index, open).trim();
    const close = matchingBrace(body, open);
    if (close < 0 || category === '') break;
    branches.set(category, body.slice(open + 1, close));
    index = close + 1;
  }
  return branches;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const PLURAL_RULES = new Map<string, Intl.PluralRules>();
const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();

function pluralRules(locale: string): Intl.PluralRules {
  let rules = PLURAL_RULES.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    PLURAL_RULES.set(locale, rules);
  }
  return rules;
}

function numberFormat(locale: string): Intl.NumberFormat {
  let format = NUMBER_FORMATS.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale);
    NUMBER_FORMATS.set(locale, format);
  }
  return format;
}

/**
 * The variables a message reads, sorted: a plain `{name}` and the subject of a plural form, plus
 * whatever a plural branch reads in turn. Order is not compared, because a translation may need
 * its placeholders in a different order from the source sentence.
 */
export function messagePlaceholders(template: string): string[] {
  const names = new Set<string>();
  collectPlaceholders(template, names);
  return [...names].sort();
}

function collectPlaceholders(template: string, names: Set<string>): void {
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('{', index);
    if (open < 0) return;
    const close = matchingBrace(template, open);
    if (close < 0) return;
    const body = template.slice(open + 1, close);
    const plural = PLURAL_HEAD.exec(body);
    if (plural) {
      names.add(plural[1]);
      for (const branch of pluralBranches(body.slice(plural[0].length)).values()) collectPlaceholders(branch, names);
    } else if (IDENTIFIER.test(body.trim())) {
      names.add(body.trim());
    }
    index = close + 1;
  }
}
