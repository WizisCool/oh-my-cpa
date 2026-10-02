import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRouteErrorDiagnostics,
  formatRouteErrorReport,
  redactDiagnosticText,
} from '../web/src/utils/routeErrorDiagnostics.ts';

const CONTEXT = {
  routePath: '/console/config?token=private-query#private-hash',
  version: 'v1.2.3',
  occurredAt: '2026-10-02T12:00:00.000Z',
};

test('diagnostics preserve useful error identity, stack, deployment path and build context', () => {
  const error = new TypeError('Cannot read properties of undefined (reading model)');
  error.stack = 'TypeError: Cannot read properties of undefined\n    at renderConfig (https://localhost/console/assets/config.js?secret=private-query#private-hash:4:2)';
  const diagnostics = createRouteErrorDiagnostics(error, CONTEXT);
  assert.equal(diagnostics.errorType, 'TypeError');
  assert.equal(diagnostics.message, error.message);
  assert.ok(diagnostics.stack.includes('renderConfig'));
  assert.ok(diagnostics.stack.includes('/console/assets/config.js:4:2)'));
  assert.ok(!diagnostics.stack.includes('?'));
  assert.equal(diagnostics.routePath, '/console/config');
  assert.equal(diagnostics.version, 'v1.2.3');
  assert.equal(diagnostics.occurredAt, CONTEXT.occurredAt);
  assert.ok(!diagnostics.stack.includes('private-query'));
  assert.ok(!diagnostics.stack.includes('private-hash'));
  const report = formatRouteErrorReport(diagnostics);
  assert.ok(report.includes('TypeError'));
  assert.ok(report.includes(error.message));
  assert.ok(report.includes('renderConfig'));
  assert.ok(report.includes('Build: v1.2.3'));
  assert.ok(report.includes('Route: /console/config'));
});

test('credential forms are removed from both visible and copied diagnostics', () => {
  const secrets = [
    'bare-management-key',
    'sk-proj-private123456',
    'ghp_private123456',
    'glpat-private123456',
    'github_pat_private123456',
    'xoxb-private123456',
    'ya29.private123456',
    'AIzaPrivate123456789012345678',
    'eyJprivate123.eyJprivate123.private123',
    'bearer-private123456',
    'cookie-private123456',
    'proxy-private123456',
    'url-password',
    'url-query',
    'url-hash',
  ];
  const message = [
    'management_key="bare-management-key"', ...secrets.slice(1, 9),
    'Authorization: Bearer bearer-private123456',
    'Cookie: session=cookie-private123456',
    'proxy-authorization: Basic proxy-private123456',
    'https://operator:url-password@example.com/console/config?token=url-query#url-hash',
  ].join('\n');
  const diagnostics = createRouteErrorDiagnostics({ name: 'Error', message, stack: message }, CONTEXT);
  for (const secret of secrets) {
    assert.ok(!diagnostics.message.includes(secret), `message leaked ${secret}`);
    assert.ok(!diagnostics.stack.includes(secret), `stack leaked ${secret}`);
    assert.ok(!formatRouteErrorReport(diagnostics).includes(secret), `report leaked ${secret}`);
  }
  assert.ok(diagnostics.message.includes('https://example.com/console/config'));
  assert.ok(diagnostics.message.includes('[REDACTED]'));
});

test('bracketed relative paths keep their code location but remove query and fragment values', () => {
  const paths = ['./[id]', '../[provider]/[id].js', '/omc/assets/[chunk].js'];
  const suffixes = ['?credential=fixture-query#fixture-fragment', '?credential=fixture-query', '#fixture-fragment'];
  for (const path of paths) {
    for (const suffix of suffixes) {
      const message = `Loading ${path}${suffix}`;
      const stack = `Error: ${message}\n    at renderConfig (${path}${suffix})`;
      const diagnostics = createRouteErrorDiagnostics({ name: 'Error', message, stack }, CONTEXT);
      assert.equal(diagnostics.message, `Loading ${path}`);
      assert.equal(diagnostics.stack, `Error: Loading ${path}\n    at renderConfig (${path})`);
      const report = formatRouteErrorReport(diagnostics);
      assert.ok(report.includes(path));
      assert.ok(!report.includes('fixture-query'));
      assert.ok(!report.includes('fixture-fragment'));
    }
  }
});

test('route error responses retain HTTP context but never stringify arbitrary response objects', () => {
  const diagnostics = createRouteErrorDiagnostics({ status: 503, statusText: 'Service Unavailable', internal: false, data: { message: 'Service unavailable', secret: 'private-body' } }, CONTEXT);
  assert.equal(diagnostics.status, 503);
  assert.equal(diagnostics.errorType, 'HTTP 503 Service Unavailable');
  assert.equal(diagnostics.message, 'Service unavailable');
  assert.ok(!formatRouteErrorReport(diagnostics).includes('private-body'));
  const text = createRouteErrorDiagnostics({ status: 500, statusText: 'Server Error', internal: false, data: 'Upstream failed api_key=private-key' }, CONTEXT);
  assert.equal(text.message, 'Upstream failed api_key=[REDACTED]');
  assert.ok(formatRouteErrorReport(text).includes('HTTP: 500'));
});

test('unknown, cyclic and hostile thrown values cannot crash diagnostic extraction', () => {
  const circular: Record<string, unknown> = { data: 'private-object' };
  circular.self = circular;
  const hostile = new Proxy({}, { get() { throw new Error('getter failed'); } });
  for (const error of [null, undefined, 42, false, Symbol('private-symbol'), circular, hostile]) {
    const diagnostics = createRouteErrorDiagnostics(error, CONTEXT);
    assert.equal(diagnostics.errorType, '');
    assert.equal(diagnostics.message, '');
    assert.equal(diagnostics.stack, '');
    assert.ok(!formatRouteErrorReport(diagnostics).includes('private-object'));
  }
  assert.equal(createRouteErrorDiagnostics('A thrown string', CONTEXT).message, 'A thrown string');
});

test('large messages are bounded after redaction and control bytes are removed', () => {
  const message = `${'x'.repeat(11_990)} api_key=${'private-key'.repeat(10_000)}`;
  const sanitized = redactDiagnosticText(message);
  assert.ok(sanitized.length <= 12_000);
  assert.ok(!sanitized.includes('private-key'));
  assert.equal(redactDiagnosticText('Error\u0000\n  at render\u0007'), 'Error\n  at render');
  assert.equal(redactDiagnosticText('at /console/assets/page.js?key=private-key#secret\n at ./page.js?query=hidden'), 'at /console/assets/page.js\n at ./page.js');
});
