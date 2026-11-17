import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  attemptChunkReload,
  clearChunkReloadPending,
  installChunkLoadRecovery,
  isChunkReloadPending,
  isModuleLoadFailure,
} from '../../src/utils/chunkRecovery.ts';
import {
  createRouteErrorDiagnostics,
  formatRouteErrorReport,
  redactDiagnosticText,
} from '../../src/utils/routeErrorDiagnostics.ts';

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

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

test('chunk recovery identifies Safari/Chrome/Firefox module script failures and reloads at most once per cooldown', () => {
  clearChunkReloadPending();
  assert.equal(isModuleLoadFailure(new TypeError('Importing a module script failed.')), true);
  assert.equal(isModuleLoadFailure(new TypeError('Failed to fetch dynamically imported module: https://omc.junze.dev/demo/assets/DashboardPage.js')), true);
  assert.equal(isModuleLoadFailure(new TypeError('error loading dynamically imported module: https://omc.junze.dev/demo/assets/DashboardPage.js')), true);
  assert.equal(isModuleLoadFailure(new Error('Unable to preload CSS for ./assets/index.css')), true);
  assert.equal(isModuleLoadFailure(new TypeError('Cannot read properties of undefined')), false);

  const storage = memoryStorage();
  let clock = 100_000;
  let reloads = 0;
  const options = {
    now: () => clock,
    storage,
    isOnline: () => true,
    reload: () => {
      reloads += 1;
    },
  };

  assert.equal(attemptChunkReload(options), true);
  assert.equal(reloads, 1);
  assert.equal(isChunkReloadPending(), true);

  // If the page stays loaded past the cooldown (e.g. reload cancelled by beforeunload), pending state expires.
  clock += 30_000;
  assert.equal(isChunkReloadPending(), false);
  assert.equal(attemptChunkReload(options), true);
  assert.equal(reloads, 2);
  clearChunkReloadPending();

  // Within cooldown after clearing pending state, a second failure refuses to loop.
  clock += 5_000;
  assert.equal(attemptChunkReload(options), false);
  assert.equal(reloads, 2);
  assert.equal(isChunkReloadPending(), false);

  // After cooldown expires, a later deployment can trigger recovery once more.
  clock += 30_000;
  assert.equal(attemptChunkReload(options), true);
  assert.equal(reloads, 3);
  clearChunkReloadPending();

  // Offline, throwing storage methods, or a throwing sessionStorage getter fail closed without reloading.
  assert.equal(attemptChunkReload({ ...options, now: () => clock + 60_000, isOnline: () => false }), false);
  assert.equal(
    attemptChunkReload({
      ...options,
      now: () => clock + 60_000,
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    }),
    false,
  );
  const originalWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get sessionStorage() {
        throw new DOMException('Access denied', 'SecurityError');
      },
    },
  });
  try {
    assert.equal(
      attemptChunkReload({
        now: () => clock + 60_000,
        isOnline: () => true,
        reload: () => {
          reloads += 1;
        },
      }),
      false,
    );
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  }
  assert.equal(reloads, 3);
});

test('installChunkLoadRecovery reloads on vite:preloadError only for module-load payloads without cancelling propagation', () => {
  clearChunkReloadPending();
  const listeners = new Map<string, Set<EventListener>>();
  const target = {
    addEventListener: (type: string, listener: EventListener) => {
      const group = listeners.get(type) ?? new Set<EventListener>();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  let reloads = 0;
  const dispose = installChunkLoadRecovery(target as unknown as Window, {
    now: () => 50_000,
    storage: memoryStorage(),
    isOnline: () => true,
    reload: () => {
      reloads += 1;
    },
  });

  const nonChunkEvent = new Event('vite:preloadError', { cancelable: true }) as Event & { payload?: unknown };
  nonChunkEvent.payload = new Error('bad configuration');
  for (const listener of listeners.get('vite:preloadError') ?? []) {
    listener(nonChunkEvent);
  }
  assert.equal(reloads, 0);
  assert.equal(nonChunkEvent.defaultPrevented, false);

  const chunkEvent = new Event('vite:preloadError', { cancelable: true }) as Event & { payload?: unknown };
  chunkEvent.payload = new TypeError('Importing a module script failed.');
  for (const listener of listeners.get('vite:preloadError') ?? []) {
    listener(chunkEvent);
  }
  assert.equal(reloads, 1);
  assert.equal(chunkEvent.defaultPrevented, false);

  dispose();
  clearChunkReloadPending();
});
