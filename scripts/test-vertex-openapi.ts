/**
 * The Vertex OpenAPI overrides a credential drawer sends
 * (web/src/components/authFiles/vertexOpenAPI.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVertexOpenAPIPatch,
  isVertexServiceAccount,
  readVertexOpenAPIDraft,
  vertexOpenAPIProblem,
} from '../web/src/components/authFiles/vertexOpenAPI.ts';

test('an explicit false reads as off, distinct from inheriting CPA detection', () => {
  assert.equal(readVertexOpenAPIDraft({ name: 'v', disable_cooling: false, websockets: false, using_api: false, openapi: false }).mode, 'off');
  assert.equal(readVertexOpenAPIDraft({ name: 'v', disable_cooling: false, websockets: false, using_api: false }).mode, 'inherit');
});

test('only changed overrides are patched, and clearing states inheritance as null', () => {
  const baseline = { mode: 'off' as const, location: 'global', models: 'meta/a\nmeta/b' };
  assert.deepEqual(buildVertexOpenAPIPatch({ ...baseline, models: 'meta/a, META/A\nmeta/b' }, baseline), {});
  assert.deepEqual(buildVertexOpenAPIPatch({ mode: 'inherit', location: ' ', models: '' }, baseline), {
    openapi: null,
    openapi_location: null,
    openapi_models: null,
  });
  assert.deepEqual(buildVertexOpenAPIPatch({ mode: 'on', location: 'us-central1', models: 'meta/c' }, baseline), {
    openapi: true,
    openapi_location: 'us-central1',
    openapi_models: ['meta/c'],
  });
});

test('a location outside Vertex spelling and an oversized list are refused before saving', () => {
  assert.equal(vertexOpenAPIProblem({ mode: 'inherit', location: 'US Central', models: '' }), 'location');
  assert.equal(vertexOpenAPIProblem({ mode: 'inherit', location: '', models: Array.from({ length: 257 }, (_, i) => `m/${i}`).join('\n') }), 'models_too_many');
  assert.equal(vertexOpenAPIProblem({ mode: 'inherit', location: 'global', models: 'meta/a' }), null);
});

test('only Vertex credentials carry the overrides', () => {
  assert.equal(isVertexServiceAccount({ provider: 'vertex', type: 'vertex' }), true);
  assert.equal(isVertexServiceAccount({ provider: 'codex', type: 'codex' }), false);
});
