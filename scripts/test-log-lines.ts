import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countLogFacets,
  DEFAULT_LOG_FILTERS,
  isManagementLine,
  matchesLogFilters,
  MAX_LOG_PATH_FILTERS,
  parseLogFilters,
  parseLogLine,
  shouldExitLogFullscreen,
  type LogFilters,
} from '../web/src/types/logs.ts';

// "Hide management traffic" must hide this console's own polling on either CPA
// generation: a v8 gateway serves its reads on the grouped /v8/management routes.
test('management traffic is recognised on both API generations', () => {
  const line = (path: string) => `[2026-09-27 23:30:48] [00000000] [info ] [gin_logger.go:101] 200 |  1ms | 127.0.0.1 | GET "${path}"`;
  assert.equal(isManagementLine(line('/v0/management/logs?limit=2000')), true);
  assert.equal(isManagementLine(line('/v8/management/observability/logs?limit=2000')), true);
  assert.equal(isManagementLine(line('/v1/responses')), false);
});

const requestLine = (method: string, path: string, status = 200) =>
  parseLogLine(`[2026-09-27 23:30:48] [00000000] [info ] [gin_logger.go:101] ${status} |  1ms | 127.0.0.1 | ${method} "${path}"`);
const startupLine = parseLogLine('[2026-09-27 23:30:00] [--------] [info ] [main.go:10] server started');
const withFilters = (overrides: Partial<LogFilters>): LogFilters => ({ ...DEFAULT_LOG_FILTERS, ...overrides });

test('a method or path filter keeps only the requests it names', () => {
  const post = requestLine('POST', '/v1/responses?stream=true');
  assert.equal(matchesLogFilters(post, withFilters({ methods: ['POST'] })), true);
  assert.equal(matchesLogFilters(post, withFilters({ methods: ['GET'] })), false);
  // The path is compared without its query string.
  assert.equal(matchesLogFilters(post, withFilters({ paths: ['/v1/responses'] })), true);
  assert.equal(matchesLogFilters(post, withFilters({ paths: ['/v1/models'] })), false);
  // A line that is not a request has neither, so either filter drops it.
  assert.equal(matchesLogFilters(startupLine, withFilters({})), true);
  assert.equal(matchesLogFilters(startupLine, withFilters({ methods: ['POST'] })), false);
  assert.equal(matchesLogFilters(startupLine, withFilters({ paths: ['/v1/responses'] })), false);
});

test('a facet is counted without its own filter and with every other one', () => {
  const lines = [
    requestLine('POST', '/v1/responses'),
    requestLine('POST', '/v1/responses?stream=true', 500),
    requestLine('GET', '/v1/models'),
    requestLine('GET', '/v8/management/config'),
    startupLine,
  ];
  const facets = countLogFacets(lines, withFilters({ methods: ['GET'] }));
  // Management traffic is hidden by default, so its GET is not counted.
  assert.deepEqual(facets.methods, { POST: 2, GET: 1 });
  assert.deepEqual(facets.paths, [{ path: '/v1/models', count: 1 }]);

  const narrowed = countLogFacets(lines, withFilters({ paths: ['/v1/responses'], statusClass: 'server' }));
  assert.deepEqual(narrowed.methods, { POST: 1 });
  assert.deepEqual(narrowed.paths, [{ path: '/v1/responses', count: 1 }]);
});

test('a selected path stays offered when the buffer no longer carries it', () => {
  const facets = countLogFacets([requestLine('GET', '/v1/models')], withFilters({ paths: ['/v1/gone'] }));
  assert.deepEqual(facets.paths, [{ path: '/v1/models', count: 1 }, { path: '/v1/gone', count: 0 }]);
});

test('stored filters are validated and never keep a query string', () => {
  const parsed = parseLogFilters({
    methods: ['POST', 'TRACE', 7, 'GET'],
    paths: ['/v1/models?key=sk-secret', '/v1/models', '', 42, ...Array.from({ length: 40 }, (_unused, position) => `/p/${position}`)],
    wrapLines: 'yes',
  });
  assert.deepEqual(parsed?.methods, ['GET', 'POST']);
  assert.equal(parsed?.paths[0], '/v1/models');
  assert.equal(parsed?.paths.length, MAX_LOG_PATH_FILTERS);
  assert.equal(parsed?.paths.some((path) => path.includes('?')), false);
  assert.equal(parsed?.wrapLines, false);
  // A preference written before these fields existed reads as "no request filter".
  assert.deepEqual(parseLogFilters({ hideManagement: false }), { ...DEFAULT_LOG_FILTERS, hideManagement: false });
});

test('Escape leaves fullscreen only when nothing inside it claims the key', () => {
  assert.equal(shouldExitLogFullscreen('Escape', false, false), true);
  assert.equal(shouldExitLogFullscreen('Escape', false, true), false);
  assert.equal(shouldExitLogFullscreen('Escape', true, false), false);
  assert.equal(shouldExitLogFullscreen('Enter', false, false), false);
});
