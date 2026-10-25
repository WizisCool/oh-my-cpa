import type source from './locales/zh';

/**
 * A message id. The Simplified Chinese catalog defines the set: it is the product's semantic
 * source, so a key exists once its source sentence does, and every other language is checked
 * against it by the compiler.
 */
export type MessageKey = keyof typeof source;

/** A complete reading language: one sentence for every message id. */
export type Catalog = Readonly<Record<MessageKey, string>>;

/**
 * One domain file of a language other than the source: exactly the keys the source file of the
 * same name defines. `satisfies Translation<typeof source>` makes a missing key and a stale one
 * both compile errors in the file where they occur.
 */
export type Translation<Source> = { readonly [Key in keyof Source]: string };

export type MessageVars = Readonly<Record<string, string | number>>;

/**
 * A translator.
 *
 * The parameter is a plain string because several dozen call sites compute it - `audit.cat.${...}`,
 * `cfg.backups_reason_${...}`, a permission class from the server - and a lookup that names no
 * message renders the id it was given, which keeps a value the console has not caught up with
 * readable instead of blank. Narrowing this to `MessageKey` is a separate step, taken once those
 * call sites look their copy up through a helper that can prove the id exists.
 */
export type TFunc = (key: string, vars?: MessageVars) => string;
