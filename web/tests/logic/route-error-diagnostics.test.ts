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
  clearReloadRecoveryState,
  consumeScrollSnapshot,
  consumeStandaloneRoute,
  isTransientSessionError,
  readAuthShellHint,
  RELOAD_SCROLL_STORAGE_KEY,
  saveScrollSnapshot,
  saveStandaloneRoute,
  STANDALONE_ROUTE_STORAGE_KEY,
  writeAuthShellHint,
} from '../../src/utils/reloadRecovery.ts';
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
    removeItem: (key: string) => {
      store.delete(key);
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

test('chunk recovery refuses hidden tabs and suppresses eager preload reloads during post-resume grace', () => {
  clearChunkReloadPending();
  const storage = memoryStorage();
  let clock = 100_000;
  let reloads = 0;

  assert.equal(
    attemptChunkReload({
      now: () => clock,
      storage,
      isOnline: () => true,
      isVisible: () => false,
      reload: () => {
        reloads += 1;
      },
    }),
    false,
  );
  assert.equal(reloads, 0);

  const winListeners = new Map<string, Set<EventListener>>();
  const docListeners = new Map<string, Set<EventListener>>();
  let visibilityState: DocumentVisibilityState = 'visible';
  const fakeWindow = {
    addEventListener: (type: string, listener: EventListener) => {
      const group = winListeners.get(type) ?? new Set<EventListener>();
      group.add(listener);
      winListeners.set(type, group);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      winListeners.get(type)?.delete(listener);
    },
  };
  const fakeDoc = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (type: string, listener: EventListener) => {
      const group = docListeners.get(type) ?? new Set<EventListener>();
      group.add(listener);
      docListeners.set(type, group);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      docListeners.get(type)?.delete(listener);
    },
  };

  const emitWin = (type: string, event: Event) => {
    for (const listener of winListeners.get(type) ?? []) listener(event);
  };
  const emitDoc = (type: string) => {
    for (const listener of docListeners.get(type) ?? []) listener(new Event(type));
  };
  const emitPreloadFailure = () => {
    const evt = new Event('vite:preloadError', { cancelable: true }) as Event & { payload?: unknown };
    evt.payload = new TypeError('Importing a module script failed.');
    emitWin('vite:preloadError', evt);
  };

  const dispose = installChunkLoadRecovery(fakeWindow as unknown as Window, {
    documentTarget: fakeDoc as unknown as Document,
    now: () => clock,
    storage,
    isOnline: () => true,
    resumeGraceMs: 5_000,
    reload: () => {
      reloads += 1;
    },
  });

  try {
    // Tab goes to background: aborted preloads must not reload.
    visibilityState = 'hidden';
    emitDoc('visibilitychange');
    emitPreloadFailure();
    assert.equal(reloads, 0);

    // Tab returns to foreground: transient failures within grace window do not trigger eager reload,
    // including direct RouteErrorPage automatic recovery calls via attemptChunkReload().
    clock += 10_000;
    visibilityState = 'visible';
    emitDoc('visibilitychange');
    clock += 1_000;
    emitPreloadFailure();
    assert.equal(reloads, 0);
    assert.equal(
      attemptChunkReload({
        now: () => clock,
        storage,
        isOnline: () => true,
        isVisible: () => true,
        reload: () => {
          reloads += 1;
        },
      }),
      false,
      'direct attemptChunkReload also honors the post-resume grace window',
    );
    assert.equal(reloads, 0);

    // Once settled past the grace window, a real foreground stale chunk triggers one guarded reload.
    clock += 5_000;
    emitPreloadFailure();
    assert.equal(reloads, 1);

    // If pageshow fires while the document is still hidden, keep hidden tracking until visibility
    // returns so the resume grace period still starts when the user actually focuses the tab.
    clock += 60_000;
    clearChunkReloadPending();
    visibilityState = 'hidden';
    emitDoc('visibilitychange');
    emitWin('pageshow', new Event('pageshow'));
    clock += 10_000;
    visibilityState = 'visible';
    emitDoc('visibilitychange');
    clock += 1_000;
    emitPreloadFailure();
    assert.equal(reloads, 1, 'visibility return after background pageshow still receives resume grace');

    clock += 5_000;
    emitPreloadFailure();
    assert.equal(reloads, 2, 'foreground preload failure after grace window reloads once');
  } finally {
    dispose();
    clearChunkReloadPending();
  }
});

test('reloadRecovery enforces transient-vs-401 classification and strict non-sensitive route/scroll allowlists', () => {
  assert.equal(isTransientSessionError(new TypeError('Failed to fetch')), true);
  assert.equal(isTransientSessionError({ status: 0 }), true);
  assert.equal(isTransientSessionError({ status: 502 }), true);
  assert.equal(isTransientSessionError({ status: 503 }), true);
  assert.equal(isTransientSessionError({ status: 408 }), true);
  assert.equal(isTransientSessionError({ status: 401 }), false);
  assert.equal(isTransientSessionError({ status: 403 }), false);
  assert.equal(isTransientSessionError({ status: 400 }), false);

  const session = memoryStorage();
  const local = memoryStorage();
  let clock = 500_000;

  assert.equal(readAuthShellHint(session), false);
  writeAuthShellHint(true, session);
  assert.equal(readAuthShellHint(session), true);

  // Scroll snapshot strips query/fragment at write time, persists only allowlisted routes, and consumes once within TTL.
  saveScrollSnapshot('/usage/events?key=secret#frag', 420.4, { storage: session, now: () => clock });
  const rawScroll = session.getItem(RELOAD_SCROLL_STORAGE_KEY);
  assert.ok(rawScroll !== null);
  assert.equal(JSON.parse(rawScroll).path, '/usage/events');
  assert.equal(rawScroll.includes('secret'), false);
  assert.equal(rawScroll.includes('frag'), false);
  assert.equal(consumeScrollSnapshot('/dashboard', { storage: session, now: () => clock }), null);
  saveScrollSnapshot('/usage/events', 420.4, { storage: session, now: () => clock });
  assert.equal(consumeScrollSnapshot('/usage/events', { storage: session, now: () => clock + 1_000 }), 420);
  assert.equal(consumeScrollSnapshot('/usage/events', { storage: session, now: () => clock + 1_000 }), null);

  // Sensitive/dynamic routes are rejected at write time (no backing storage entry) and expired snapshots are ignored.
  saveScrollSnapshot('/authorize/abc123', 300, { storage: session, now: () => clock });
  assert.equal(session.getItem(RELOAD_SCROLL_STORAGE_KEY), null);
  assert.equal(consumeScrollSnapshot('/authorize/abc123', { storage: session, now: () => clock }), null);
  saveScrollSnapshot('/dashboard', 250, { storage: session, now: () => clock });
  assert.equal(consumeScrollSnapshot('/dashboard', { storage: session, now: () => clock + 31 * 60_000 }), null);

  // Standalone route recovery ignores normal browser tabs, strips query/fragment, and rejects sensitive routes at write time.
  saveStandaloneRoute('/trends', { storage: local, now: () => clock, isStandalone: () => false });
  assert.equal(local.getItem(STANDALONE_ROUTE_STORAGE_KEY), null);
  assert.equal(consumeStandaloneRoute({ storage: local, now: () => clock, isStandalone: () => true }), null);
  saveStandaloneRoute('/authorize/secret-id', { storage: local, now: () => clock, isStandalone: () => true });
  assert.equal(local.getItem(STANDALONE_ROUTE_STORAGE_KEY), null);
  assert.equal(consumeStandaloneRoute({ storage: local, now: () => clock, isStandalone: () => true }), null);
  saveStandaloneRoute('/trends?provider=openai#secret', { storage: local, now: () => clock, isStandalone: () => true });
  const rawRoute = local.getItem(STANDALONE_ROUTE_STORAGE_KEY);
  assert.ok(rawRoute !== null);
  assert.equal(JSON.parse(rawRoute).path, '/trends');
  assert.equal(rawRoute.includes('openai'), false);
  assert.equal(rawRoute.includes('secret'), false);
  assert.equal(consumeStandaloneRoute({ storage: local, now: () => clock + 10_000, isStandalone: () => true }), '/trends');

  // Clearing recovery state wipes auth shell hint, scroll snapshot, and standalone route together.
  writeAuthShellHint(true, session);
  saveScrollSnapshot('/dashboard', 120, { storage: session, now: () => clock });
  saveStandaloneRoute('/pricing', { storage: local, now: () => clock, isStandalone: () => true });
  clearReloadRecoveryState(session, local);
  assert.equal(readAuthShellHint(session), false);
  assert.equal(consumeScrollSnapshot('/dashboard', { storage: session, now: () => clock }), null);
  assert.equal(consumeStandaloneRoute({ storage: local, now: () => clock, isStandalone: () => true }), null);
});
