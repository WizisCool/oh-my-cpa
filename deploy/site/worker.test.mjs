import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { renderLanding } from './landing/render.mjs';
import worker, {
  createSiteHandler,
  injectLandingVersion,
  parseLatestReleaseLocation,
} from './worker.mjs';

function makeRequest(path, init) {
  return new Request(`https://omc.junze.dev${path}`, init);
}

describe('public site worker (/demo subpath mount)', () => {
  it('redirects bare /demo to /demo/ while preserving query parameters', async () => {
    const env = { ASSETS: { fetch: () => new Response('unexpected', { status: 500 }) } };
    const response = await worker.fetch(makeRequest('/demo?preset=7d'), env);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), '/demo/?preset=7d');
  });

  it('serves demo API reads under /demo/api/ and enforces write refusals', async () => {
    const env = { ASSETS: { fetch: () => new Response('unexpected', { status: 500 }) } };

    const healthz = await worker.fetch(makeRequest('/demo/api/healthz'), env);
    assert.equal(healthz.status, 200);
    assert.equal(healthz.headers.get('X-OMCPA-Demo'), 'active');
    const healthBody = await healthz.json();
    assert.equal(healthBody.cpa_connected, true);

    const session = await worker.fetch(makeRequest('/demo/api/auth/session'), env);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).authenticated, true);

    const dashboard = await worker.fetch(makeRequest('/demo/api/v1/management/dashboard?preset=24h'), env);
    assert.equal(dashboard.status, 200);

    const refused = await worker.fetch(makeRequest('/demo/api/v1/management/config', { method: 'PATCH' }), env);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'demo_operation_refused');
  });

  it('falls back deep SPA routes under /demo/ to /demo/ while keeping missing static files as 404', async () => {
    const fetched = [];
    const env = {
      ASSETS: {
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          fetched.push({
            path,
            ifNoneMatch: request.headers.get('if-none-match'),
            ifModifiedSince: request.headers.get('if-modified-since'),
          });
          if (path === '/demo/' || path === '/' || path === '/api-reference/' || path === '/docs/' || path === '/docs/zh/') {
            return new Response(`<html>${path}</html>`, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=0, must-revalidate',
              },
            });
          }
          if (path === '/demo/assets/index.js') {
            return new Response('console.log(1);', {
              status: 200,
              headers: {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Cache-Control': 'public, max-age=31536000, immutable',
              },
            });
          }
          if (path.startsWith('/demo/assets/')) {
            return new Response('Not Found', {
              status: 404,
              headers: {
                'Cache-Control': 'public, max-age=31536000, immutable',
              },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      },
    };

    const spaRoute = await worker.fetch(
      makeRequest('/demo/usage/events', {
        headers: {
          'If-None-Match': '"stale-etag"',
          'If-Modified-Since': 'Tue, 17 Nov 2026 00:00:00 GMT',
        },
      }),
      env,
    );
    assert.equal(spaRoute.status, 200);
    assert.equal(await spaRoute.text(), '<html>/demo/</html>');
    assert.equal(spaRoute.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(fetched, [
      {
        path: '/demo/usage/events',
        ifNoneMatch: '"stale-etag"',
        ifModifiedSince: 'Tue, 17 Nov 2026 00:00:00 GMT',
      },
      {
        path: '/demo/',
        ifNoneMatch: null,
        ifModifiedSince: null,
      },
    ]);

    fetched.length = 0;
    const entryRoute = await worker.fetch(
      makeRequest('/demo/', {
        headers: { 'If-None-Match': '"stale-etag"' },
      }),
      env,
    );
    assert.equal(entryRoute.status, 200);
    assert.equal(entryRoute.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(fetched, [{ path: '/demo/', ifNoneMatch: null, ifModifiedSince: null }]);

    fetched.length = 0;
    const validAsset = await worker.fetch(makeRequest('/demo/assets/index.js'), env);
    assert.equal(validAsset.status, 200);
    assert.equal(validAsset.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

    fetched.length = 0;
    const missingAsset = await worker.fetch(makeRequest('/demo/assets/nonexistent.js'), env);
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(fetched.map((item) => item.path), ['/demo/assets/nonexistent.js']);

    fetched.length = 0;
    const apiRefRoute = await worker.fetch(makeRequest('/api-reference/'), env);
    assert.equal(apiRefRoute.status, 200);
    assert.equal(await apiRefRoute.text(), '<html>/api-reference/</html>');

    fetched.length = 0;
    const docsRoute = await worker.fetch(makeRequest('/docs/'), env);
    assert.equal(docsRoute.status, 200);
    assert.equal(await docsRoute.text(), '<html>/docs/</html>');

    fetched.length = 0;
    const zhDocsRoute = await worker.fetch(makeRequest('/docs/zh/'), env);
    assert.equal(zhDocsRoute.status, 200);
    assert.equal(await zhDocsRoute.text(), '<html>/docs/zh/</html>');
  });
});

function createMemoryCache() {
  const store = new Map();
  return {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      const entry = store.get(key);
      return entry ? entry.clone() : undefined;
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      store.set(key, response.clone());
    },
  };
}

describe('public site worker (live landing release injection)', () => {
  it('parses only stable GitHub release redirect locations for this repository', () => {
    assert.equal(parseLatestReleaseLocation('https://github.com/WizisCool/oh-my-cpa/releases/tag/v0.4.3'), '0.4.3');
    assert.equal(parseLatestReleaseLocation('/WizisCool/oh-my-cpa/releases/tag/v0.10.2'), '0.10.2');
    assert.equal(parseLatestReleaseLocation('https://github.com/WizisCool/oh-my-cpa/releases/tag/v1.0.0-rc.1'), null);
    assert.equal(parseLatestReleaseLocation('https://github.com/other/repo/releases/tag/v0.4.3'), null);
    assert.equal(parseLatestReleaseLocation('https://evil.example/WizisCool/oh-my-cpa/releases/tag/v0.4.3'), null);
  });

  it('rewrites rendered EN and ZH landing HTML byte-for-byte to match a freshly rendered release version', () => {
    for (const lang of ['en', 'zh']) {
      const stale = renderLanding(lang, { version: '0.4.2' });
      const expected = renderLanding(lang, { version: '0.4.3' });
      assert.equal(injectLandingVersion(stale, '0.4.3'), expected);
    }
    assert.equal(injectLandingVersion('<html>plain</html>', '0.4.3'), '<html>plain</html>');
    assert.equal(injectLandingVersion(renderLanding('en', { version: '0.4.2' }), '1.0.0-rc.1'), renderLanding('en', { version: '0.4.2' }));
  });

  it('injects the live release version on / and /zh/, updates ETags on release change, and keeps cache/fallbacks safe', async () => {
    let clock = 1_000_000;
    let upstreamTag = 'v0.4.3';
    let upstreamCalls = 0;
    let failUpstream = false;
    const cache = createMemoryCache();
    const waitUntilPromises = [];
    const ctx = { waitUntil: (promise) => waitUntilPromises.push(promise) };

    const enBuilt = renderLanding('en', { version: '0.4.2' });
    const zhBuilt = renderLanding('zh', { version: '0.4.2' });
    const assetRequests = [];

    const env = {
      ASSETS: {
        fetch: (request) => {
          const url = new URL(request.url);
          assetRequests.push({
            path: url.pathname,
            method: request.method,
            ifNoneMatch: request.headers.get('if-none-match'),
          });
          if (url.pathname === '/') {
            return new Response(enBuilt, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=0, must-revalidate',
                ETag: '"built-en"',
              },
            });
          }
          if (url.pathname === '/zh/') {
            return new Response(zhBuilt, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=0, must-revalidate',
                ETag: '"built-zh"',
              },
            });
          }
          if (url.pathname === '/zh') {
            return new Response(null, { status: 307, headers: { Location: '/zh/' } });
          }
          return new Response('Not Found', { status: 404 });
        },
      },
    };

    const handler = createSiteHandler({
      cacheStorage: cache,
      freshTtlMs: 60_000,
      retryTtlMs: 15_000,
      now: () => clock,
      fetchImpl: async (url, init) => {
        upstreamCalls += 1;
        assert.equal(url, 'https://github.com/WizisCool/oh-my-cpa/releases/latest');
        assert.equal(init.redirect, 'manual');
        if (failUpstream) throw new Error('upstream timeout');
        return new Response(null, {
          status: 302,
          headers: { Location: `https://github.com/WizisCool/oh-my-cpa/releases/tag/${upstreamTag}` },
        });
      },
    });

    // Concurrent cold requests deduplicate into one upstream release check.
    const [enRes, zhRes] = await Promise.all([
      handler.fetch(makeRequest('/'), env, ctx),
      handler.fetch(makeRequest('/zh/'), env, ctx),
    ]);
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(upstreamCalls, 1);
    assert.equal(enRes.status, 200);
    assert.equal(await enRes.text(), renderLanding('en', { version: '0.4.3' }));
    assert.equal(enRes.headers.get('etag'), 'W/"built-en-v0.4.3"');
    assert.equal(zhRes.status, 200);
    assert.equal(await zhRes.text(), renderLanding('zh', { version: '0.4.3' }));

    // Subsequent requests within TTL use cached version without calling GitHub; matching ETag gets 304.
    clock += 30_000;
    const cached304 = await handler.fetch(makeRequest('/', { headers: { 'If-None-Match': 'W/"built-en-v0.4.3"' } }), env, ctx);
    assert.equal(upstreamCalls, 1);
    assert.equal(cached304.status, 304);
    // Upstream ASSETS fetch never receives client If-None-Match so a release change cannot stick on a stale 304.
    assert.equal(assetRequests.every((item) => item.ifNoneMatch === null), true);

    // HEAD returns empty body with the versioned headers, and /zh redirects pass through untouched.
    const headRes = await handler.fetch(makeRequest('/', { method: 'HEAD' }), env, ctx);
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), '');
    assert.equal(headRes.headers.get('etag'), 'W/"built-en-v0.4.3"');

    const redirectRes = await handler.fetch(makeRequest('/zh'), env, ctx);
    assert.equal(redirectRes.status, 307);
    assert.equal(redirectRes.headers.get('location'), '/zh/');
    assert.equal(upstreamCalls, 1);

    // Once TTL expires and a new release is published, the next request updates immediately and invalidates the old ETag.
    clock += 40_000;
    upstreamTag = 'v0.4.4';
    const refreshed = await handler.fetch(makeRequest('/', { headers: { 'If-None-Match': 'W/"built-en-v0.4.3"' } }), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(upstreamCalls, 2);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.headers.get('etag'), 'W/"built-en-v0.4.4"');
    assert.equal(await refreshed.text(), renderLanding('en', { version: '0.4.4' }));

    // If GitHub fails after TTL, a fresh isolate falls back to the stale L2 cache rather than reverting to the build-time version.
    const coldIsolateHandler = createSiteHandler({
      cacheStorage: cache,
      freshTtlMs: 60_000,
      retryTtlMs: 15_000,
      now: () => clock,
      fetchImpl: async () => {
        throw new Error('network outage');
      },
    });
    clock += 70_000;
    const staleFallback = await coldIsolateHandler.fetch(makeRequest('/'), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(staleFallback.status, 200);
    assert.equal(await staleFallback.text(), renderLanding('en', { version: '0.4.4' }));

    // If both cache and GitHub are unavailable on a true cold start, the build-time HTML is preserved
    // and sequential requests within retryTtlMs do not hammer GitHub.
    failUpstream = true;
    let coldCalls = 0;
    const coldCache = createMemoryCache();
    const coldNoCache = createSiteHandler({
      cacheStorage: coldCache,
      freshTtlMs: 60_000,
      retryTtlMs: 15_000,
      now: () => clock,
      fetchImpl: async () => {
        coldCalls += 1;
        throw new Error('offline');
      },
    });
    const builtFallback = await coldNoCache.fetch(makeRequest('/'), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(builtFallback.status, 200);
    assert.equal(await builtFallback.text(), enBuilt);
    assert.equal(coldCalls, 1);

    clock += 5_000;
    const backedOff = await coldNoCache.fetch(makeRequest('/'), env, ctx);
    assert.equal(backedOff.status, 200);
    assert.equal(await backedOff.text(), enBuilt);
    assert.equal(coldCalls, 1);

    // After the retry backoff expires, the worker retries GitHub.
    clock += 15_000;
    await coldNoCache.fetch(makeRequest('/'), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(coldCalls, 2);

    // When isolate memory holds an older stale version than the shared cache, GitHub failure keeps the newer cached version.
    const multiIsolateCache = createMemoryCache();
    let multiTag = 'v0.4.3';
    let multiFail = false;
    const isolateA = createSiteHandler({
      cacheStorage: multiIsolateCache,
      freshTtlMs: 60_000,
      retryTtlMs: 15_000,
      staleMaxAgeSeconds: 300,
      now: () => clock,
      fetchImpl: async () => {
        if (multiFail) throw new Error('offline');
        return new Response(null, {
          status: 302,
          headers: { Location: `https://github.com/WizisCool/oh-my-cpa/releases/tag/${multiTag}` },
        });
      },
    });
    const isolateB = createSiteHandler({
      cacheStorage: multiIsolateCache,
      freshTtlMs: 60_000,
      retryTtlMs: 15_000,
      staleMaxAgeSeconds: 300,
      now: () => clock,
      fetchImpl: async () => {
        if (multiFail) throw new Error('offline');
        return new Response(null, {
          status: 302,
          headers: { Location: `https://github.com/WizisCool/oh-my-cpa/releases/tag/${multiTag}` },
        });
      },
    });

    await isolateA.fetch(makeRequest('/'), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    clock += 70_000;
    multiTag = 'v0.4.5';
    await isolateB.fetch(makeRequest('/'), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));

    // Expire both isolateA memory (0.4.3) and shared cache (0.4.5), then fail GitHub: isolateA must keep 0.4.5.
    clock += 70_000;
    multiFail = true;
    const newerStale = await isolateA.fetch(makeRequest('/'), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(await newerStale.text(), renderLanding('en', { version: '0.4.5' }));

    // Once staleMaxAgeSeconds elapses since the last successful confirmation, repeated failures stop serving stale data.
    clock += 250_000;
    const expiredStale = await isolateA.fetch(makeRequest('/'), env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(await expiredStale.text(), enBuilt);
  });
});
