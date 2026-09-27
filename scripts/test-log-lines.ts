import assert from 'node:assert/strict';
import test from 'node:test';

import { isManagementLine } from '../web/src/types/logs.ts';

// "Hide management traffic" must hide this console's own polling on either CPA
// generation: a v8 gateway serves its reads on the grouped /v8/management routes.
test('management traffic is recognised on both API generations', () => {
  const line = (path: string) => `[2026-09-27 23:30:48] [00000000] [info ] [gin_logger.go:101] 200 |  1ms | 127.0.0.1 | GET "${path}"`;
  assert.equal(isManagementLine(line('/v0/management/logs?limit=2000')), true);
  assert.equal(isManagementLine(line('/v8/management/observability/logs?limit=2000')), true);
  assert.equal(isManagementLine(line('/v1/responses')), false);
});
