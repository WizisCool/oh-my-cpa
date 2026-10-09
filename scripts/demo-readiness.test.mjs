import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEMO_ROUTES, hasDemoContent, watchDemoReads } from './demo-readiness.mjs';

const BASE = 'http://demo.example.test';
function request(path, { isOk = true, method = 'GET', base = BASE } = {}) {
  return { url: () => base + path, method: () => method, response: async () => ({ ok: () => isOk }) };
}

test('each console page has explicit heading, reads and content readiness', () => {
  const source = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  const paths = [...source.matchAll(/path: '([^']+)', element: <\w+Page\s/g)].map((match) => `/${match[1]}`);
  assert.deepEqual(DEMO_ROUTES.map((route) => route.path).sort(), paths.sort());
  for (const route of DEMO_ROUTES) {
    assert.ok(route.heading && route.content);
    assert.ok(Array.isArray(route.reads));
  }
});

test('a finished body is required; headers, unrelated origins and writes cannot satisfy reads', async () => {
  const page = new EventEmitter();
  const watcher = watchDemoReads(page, BASE, ['/pricing']);
  let isReady = false;
  const completed = watcher.ready.then(() => { isReady = true; });
  page.emit('requestfinished', request('/api/auth/session'));
  page.emit('response', request('/api/v1/pricing'));
  page.emit('requestfinished', request('/api/v1/pricing', { base: 'http://other.example.test' }));
  page.emit('requestfinished', request('/api/v1/pricing', { method: 'POST' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isReady, false);
  page.emit('requestfinished', request('/api/v1/pricing'));
  await completed;
  assert.deepEqual(page.eventNames(), []);
});

test('failed or missing required reads fail closed and release listeners', async () => {
  for (const event of ['requestfinished', 'requestfailed', 'missing']) {
    const page = new EventEmitter();
    const watcher = watchDemoReads(page, BASE, ['/pricing'], 20);
    const rejected = assert.rejects(watcher.ready, /required read failed|missing completed reads/);
    page.emit('requestfinished', request('/api/auth/session'));
    if (event !== 'missing') page.emit(event, request('/api/v1/pricing', { isOk: false }));
    await rejected;
    assert.deepEqual(page.eventNames(), []);
  }
});

test('cancelling observation removes listeners and is safe more than once', () => {
  const page = new EventEmitter();
  const watcher = watchDemoReads(page, BASE, []);
  watcher.dispose();
  watcher.dispose();
  assert.deepEqual(page.eventNames(), []);
});

test('content readiness rejects a sidebar-only heading, loading shells and missing detail', () => {
  const route = { ...DEMO_ROUTES.find((candidate) => candidate.path === '/ai-providers'), detail: 'providers_list' };
  const visible = (textContent) => ({ textContent, getClientRects: () => [{}] });
  let headings = [];
  let loading = [];
  const content = visible('');
  const original = globalThis.document;
  globalThis.document = {
    querySelectorAll: (selector) => selector === 'h1.terminal-title' ? headings : loading,
    querySelector: () => content,
  };
  try {
    assert.equal(hasDemoContent(route), false);
    headings = [visible(route.heading)];
    assert.equal(hasDemoContent(route), false);
    content.textContent = 'providers_list';
    loading = [visible('Loading')];
    assert.equal(hasDemoContent(route), false);
    loading = [];
    assert.equal(hasDemoContent(route), true);
    content.getClientRects = () => [];
    assert.equal(hasDemoContent(route), false);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

test('Agent readiness requires its welcome identity and content, not sidebar chrome', () => {
  const route = DEMO_ROUTES.find(candidate => candidate.path === '/agent');
  const identitySelector = '[data-testid="agent-empty"] [aria-label="Oh My CPA"]';
  const welcomeSelector = '[data-testid="agent-empty"]';
  const visible = () => ({ textContent: '', getClientRects: () => [{}], getAttribute: name => name === 'aria-label' ? 'Oh My CPA' : null });
  let identities = [];
  let loading = [];
  let welcome;
  const original = globalThis.document;
  globalThis.document = {
    querySelectorAll: selector => selector === identitySelector ? identities : selector === 'h1.terminal-title' ? [] : loading,
    querySelector: selector => selector === welcomeSelector ? welcome : null,
  };
  try {
    assert.equal(hasDemoContent(route), false, 'a page shell alone is not content');
    identities = [visible()];
    assert.equal(hasDemoContent(route), false, 'the welcome content must exist');
    welcome = visible();
    assert.equal(hasDemoContent(route), true, 'the dedicated Agent welcome is ready without a page-title heading');
    loading = [visible()];
    assert.equal(hasDemoContent(route), false, 'a loading surface is never ready');
    loading = [];
    welcome.getClientRects = () => [];
    assert.equal(hasDemoContent(route), false, 'hidden welcome content is never ready');
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});


test('dashboard readiness waits for both activity and health sources', () => {
  const dashboard = DEMO_ROUTES.find(route => route.path === '/dashboard');
  assert.deepEqual(dashboard.reads, [
    '/management/dashboard',
    '/management/dashboard/models',
    '/management/dashboard/token-heatmap',
    '/management/overview',
    '/management/dashboard/providers',
  ]);
  assert.equal(dashboard.content, '.dashboard-activity-row .heatmap-grid');
});
