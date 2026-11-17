const CHUNK_RELOAD_STORAGE_KEY = 'omc:chunk-reload:v1';
const CHUNK_RELOAD_COOLDOWN_MS = 30_000;

const MODULE_LOAD_FAILURES = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Failed to load module script/i,
  /Unable to preload CSS/i,
];

let reloadInFlight = false;

export function isModuleLoadFailure(error: unknown): boolean {
  return error instanceof Error && MODULE_LOAD_FAILURES.some((pattern) => pattern.test(error.message));
}

export function isChunkReloadPending(): boolean {
  return reloadInFlight;
}

export function clearChunkReloadPending(): void {
  reloadInFlight = false;
}

export interface AttemptChunkReloadOptions {
  readonly now?: () => number;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly reload?: () => void;
  readonly isOnline?: () => boolean;
  readonly cooldownMs?: number;
}

/**
 * Reloads the document once within `cooldownMs` when a stale HTML shell requests a retired chunk.
 * Returns `true` only when a reload is initiated so offline or persistently missing chunks fall
 * back to the error screen rather than looping.
 */
export function attemptChunkReload(options: AttemptChunkReloadOptions = {}): boolean {
  if (reloadInFlight) return true;
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  if (!isOnline()) return false;

  const storage = options.storage !== undefined
    ? options.storage
    : (typeof window !== 'undefined' ? window.sessionStorage : null);
  if (!storage) return false;

  const now = options.now ?? (() => Date.now());
  const cooldownMs = options.cooldownMs ?? CHUNK_RELOAD_COOLDOWN_MS;
  const currentTime = now();

  try {
    const raw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    if (raw) {
      const previousTime = Number(raw);
      if (Number.isFinite(previousTime) && currentTime >= previousTime && currentTime - previousTime < cooldownMs) {
        return false;
      }
    }
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(currentTime));
  } catch {
    return false;
  }

  const reload = options.reload ?? (typeof window !== 'undefined' ? () => window.location.reload() : undefined);
  if (!reload) return false;

  reloadInFlight = true;
  try {
    reload();
    return true;
  } catch {
    reloadInFlight = false;
    return false;
  }
}

export function installChunkLoadRecovery(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  options: AttemptChunkReloadOptions = {},
): () => void {
  const onPreloadError = () => {
    // Keep the original rejection rather than calling event.preventDefault(), which causes Vite's
    // preload helper to resolve to undefined and mask chunk failures as property-read TypeErrors.
    attemptChunkReload(options);
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError);
  };
}
