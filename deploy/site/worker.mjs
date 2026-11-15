/**
 * Entry Worker for the public site (`omc.junze.dev`).
 *
 * - `/demo` and `/demo/*` run the shared Cloudflare demo handler (`deploy/cloudflare/worker.mjs`).
 * - Landing HTML routes (`/`, `/zh/`) inject the latest published stable GitHub release version
 *   at the edge (cached briefly with stale fallback), so new releases appear without rebuilding
 *   static assets.
 * - `/docs/*`, `/api-reference/*`, and static assets bypass the Worker via `run_worker_first`
 *   in `wrangler.jsonc`.
 */
import { createDemoHandler } from '../cloudflare/worker.mjs';
import { GITHUB_REPO } from './site-meta.mjs';

const STABLE_VERSION_RE = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const LANDING_PATHS = new Set(['/', '/index.html', '/zh', '/zh/', '/zh/index.html']);
const CACHE_KEY_PATH = '/__worker-cache/latest-release/v1';
const FRESH_TTL_MS = 60_000;
const RETRY_TTL_MS = 15_000;
const STALE_MAX_AGE_SECONDS = 86_400;
const FETCH_TIMEOUT_MS = 1500;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseStableVersion(tag) {
  if (typeof tag !== 'string') return null;
  const match = tag.trim().match(STABLE_VERSION_RE);
  return match ? match[1] : null;
}

export function parseLatestReleaseLocation(location, repo = GITHUB_REPO) {
  if (typeof location !== 'string' || !location.trim()) return null;
  let parsed;
  try {
    parsed = new URL(location, 'https://github.com');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://github.com') return null;
  const pathMatch = parsed.pathname.match(new RegExp(`^/${escapeRegExp(repo)}/releases/tag/([^/]+)/?$`, 'i'));
  if (!pathMatch) return null;
  try {
    return parseStableVersion(decodeURIComponent(pathMatch[1]));
  } catch {
    return null;
  }
}

export async function fetchLatestStableRelease({
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  repo = GITHUB_REPO,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const requestInit = {
    method: 'HEAD',
    redirect: 'manual',
    headers: {
      'User-Agent': 'oh-my-cpa-site-worker',
    },
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {}),
  };
  try {
    let response = await fetchImpl(`https://github.com/${repo}/releases/latest`, requestInit);
    if (response.status === 405) {
      void response.body?.cancel?.().catch?.(() => {});
      response = await fetchImpl(`https://github.com/${repo}/releases/latest`, {
        ...requestInit,
        method: 'GET',
      });
    }
    void response.body?.cancel?.().catch?.(() => {});
    if (response.status >= 300 && response.status < 400) {
      return parseLatestReleaseLocation(response.headers.get('location'), repo);
    }
    return null;
  } catch {
    return null;
  }
}

export function injectLandingVersion(html, version, repo = GITHUB_REPO) {
  const normalized = parseStableVersion(version);
  if (!normalized || typeof html !== 'string' || !html) return html;
  const releaseHref = `https://github.com/${repo}/releases/tag/v${normalized}`;
  return html
    .replace(/<a\b[^>]*\bdata-release-link\b[^>]*>/gi, (tag) =>
      tag.replace(/\bhref="[^"]*"/i, () => `href="${releaseHref}"`),
    )
    .replace(
      /<(strong|span)\b([^>]*\bdata-release-version\b[^>]*)>v?[^<]*<\/\1>/gi,
      (_, tag, attrs) => `<${tag}${attrs}>v${normalized}</${tag}>`,
    )
    .replace(
      /(<script\b[^>]*\btype="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/i,
      (_, open, jsonText, close) =>
        `${open}${jsonText.replace(/"softwareVersion"\s*:\s*"[^"]*"/, () => `"softwareVersion":"${normalized}"`)}${close}`,
    );
}

function normalizeEtagToken(tag) {
  const trimmed = tag.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

function matchesIfNoneMatch(headerValue, currentEtag) {
  if (!headerValue || !currentEtag) return false;
  const trimmed = headerValue.trim();
  if (trimmed === '*') return true;
  const target = normalizeEtagToken(currentEtag);
  for (const candidate of trimmed.split(',')) {
    if (normalizeEtagToken(candidate) === target) return true;
  }
  return false;
}

function buildVersionedEtag(rawEtag, version) {
  if (!rawEtag) return null;
  const unwrapped = normalizeEtagToken(rawEtag).replace(/^"+|"+$/g, '');
  if (!unwrapped) return null;
  return `W/"${unwrapped}-v${version}"`;
}

function selectMostRecentValid(first, second, currentTime, staleTtlMs) {
  const isValidStale = (entry) =>
    entry &&
    entry.version &&
    Number.isFinite(entry.confirmedAt) &&
    currentTime - entry.confirmedAt < staleTtlMs;
  const a = isValidStale(first) ? first : null;
  const b = isValidStale(second) ? second : null;
  if (a && b) return b.confirmedAt > a.confirmedAt ? b : a;
  return a || b;
}

async function readCachedVersion(cache, cacheKey) {
  if (!cache) return null;
  try {
    const matched = await cache.match(cacheKey);
    if (!matched) return null;
    const payload = await matched.json();
    const freshUntil = Number(payload?.freshUntil);
    if (!Number.isFinite(freshUntil)) return null;
    if (payload?.version === null) {
      return { version: null, confirmedAt: 0, freshUntil };
    }
    const version = parseStableVersion(payload?.version);
    const confirmedAt = Number(payload?.confirmedAt);
    if (!version || !Number.isFinite(confirmedAt)) return null;
    return { version, confirmedAt, freshUntil };
  } catch {
    return null;
  }
}

async function writeCachedVersion(cache, cacheKey, entry, staleMaxAgeSeconds, ctx) {
  if (!cache) return;
  const response = new Response(JSON.stringify(entry), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${staleMaxAgeSeconds}`,
    },
  });
  const write = Promise.resolve(cache.put(cacheKey, response)).catch(() => {});
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(write);
  else await write;
}

export function createSiteHandler({
  demoBasePath = '/demo',
  repo = GITHUB_REPO,
  fetchImpl = globalThis.fetch,
  cacheStorage,
  freshTtlMs = FRESH_TTL_MS,
  retryTtlMs = RETRY_TTL_MS,
  staleMaxAgeSeconds = STALE_MAX_AGE_SECONDS,
  timeoutMs = FETCH_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const demoHandler = createDemoHandler({ basePath: demoBasePath });
  const staleTtlMs = staleMaxAgeSeconds * 1000;
  let memoryEntry = null;
  let inFlight = null;

  function getCache() {
    return cacheStorage !== undefined ? cacheStorage : (globalThis.caches?.default ?? null);
  }

  async function resolveLatestVersion(origin, ctx) {
    const currentTime = now();
    const isFresh = (entry) =>
      entry &&
      currentTime < entry.freshUntil &&
      (entry.version === null || currentTime - entry.confirmedAt < staleTtlMs);

    if (isFresh(memoryEntry)) {
      return memoryEntry.version;
    }
    const cache = getCache();
    const cacheUrl = new URL(CACHE_KEY_PATH, origin && origin !== 'null' ? origin : 'https://omc.junze.dev');
    const cacheKey = new Request(cacheUrl.toString());
    const cached = await readCachedVersion(cache, cacheKey);
    if (isFresh(cached)) {
      memoryEntry = cached;
      return cached.version;
    }
    if (isFresh(memoryEntry)) {
      return memoryEntry.version;
    }
    const stale = selectMostRecentValid(memoryEntry, cached, currentTime, staleTtlMs);
    if (!inFlight) {
      inFlight = (async () => {
        const fresh = await fetchLatestStableRelease({ fetchImpl, timeoutMs, repo });
        const updatedAt = now();
        if (fresh) {
          const next = { version: fresh, confirmedAt: updatedAt, freshUntil: updatedAt + freshTtlMs };
          memoryEntry = next;
          await writeCachedVersion(cache, cacheKey, next, staleMaxAgeSeconds, ctx);
          return fresh;
        }
        const activeStale = selectMostRecentValid(stale, null, updatedAt, staleTtlMs);
        if (activeStale) {
          const remainingSeconds = Math.max(1, Math.ceil((activeStale.confirmedAt + staleTtlMs - updatedAt) / 1000));
          const backoff = {
            version: activeStale.version,
            confirmedAt: activeStale.confirmedAt,
            freshUntil: updatedAt + retryTtlMs,
          };
          memoryEntry = backoff;
          await writeCachedVersion(cache, cacheKey, backoff, remainingSeconds, ctx);
          return activeStale.version;
        }
        const negativeBackoff = { version: null, confirmedAt: 0, freshUntil: updatedAt + retryTtlMs };
        memoryEntry = negativeBackoff;
        await writeCachedVersion(cache, cacheKey, negativeBackoff, Math.max(1, Math.ceil(retryTtlMs / 1000)), ctx);
        return null;
      })().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function handleLandingRequest(request, env, ctx, url) {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return env.ASSETS.fetch(request);
    }
    const assetHeaders = new Headers(request.headers);
    assetHeaders.delete('if-none-match');
    assetHeaders.delete('if-modified-since');
    const assetResponse = await env.ASSETS.fetch(new Request(request.url, { method: 'GET', headers: assetHeaders }));
    if (assetResponse.status !== 200) {
      if (method === 'HEAD') {
        void assetResponse.body?.cancel?.().catch?.(() => {});
        return new Response(null, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers: assetResponse.headers,
        });
      }
      return assetResponse;
    }

    const [rawHtml, version] = await Promise.all([assetResponse.text(), resolveLatestVersion(url.origin, ctx)]);
    const headers = new Headers(assetResponse.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');

    const rawEtag = headers.get('etag');
    const effectiveEtag = version ? buildVersionedEtag(rawEtag, version) : rawEtag;
    if (effectiveEtag) {
      headers.set('etag', effectiveEtag);
      if (matchesIfNoneMatch(request.headers.get('if-none-match'), effectiveEtag)) {
        return new Response(null, { status: 304, headers });
      }
    }

    const body = version ? injectLandingVersion(rawHtml, version, repo) : rawHtml;
    return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
  }

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === demoBasePath || url.pathname.startsWith(`${demoBasePath}/`)) {
        return demoHandler.fetch(request, env, ctx);
      }
      if (LANDING_PATHS.has(url.pathname)) {
        return handleLandingRequest(request, env, ctx, url);
      }
      return env.ASSETS.fetch(request);
    },
  };
}

export default createSiteHandler();
