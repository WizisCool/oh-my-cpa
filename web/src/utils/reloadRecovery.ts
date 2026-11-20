/**
 * Whitelist-only, non-sensitive recovery state for mobile document reloads.
 *
 * Security boundary: browser storage here holds strictly non-sensitive UI continuity
 * hints (whether the tab was showing the authenticated shell, the `.app-content` scroll
 * offset, and a fixed allowlisted console route for standalone PWA relaunches). Secrets,
 * credentials, OAuth tokens, auth files, TLS keys, raw YAML, and conversation payloads
 * must never pass through this module, and side-effectful operations are never replayed.
 */

export const AUTH_SHELL_HINT_KEY = 'omc:auth-shell-hint:v1';
export const RELOAD_SCROLL_STORAGE_KEY = 'omc:reload-scroll:v1';
export const STANDALONE_ROUTE_STORAGE_KEY = 'omc:standalone-route:v1';
export const RECOVERY_TTL_MS = 30 * 60_000;

/**
 * Fixed set of static console paths allowed in cross-reload scroll/route restoration.
 * Dynamic or credential-sensitive routes (such as `/authorize/:id`) are excluded.
 */
export const RECOVERABLE_CONSOLE_ROUTES: ReadonlySet<string> = new Set([
  '/dashboard',
  '/insights',
  '/trends',
  '/usage/events',
  '/pricing',
  '/ai-providers',
  '/api-keys',
  '/routing',
  '/oauth-management',
  '/model-square',
  '/agent',
  '/playground',
  '/logs',
  '/audit',
  '/config',
  '/omc-settings',
  '/plugins',
  '/plugins/store',
  '/plugins/settings',
  '/system',
]);

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeSessionStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeRecoverableRoute(rawPath: string): string | null {
  const withoutQuery = rawPath.split('?')[0]?.split('#')[0]?.trim() ?? '';
  const trimmed = withoutQuery.replace(/\/+$/, '') || '/';
  return RECOVERABLE_CONSOLE_ROUTES.has(trimmed) ? trimmed : null;
}

/**
 * Distinguishes transient transport/gateway interruptions from authentication refusals.
 * HTTP 401/403 (and other 4xx statuses except 408/429) are never treated as transient.
 */
export function isTransientSessionError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number') {
    const status = (error as { status: number }).status;
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }
  return false;
}

export function readAuthShellHint(storage: StorageLike | null = safeSessionStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(AUTH_SHELL_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeAuthShellHint(isAuthenticated: boolean, storage: StorageLike | null = safeSessionStorage()): void {
  if (!storage) return;
  try {
    if (isAuthenticated) storage.setItem(AUTH_SHELL_HINT_KEY, '1');
    else storage.removeItem(AUTH_SHELL_HINT_KEY);
  } catch {
    // Storage may be unavailable in private browsing or restricted contexts.
  }
}

export interface ScrollRecoveryOptions {
  readonly storage?: StorageLike | null;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export function saveScrollSnapshot(
  pathname: string,
  scrollTop: number,
  options: ScrollRecoveryOptions = {},
): void {
  const storage = options.storage !== undefined ? options.storage : safeSessionStorage();
  if (!storage) return;
  const route = normalizeRecoverableRoute(pathname);
  const rounded = Math.max(0, Math.round(scrollTop));
  try {
    if (!route || !Number.isFinite(scrollTop) || rounded <= 0) {
      storage.removeItem(RELOAD_SCROLL_STORAGE_KEY);
      return;
    }
    const now = options.now ?? (() => Date.now());
    storage.setItem(
      RELOAD_SCROLL_STORAGE_KEY,
      JSON.stringify({ path: route, scrollTop: rounded, savedAt: now() }),
    );
  } catch {
    // Ignore storage quota or policy errors.
  }
}

export function consumeScrollSnapshot(
  pathname: string,
  options: ScrollRecoveryOptions = {},
): number | null {
  const storage = options.storage !== undefined ? options.storage : safeSessionStorage();
  if (!storage) return null;
  const route = normalizeRecoverableRoute(pathname);
  if (!route) return null;
  try {
    const raw = storage.getItem(RELOAD_SCROLL_STORAGE_KEY);
    storage.removeItem(RELOAD_SCROLL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { path?: unknown; scrollTop?: unknown; savedAt?: unknown };
    if (record.path !== route) return null;
    if (typeof record.scrollTop !== 'number' || !Number.isFinite(record.scrollTop) || record.scrollTop <= 0) {
      return null;
    }
    const now = options.now ?? (() => Date.now());
    const ttlMs = options.ttlMs ?? RECOVERY_TTL_MS;
    if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return null;
    const age = now() - record.savedAt;
    if (age < 0 || age > ttlMs) return null;
    return record.scrollTop;
  } catch {
    return null;
  }
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
}

export interface StandaloneRouteOptions {
  readonly storage?: StorageLike | null;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly isStandalone?: () => boolean;
}

export function saveStandaloneRoute(pathname: string, options: StandaloneRouteOptions = {}): void {
  const isStandalone = options.isStandalone ?? isStandaloneDisplayMode;
  if (!isStandalone()) return;
  const storage = options.storage !== undefined ? options.storage : safeLocalStorage();
  if (!storage) return;
  const route = normalizeRecoverableRoute(pathname);
  if (!route) return;
  try {
    const now = options.now ?? (() => Date.now());
    storage.setItem(STANDALONE_ROUTE_STORAGE_KEY, JSON.stringify({ path: route, savedAt: now() }));
  } catch {
    // Ignore storage quota or policy errors.
  }
}

export function consumeStandaloneRoute(options: StandaloneRouteOptions = {}): string | null {
  const isStandalone = options.isStandalone ?? isStandaloneDisplayMode;
  if (!isStandalone()) return null;
  const storage = options.storage !== undefined ? options.storage : safeLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STANDALONE_ROUTE_STORAGE_KEY);
    storage.removeItem(STANDALONE_ROUTE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { path?: unknown; savedAt?: unknown };
    const route = typeof record.path === 'string' ? normalizeRecoverableRoute(record.path) : null;
    if (!route) return null;
    const now = options.now ?? (() => Date.now());
    const ttlMs = options.ttlMs ?? RECOVERY_TTL_MS;
    if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return null;
    const age = now() - record.savedAt;
    if (age < 0 || age > ttlMs) return null;
    return route;
  } catch {
    return null;
  }
}

export function clearReloadRecoveryState(
  session: StorageLike | null = safeSessionStorage(),
  local: StorageLike | null = safeLocalStorage(),
): void {
  writeAuthShellHint(false, session);
  try {
    session?.removeItem(RELOAD_SCROLL_STORAGE_KEY);
  } catch {
    // Ignore storage access failures.
  }
  try {
    local?.removeItem(STANDALONE_ROUTE_STORAGE_KEY);
  } catch {
    // Ignore storage access failures.
  }
}
