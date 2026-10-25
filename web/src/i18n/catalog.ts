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

export type TFunc = (key: MessageKey, vars?: MessageVars) => string;
