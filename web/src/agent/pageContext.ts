import React from 'react';

/**
 * Where the operator is when they ask the assistant something (ADR 0073).
 *
 * The page is read from the route, so every page is context without doing anything. A page that
 * has something selected, or shows a time window, declares that with `usePageContext`. Nothing
 * here reads the page's content: context is three short values of a closed shape - a page name, a
 * `kind:id` selection, a window - because the server writes them into the model's instructions,
 * and a field that could carry a sentence would let page data speak as the operator.
 */
export const CONSOLE_PAGES = [
  'dashboard', 'usage/events', 'quota', 'pricing', 'api-keys', 'ai-providers', 'auth-files', 'oauth-management',
  'model-square', 'logs', 'audit', 'config', 'playground', 'omc-settings', 'plugins', 'system',
] as const;
export type ConsolePage = typeof CONSOLE_PAGES[number];

export const SELECTION_KINDS = ['request', 'provider', 'client_key', 'credential', 'model'] as const;
export type SelectionKind = typeof SELECTION_KINDS[number];

export interface PageSelection {
  kind: SelectionKind;
  id: string;
  /** What the operator calls it, for the chip; never sent. */
  label?: string;
}

export interface PageDeclaration {
  selection?: PageSelection;
  /** The window the page shows, as the page itself names it: `24h`, `2026-10-01/2026-10-07`. */
  range?: string;
}

export interface PageContext extends PageDeclaration {
  page: ConsolePage;
}

const SELECTION_ID = /^[A-Za-z0-9._:@/+=-]{1,112}$/;
const RANGE = /^[A-Za-z0-9._:/+-]{1,64}$/;

/** The console page a route path belongs to, or nothing for a route that is not one. */
export function consolePageOf(pathname: string): ConsolePage | undefined {
  const path = pathname.replace(/^\/+|\/+$/g, '');
  // Longest first, so `usage/events` is not read as a page called `usage`.
  return [...CONSOLE_PAGES].sort((left, right) => right.length - left.length)
    .find(page => path === page || path.startsWith(`${page}/`));
}

/**
 * The context entries a run carries. A part that does not fit the closed shape is left out rather
 * than sent: the server refuses a whole run over one malformed entry, and where the operator was
 * looking is never worth losing their message for.
 */
export function pageContextEntries(context: PageContext | undefined): { description: string; value: string }[] {
  if (!context || !(CONSOLE_PAGES as readonly string[]).includes(context.page)) return [];
  const entries: { description: string; value: string }[] = [{ description: 'console_page', value: context.page }];
  const selection = context.selection;
  if (selection && (SELECTION_KINDS as readonly string[]).includes(selection.kind) && SELECTION_ID.test(selection.id)) {
    entries.push({ description: 'console_selection', value: `${selection.kind}:${selection.id}` });
  }
  if (context.range && RANGE.test(context.range)) entries.push({ description: 'console_range', value: context.range });
  return entries;
}

// One declaration at a time: the page that is mounted. A module-level store rather than React
// context because the declaring page and the assistant dock sit in different subtrees of the shell.
let declaration: PageDeclaration = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (next: PageDeclaration) => { declaration = next; listeners.forEach(listener => listener()); };

/** Declares what the mounted page has selected and which window it shows; cleared when it unmounts. */
export function usePageContext({ selection, range }: PageDeclaration): void {
  const kind = selection?.kind;
  const id = selection?.id;
  const label = selection?.label;
  React.useEffect(() => {
    const next: PageDeclaration = { ...(kind && id ? { selection: { kind, id, label } } : {}), ...(range ? { range } : {}) };
    publish(next);
    return () => { if (declaration === next) publish({}); };
  }, [kind, id, label, range]);
}

export function useDeclaredPageContext(): PageDeclaration {
  return React.useSyncExternalStore(subscribe, () => declaration);
}
