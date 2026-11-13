import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import worker from './worker.mjs';

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
    const fetchedPaths = [];
    const env = {
      ASSETS: {
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          fetchedPaths.push(path);
          if (path === '/demo/' || path === '/' || path === '/api-docs/') {
            return new Response(`<html>${path}</html>`, { status: 200 });
          }
          return new Response('Not Found', { status: 404 });
        },
      },
    };

    const spaRoute = await worker.fetch(makeRequest('/demo/usage/events'), env);
    assert.equal(spaRoute.status, 200);
    assert.equal(await spaRoute.text(), '<html>/demo/</html>');
    assert.deepEqual(fetchedPaths, ['/demo/usage/events', '/demo/']);

    fetchedPaths.length = 0;
    const missingAsset = await worker.fetch(makeRequest('/demo/assets/nonexistent.js'), env);
    assert.equal(missingAsset.status, 404);
    assert.deepEqual(fetchedPaths, ['/demo/assets/nonexistent.js']);

    fetchedPaths.length = 0;
    const docsRoute = await worker.fetch(makeRequest('/api-docs/'), env);
    assert.equal(docsRoute.status, 200);
    assert.equal(await docsRoute.text(), '<html>/api-docs/</html>');
  });
});
