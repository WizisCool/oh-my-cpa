import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouteLoader } from '../web/src/utils/routeLoader.ts';

test('hover, focus and navigation share a lazy import without loading at creation', async () => {
  let imports = 0;
  let completeImport: (value: { page: string }) => void = () => { throw new Error('import has not started'); };
  const loadRoute = createRouteLoader(() => {
    imports += 1;
    return new Promise<{ page: string }>((resolve) => { completeImport = resolve; });
  });
  assert.equal(imports, 0);
  const onHover = loadRoute();
  assert.equal(loadRoute(), onHover);
  assert.equal(imports, 1);
  completeImport({ page: 'config' });
  assert.deepEqual(await onHover, { page: 'config' });
  assert.equal(loadRoute(), onHover);
  assert.equal(imports, 1);
});

test('failed speculative imports can be retried by navigation', async () => {
  let imports = 0;
  const loadRoute = createRouteLoader(async () => {
    imports += 1;
    if (imports === 1) throw new Error('offline');
    return 'loaded';
  });
  await assert.rejects(loadRoute(), /offline/);
  assert.equal(await loadRoute(), 'loaded');
  assert.equal(await loadRoute(), 'loaded');
  assert.equal(imports, 2);
});
