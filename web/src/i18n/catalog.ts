import source from './locales/zh';

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
 * A translator. The key is a `MessageKey`, so a typo or a sentence that was renamed is a compile
 * error at the call site rather than a rendered id. Copy whose id is assembled at runtime goes
 * through a helper that proves the id (see `web/src/i18n/keys.ts`).
 */
export type TFunc = (key: MessageKey, vars?: MessageVars) => string;

/**
 * Whether a computed id names a message. For copy chosen from a server value - an audit action, a
 * result - so an identifier the console has no sentence for falls back to a deliberate rendering
 * instead of printing the lookup key, and the caller holds a `MessageKey` afterwards.
 */
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(source, key);
}

/** The message a computed id names, or `undefined` when the console has no sentence for it. */
export function messageKey(key: string): MessageKey | undefined {
  return hasMessage(key) ? key : undefined;
}

/**
 * The message an id assembled from a prefix and a runtime value names, or `undefined`. The prefix
 * is spelled out at the call site, so a family that was renamed is a compile-time question even
 * when its suffix comes from the server.
 */
export function prefixedKey(prefix: `${string}.` | `${string}_` | `${string}.${string}.`, suffix: string): MessageKey | undefined {
  return messageKey(`${prefix}${suffix}`);
}

/**
 * Copy for an id computed from a server value, or `fallback` when the console has no sentence
 * for it: a value added on the server before the console caught up still reads as itself.
 */
export function translateOr(t: TFunc, key: string, fallback: string, vars?: MessageVars): string {
  return hasMessage(key) ? t(key, vars) : fallback;
}
